import type { RoutingDispatchRuntime } from "./routing-dispatch.ts";
import { gateRoutingNotification, resolveRoutingPolicy } from "./routing-policy.ts";

/** Trusted host wiring; neither mail nor classification selects a transport. */
export function routingRuntime(env: Env): RoutingDispatchRuntime {
  return {
    resolveFallback: (source) => resolveRoutingPolicy(env, source),
    gateNotification: (source, resolution) => gateRoutingNotification(env, source, resolution),
  };
}
