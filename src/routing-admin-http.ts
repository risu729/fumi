import * as v from "valibot";
import { hasScope, type MailPrincipal } from "./principal.ts";
import { handleRoutingPolicy } from "./routing-policy-http.ts";
import { routingRuntime } from "./routing-runtime.ts";
import {
  activateRoutingDispatch,
  drainRoutingDispatch,
  routingDispatchStatus,
  reconcileRoutingDispatch,
  recordRoutingDispatchReceipt,
  dispatchRoutingSource,
} from "./routing-dispatch.ts";
import { readDispatchBytes } from "./plugin-offer.ts";

const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const receiptSchema = v.strictObject({
  schemaVersion: v.literal(1),
  operationId: digest,
  requestSha256: digest,
  result: v.picklist(["handled", "not_applicable", "rejected", "not_found", "retryable_error"]),
});
const error = (code: string, status: number) => Response.json({ error: { code } }, { status });

/** Only mounted after the parent's same-origin and Access JWT verification. */
export async function handleRoutingAdmin(
  request: Request,
  env: Env,
  principal: MailPrincipal,
): Promise<Response> {
  if (!hasScope(principal, "mail:routing")) return error("forbidden", 403);
  const url = new URL(request.url);
  if (url.search) return error("invalid_request", 400);
  if (
    url.pathname.startsWith("/api/admin/routing/context/") ||
    url.pathname.startsWith("/api/admin/routing/policy/")
  )
    return handleRoutingPolicy(request, env.MAIL_CATALOG, principal);
  const action = url.pathname.slice("/api/admin/routing/".length);
  if (action === "status") {
    if (request.method !== "GET") return error("method_not_allowed", 405);
    return Response.json(await routingDispatchStatus(env.MAIL_CATALOG));
  }
  const retry = /^retry\/(mail_[a-zA-Z0-9-]{1,128})$/.exec(action);
  if (!["activate", "drain", "reconcile", "receipt"].includes(action) && !retry)
    return error("not_found", 404);
  if (request.method !== "POST") return error("method_not_allowed", 405);
  let body: string;
  try {
    body = request.body
      ? await readDispatchBytes(request.body, action === "receipt" ? 2048 : 0, 1000)
      : "";
  } catch {
    return error("invalid_request", 400);
  }
  if (action === "receipt") {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
      return error("invalid_request", 400);
    let receipt;
    try {
      receipt = v.parse(receiptSchema, JSON.parse(body) as unknown);
    } catch {
      return error("invalid_request", 400);
    }
    try {
      await recordRoutingDispatchReceipt(env.MAIL_CATALOG, receipt);
    } catch {
      return error("receipt_conflict", 409);
    }
    return Response.json({ recorded: true });
  }
  if (body.length) return error("invalid_request", 400);
  if (action === "drain") {
    await drainRoutingDispatch(env.MAIL_CATALOG);
    return Response.json({ status: "draining" });
  }
  if (action === "activate")
    return Response.json({ status: await activateRoutingDispatch(env, routingRuntime(env)) });
  if (action === "reconcile")
    return Response.json(await reconcileRoutingDispatch(env, routingRuntime(env)));
  const source = await env.MAIL_CATALOG.prepare(
    "SELECT raw_key FROM archive_sources WHERE external_id=?",
  )
    .bind(retry![1]!.slice(5))
    .first<{ raw_key: string }>();
  if (!source) return error("not_found", 404);
  return Response.json(await dispatchRoutingSource(env, source.raw_key, routingRuntime(env)));
}
