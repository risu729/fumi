import { createAllowlistedWebhookHttp, type EventRuntime } from "./event-delivery.ts";
import { resolveGrant } from "./auth.ts";
import { eventScope } from "./event-store.ts";

/** Unset or "[]" trusts no origin. Any other value that is not a JSON array of at
 * most ten exact HTTPS origins is invalid: then no origin is trusted either, not
 * even the valid entries, and only callback verification and delivery fail. */
function webhookRuntime(value: string | undefined): Pick<EventRuntime, "http" | "unavailable"> {
  try {
    const configured: unknown = JSON.parse(value || "[]");
    if (
      Array.isArray(configured) &&
      configured.length <= 10 &&
      configured.every((origin): origin is string => typeof origin === "string")
    )
      return { http: createAllowlistedWebhookHttp(configured) };
  } catch {
    /* Reported below without the configured value. */
  }
  console.error(JSON.stringify({ event: "webhook_origins", status: "invalid" }));
  return {
    http: { post: () => Promise.reject(new Error("webhook_origins_invalid")) },
    unavailable: "webhook_origins_invalid",
  };
}

export function eventRuntime(
  env: Pick<Env, "MAIL_GRANTS" | "WEBHOOK_ORIGINS" | "MAIL_CATALOG">,
): EventRuntime {
  return {
    ...webhookRuntime(env.WEBHOOK_ORIGINS),
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
