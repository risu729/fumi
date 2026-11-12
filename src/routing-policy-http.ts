import { hasScope, type MailPrincipal } from "./principal.ts";
import { recordRoutingContext } from "./routing-policy.ts";

/** The parent HTTP handler must first enforce the existing origin and JWT boundary. */
export async function handleRoutingPolicy(
  request: Request,
  db: D1Database,
  principal: MailPrincipal,
): Promise<Response> {
  const error = (code: string, status: number) => Response.json({ error: { code } }, { status });
  if (!hasScope(principal, "mail:routing")) return error("forbidden", 403);
  const url = new URL(request.url);
  if (url.search) return error("invalid_request", 400);
  if (url.pathname === "/api/admin/routing/policy/status") {
    if (request.method !== "GET" || request.body) return error("method_not_allowed", 405);
    const rows = await db
      .prepare(
        `SELECT state,failure_code,COUNT(*) AS count FROM routing_classifications GROUP BY state,failure_code`,
      )
      .all();
    const budget = await db
      .prepare("SELECT calls FROM routing_model_budget WHERE utc_day=?")
      .bind(new Date().toISOString().slice(0, 10))
      .first<{ calls: number }>();
    return Response.json({ classifications: rows.results, modelCallsToday: budget?.calls ?? 0 });
  }
  const match = /^\/api\/admin\/routing\/context\/(mail_[a-zA-Z0-9-]{1,128})$/.exec(url.pathname);
  if (!match) return error("not_found", 404);
  if (!["GET", "PUT"].includes(request.method)) return error("method_not_allowed", 405);
  const source = await db
    .prepare("SELECT raw_key FROM archive_sources WHERE external_id=?")
    .bind(match[1]!.slice(5))
    .first<{ raw_key: string }>();
  if (!source) return error("not_found", 404);
  if (request.method === "GET") {
    const context = await db
      .prepare(`SELECT source_sha256 AS sourceSha256,revision,trusted_thread_key AS trustedThreadKey,
      acknowledgement,case_state AS caseState,requires_mail_action AS requiresMailAction,
      already_notified AS alreadyNotified,updated_at AS updatedAt FROM routing_context WHERE raw_key=?`)
      .bind(source.raw_key)
      .first();
    return Response.json({ context });
  }
  if (
    !request.body ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json"
  )
    return error("invalid_request", 400);
  const reader = request.body.getReader();
  const buffer = new Uint8Array(4096);
  let offset = 0;
  let emptyChunks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Body timed out")), 5000);
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- The request has a fixed byte bound and whole-body deadline.
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (!chunk.value.byteLength) {
        if (++emptyChunks > 8) return error("invalid_request", 400);
        continue;
      }
      emptyChunks = 0;
      if (chunk.value.byteLength > buffer.length - offset) return error("invalid_request", 400);
      buffer.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    const input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        buffer.subarray(0, offset),
      ),
    ) as unknown;
    const written = await recordRoutingContext(db, source.raw_key, input);
    return written ? Response.json({ updated: true }) : error("context_conflict", 409);
  } catch {
    return error("invalid_request", 400);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}
