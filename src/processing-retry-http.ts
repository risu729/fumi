import * as v from "valibot";
import { apiOrigin } from "./auth.ts";
import { archiveCandidate } from "./archive-key.ts";
import { hasScope, type MailPrincipal } from "./principal.ts";
import { readDispatchBytes } from "./plugin-offer.ts";
import { retryFailedProcessing } from "./processing-jobs.ts";

export interface ProcessingRetryEnvironment {
  API_ORIGIN: string;
  MAIL_CATALOG: D1Database;
  MAIL_PROCESSING: Parameters<typeof retryFailedProcessing>[1];
}
const retrySchema = v.strictObject({
  expectedAttempt: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER - 1),
  ),
});
const route =
  /^\/api\/admin\/archive\/retry\/mail_([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const error = (code: string, status: number) => Response.json({ error: { code } }, { status });

/** The parent authenticates Access JWTs before mounting this exact-source control. */
export async function handleProcessingRetry(
  request: Request,
  env: ProcessingRetryEnvironment,
  principal: MailPrincipal,
): Promise<Response> {
  if (!hasScope(principal, "mail:import")) return error("forbidden", 403);
  const url = new URL(request.url);
  const match = route.exec(url.pathname);
  if (!match) return error("not_found", 404);
  if (url.origin !== apiOrigin(env) || request.headers.get("origin") !== url.origin)
    return error("origin_not_allowed", 403);
  if (request.method !== "POST") return error("method_not_allowed", 405);
  const length = request.headers.get("content-length");
  if (
    url.search ||
    request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" ||
    (request.headers.has("content-encoding") &&
      request.headers.get("content-encoding") !== "identity") ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > 128))
  )
    return error("invalid_request", 400);
  let expectedAttempt: number;
  try {
    const input = v.parse(
      retrySchema,
      JSON.parse(await readDispatchBytes(request.body, 128, 1000)) as unknown,
    );
    expectedAttempt = input.expectedAttempt;
  } catch {
    return error("invalid_request", 400);
  }
  try {
    // External IDs are scoped by source kind/namespace in the catalog. Do not
    // select an arbitrary source if corrupt or conflicting identities exist.
    const sources = await env.MAIL_CATALOG.withSession("first-primary")
      .prepare("SELECT raw_key,raw_state FROM archive_sources WHERE external_id=? LIMIT 2")
      .bind(match[1]!)
      .all<{ raw_key: string; raw_state: string }>();
    if (!sources.results.length) return error("not_found", 404);
    if (sources.results.length !== 1) return error("retry_conflict", 409);
    const source = sources.results[0]!;
    const candidate = archiveCandidate(source.raw_key);
    if (
      !candidate ||
      candidate.ingestId !== match[1] ||
      source.raw_key !== `${candidate.prefix}/raw.eml` ||
      source.raw_state !== "present"
    )
      return error("retry_conflict", 409);
    const accepted = await retryFailedProcessing(
      env.MAIL_CATALOG,
      env.MAIL_PROCESSING,
      source.raw_key,
      expectedAttempt,
    );
    return accepted
      ? Response.json({ status: "accepted", attempt: expectedAttempt + 1 }, { status: 202 })
      : error("retry_conflict", 409);
  } catch {
    // A lost response can follow a committed retry. The same expected attempt
    // cannot advance again; inspect status before choosing a different attempt.
    return error("processing_retry_unavailable", 503);
  }
}
