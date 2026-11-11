import { cursorFor, type EventName, type StoredEvent, type Subscription } from "./event-store.ts";

/** An adapter must validate addresses at connection time and refuse redirects, or
 * use createAllowlistedWebhookHttp with administrator-controlled trusted origins. */
export interface WebhookHttp {
  post(url: string, body: string, headers: Headers): Promise<Response>;
}
export interface EventRuntime {
  http: WebhookHttp;
  authorize(principalId: string, name: EventName, args: Record<string, string>): Promise<boolean>;
  now?: () => number;
}
export function validateCallback(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid callback URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    value.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|onion|home|lan)$/.test(hostname)
  ) {
    throw new Error("Invalid callback URL");
  }
  return url;
}
/** Workers fetch cannot pin a DNS answer while retaining TLS SNI. Consequently this
 * adapter deliberately supports ONLY admin-provisioned exact origins whose DNS is
 * trusted by the operator. Never populate this allowlist from subscription input.
 * Recheck on every POST; no arbitrary user host, redirects, or user fetch options. */
export function createAllowlistedWebhookHttp(
  origins: readonly string[],
  send: typeof fetch = fetch,
): WebhookHttp {
  const trusted = new Set(
    origins.map((value) => {
      const url = validateCallback(value);
      if (url.href !== `${url.origin}/`)
        throw new Error("Callback allowlist requires exact origins");
      return url.origin;
    }),
  );
  return {
    async post(value, body, headers) {
      const url = validateCallback(value);
      if (!trusted.has(url.origin)) throw new Error("Callback origin is not trusted");
      return send(url.href, {
        method: "POST",
        body,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    },
  };
}
export function decodeSigningSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error("Invalid signing secret");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Invalid signing secret");
  }
  if (
    bytes.length < 24 ||
    bytes.length > 64 ||
    btoa(String.fromCharCode(...bytes)) !== secret.slice(6)
  )
    throw new Error("Invalid signing secret");
  return bytes;
}
export async function signedHeaders(
  secret: string,
  id: string,
  body: string,
  subscriptionId: string,
  now: number,
): Promise<Headers> {
  const timestamp = String(Math.floor(now / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    decodeSigningSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return new Headers({
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${btoa(String.fromCharCode(...signature))}`,
    "X-MCP-Subscription-Id": subscriptionId,
  });
}
export function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
export async function verifyCallback(
  http: WebhookHttp,
  url: string,
  secret: string,
  id: string,
  now: number,
): Promise<void> {
  validateCallback(url);
  const challenge = crypto.randomUUID();
  const body = JSON.stringify({ type: "verification", challenge });
  const response = await http.post(
    url,
    body,
    await signedHeaders(secret, `verification_${crypto.randomUUID()}`, body, id, now),
  );
  if (!response.ok) throw new Error("Callback challenge failed");
  // Read at most 1 KiB, including chunked responses with no Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Callback challenge failed");
  let text = "";
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Bound streamed callback response bytes.
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024) throw new Error("Callback challenge failed");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result: unknown = JSON.parse(text);
  if (
    !result ||
    typeof result !== "object" ||
    !("challenge" in result) ||
    typeof result.challenge !== "string" ||
    !constantTimeEqual(result.challenge, challenge)
  )
    throw new Error("Callback challenge failed");
}

/** Bounded, ordered head-of-line delivery: a failed matching event never advances
 * the cursor. Leases fence concurrent cron invocations; expiry/revocation stops
 * future dispatch. A crash after receipt yields the same event ID on the retry. */
export async function deliverEvents(
  database: D1Database,
  runtime: EventRuntime,
  limit = 25,
): Promise<{ attempted: number }> {
  const now = runtime.now?.() ?? Date.now();
  const db = database.withSession("first-primary");
  const subscriptions = await db
    .prepare(
      `SELECT * FROM event_subscriptions WHERE state='active' AND expires_at>? AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,id LIMIT ?`,
    )
    .bind(now, now, now, Math.max(1, Math.min(limit, 100)))
    .all<Subscription>();
  let attempted = 0;
  for (const subscription of subscriptions.results) {
    // oxlint-disable-next-line no-await-in-loop -- Each subscription is bounded and leases are acquired before network I/O.
    attempted += await deliverOne(db, runtime, subscription, now);
  }
  return { attempted };
}
async function deliverOne(
  db: D1DatabaseSession,
  runtime: EventRuntime,
  subscription: Subscription,
  now: number,
): Promise<number> {
  const token = crypto.randomUUID();
  const lease = await db
    .prepare(
      `UPDATE event_subscriptions SET lease_token=?,lease_until=? WHERE id=? AND revision=? AND state='active' AND expires_at>? AND lease_until<=?`,
    )
    .bind(token, now + 60_000, subscription.id, subscription.revision, now, now)
    .run();
  if (lease.meta.changes !== 1) return 0;
  const guard = `id=? AND revision=? AND lease_token=?`;
  const identity = [subscription.id, subscription.revision, token];
  const stop = (reason: string) =>
    db
      .prepare(
        `UPDATE event_subscriptions SET state='stopped',signing_secret='',previous_signing_secret=NULL,previous_secret_until=0,stop_reason=?,lease_until=0,lease_token=NULL WHERE ${guard}`,
      )
      .bind(reason, ...identity)
      .run();
  let authorized = false;
  try {
    authorized = await runtime.authorize(
      subscription.principal_id,
      subscription.name,
      JSON.parse(subscription.arguments_json) as Record<string, string>,
    );
  } catch {
    /* Authorization service failure fails closed, without revoking a grant. */
  }
  if (!authorized) {
    await stop("authorization_unavailable_or_revoked");
    return 0;
  }
  const event = await db
    .prepare(
      `SELECT sequence,event_id,name,data_json,occurred_at FROM mail_events WHERE sequence>? AND name=? AND (principal_id IS NULL OR principal_id=?) AND (? IS NULL OR json_extract(data_json,'$.ingestId')=? OR json_extract(data_json,'$.operationId')=?) ORDER BY sequence LIMIT 1`,
    )
    .bind(
      subscription.cursor,
      subscription.name,
      subscription.principal_id,
      Object.values(JSON.parse(subscription.arguments_json) as Record<string, string>)[0] ?? null,
      Object.values(JSON.parse(subscription.arguments_json) as Record<string, string>)[0] ?? null,
      Object.values(JSON.parse(subscription.arguments_json) as Record<string, string>)[0] ?? null,
    )
    .first<StoredEvent>();
  if (!event) {
    await db
      .prepare(
        `UPDATE event_subscriptions SET lease_until=0,lease_token=NULL,next_attempt_at=? WHERE ${guard}`,
      )
      .bind(now + 10_000, ...identity)
      .run();
    return 0;
  }
  const body = JSON.stringify({
    eventId: event.event_id,
    name: event.name,
    timestamp: event.occurred_at,
    data: JSON.parse(event.data_json) as unknown,
    cursor: cursorFor(subscription.id, event.sequence),
  });
  let status = 0;
  try {
    // Recheck the subscription after asynchronous authorization, immediately before POST.
    const active = await db
      .prepare(
        `SELECT id FROM event_subscriptions WHERE ${guard} AND state='active' AND expires_at>?`,
      )
      .bind(...identity, runtime.now?.() ?? Date.now())
      .first();
    if (!active) return 0;
    if (new TextEncoder().encode(body).length > 262_144) status = 413;
    else {
      const signedAt = runtime.now?.() ?? Date.now();
      const headers = await signedHeaders(
        subscription.signing_secret,
        event.event_id,
        body,
        subscription.id,
        signedAt,
      );
      if (subscription.previous_signing_secret && subscription.previous_secret_until > signedAt) {
        const previous = await signedHeaders(
          subscription.previous_signing_secret,
          event.event_id,
          body,
          subscription.id,
          signedAt,
        );
        headers.set(
          "webhook-signature",
          `${headers.get("webhook-signature")} ${previous.get("webhook-signature")}`,
        );
      }
      const response = await runtime.http.post(subscription.callback_url, body, headers);
      status = response.status;
      await response.body?.cancel();
    }
  } catch {
    /* Retry using only fixed status codes; never log callback URLs or secrets. */
  }
  if (status >= 200 && status < 300) {
    await db
      .prepare(
        `UPDATE event_subscriptions SET cursor=?,attempts=0,next_attempt_at=?,lease_until=0,lease_token=NULL WHERE ${guard} AND state='active'`,
      )
      .bind(event.sequence, now, ...identity)
      .run();
  } else if (status === 410 || status === 413 || subscription.attempts >= 7) {
    await stop(status === 410 ? "gone" : status === 413 ? "payload_too_large" : "retry_exhausted");
  } else {
    await db
      .prepare(
        `UPDATE event_subscriptions SET attempts=attempts+1,next_attempt_at=?,lease_until=0,lease_token=NULL WHERE ${guard}`,
      )
      .bind(now + Math.min(3_600_000, 1000 * 2 ** subscription.attempts), ...identity)
      .run();
  }
  return 1;
}
