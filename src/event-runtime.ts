import { createAllowlistedWebhookHttp, type EventRuntime } from "./event-delivery.ts";
import { resolveGrant } from "./auth.ts";
import { eventScope } from "./event-store.ts";

export function eventRuntime(
  env: Pick<Env, "MAIL_GRANTS" | "WEBHOOK_ORIGINS" | "MAIL_CATALOG">,
): EventRuntime {
  let origins: string[] = [];
  try {
    const configured: unknown = JSON.parse(env.WEBHOOK_ORIGINS || "[]");
    if (
      Array.isArray(configured) &&
      configured.length <= 10 &&
      configured.every((origin): origin is string => typeof origin === "string")
    )
      origins = configured;
  } catch {
    /* Missing configuration denies callback delivery. */
  }
  return {
    http: createAllowlistedWebhookHttp(origins),
    async authorize(id, name, args) {
      const principal = resolveGrant(env.MAIL_GRANTS, id);
      if (
        !principal?.scopes.includes("mail:events") ||
        !principal.scopes.includes(eventScope(name))
      )
        return false;
      if (args["operationId"]) {
        const found = await env.MAIL_CATALOG.withSession("first-primary")
          .prepare("SELECT 1 FROM outbound_operations WHERE operation_id=? AND principal_id=?")
          .bind(args["operationId"], id)
          .first();
        return found !== null;
      }
      // mail:read grants this single-owner archive, including inbound event IDs.
      return true;
    },
  };
}
