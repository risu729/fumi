/**
 * The Cloudflare zone that holds the Worker's custom domain. `cloudflare.config.ts`
 * serves the Worker on `workerDomain`, and the link policy refuses this zone and
 * every name under it, because a Worker's fetch to its own zone can reach the
 * origin directly and skip the zone's Access and WAF rules.
 */
export const workerZone = "takuk.me";

/** The Worker's custom domain, the only entry of `domains` in `cloudflare.config.ts`. */
export const workerDomain = `fumi.${workerZone}`;
