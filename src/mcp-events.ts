import * as v from "valibot";
import {
  EVENT_NAMES,
  DELIVERY_STATES,
  SEND_STATES,
  cursorFor,
  eventScope,
  type EventName,
  type Subscription,
} from "./event-store.ts";
import {
  decodeSigningSecret,
  validateCallback,
  verifyCallback,
  type EventRuntime,
} from "./event-delivery.ts";
import type { MailPrincipal } from "./principal.ts";

const idSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/));
const argsSchema = v.union([
  v.strictObject({}),
  v.strictObject({ ingestId: idSchema }),
  v.strictObject({ operationId: idSchema }),
]);
export const eventRequestSchemas = {
  "events/list": v.strictObject({ cursor: v.optional(v.string()) }),
  "events/subscribe": v.strictObject({
    name: v.picklist(EVENT_NAMES),
    arguments: v.optional(argsSchema, {}),
    delivery: v.strictObject({
      mode: v.literal("webhook"),
      url: v.pipe(v.string(), v.maxLength(2048)),
      secret: v.pipe(v.string(), v.maxLength(100)),
    }),
    cursor: v.optional(v.nullable(v.string())),
    ttlMs: v.optional(
      v.nullable(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
      ),
    ),
  }),
  "events/unsubscribe": v.union([
    v.strictObject({
      name: v.picklist(EVENT_NAMES),
      arguments: v.optional(argsSchema, {}),
      delivery: v.strictObject({
        mode: v.literal("webhook"),
        url: v.pipe(v.string(), v.maxLength(2048)),
      }),
    }),
    v.strictObject({ id: v.pipe(v.string(), v.regex(/^sub_[a-f0-9]{64}$/)) }),
  ]),
};
export class EventProtocolError extends Error {
  readonly code: number;
  readonly data: Record<string, string> | undefined;
  constructor(code: number, message: string, data?: Record<string, string>) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
function invalid(): never {
  throw new EventProtocolError(-32602, "Invalid event request");
}
function authorized(principal: MailPrincipal, name: EventName): boolean {
  return principal.scopes.includes("mail:events") && principal.scopes.includes(eventScope(name));
}
function definition(name: EventName) {
  const outbound = eventScope(name) === "mail:send";
  const key = outbound ? "operationId" : "ingestId";
  const dataProperties: Record<string, unknown> = { [key]: { type: "string" } };
  if (outbound)
    dataProperties["status"] = {
      type: "string",
      enum: name === "email.send_status_changed" ? SEND_STATES : DELIVERY_STATES,
    };
  return {
    name,
    description: {
      "email.received":
        "A new email has a durable original and catalog record. Does not replay historical imports.",
      "email.ready": "An email's MIME extraction is complete and available to read tools.",
      "email.processing_failed": "MIME processing of an email failed.",
      "email.send_status_changed":
        "An outbound operation changed submission status; acceptance is not delivery.",
      "email.delivery_status_changed":
        "A provider reported a recipient delivery status change for an outbound operation.",
    }[name],
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: { [key]: { type: "string" } },
      additionalProperties: false,
    },
    payloadSchema: {
      type: "object",
      properties: dataProperties,
      required: Object.keys(dataProperties),
      additionalProperties: false,
    },
  };
}
async function subscriptionId(
  principal: string,
  url: string,
  name: EventName,
  args: Record<string, string>,
): Promise<string> {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
  );
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([principal, url, name, canonical])),
    ),
  );
  return `sub_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function handleEventRequest(
  database: D1Database,
  principal: MailPrincipal,
  method: string,
  params: unknown,
  runtime: EventRuntime,
): Promise<Record<string, unknown>> {
  if (method === "events/list") {
    const parsed = v.safeParse(eventRequestSchemas[method], params ?? {});
    if (!parsed.success || parsed.output.cursor !== undefined) invalid();
    return { events: EVENT_NAMES.filter((name) => authorized(principal, name)).map(definition) };
  }
  const db = database.withSession("first-primary");
  if (method === "events/unsubscribe") {
    const parsed = v.safeParse(eventRequestSchemas[method], params);
    if (!parsed.success) invalid();
    let id: string;
    if ("id" in parsed.output) id = parsed.output.id;
    else {
      const input = parsed.output;
      const args = input.arguments as Record<string, string>;
      if (
        Object.keys(args).some(
          (key) => key !== (eventScope(input.name) === "mail:send" ? "operationId" : "ingestId"),
        )
      )
        invalid();
      let url: string;
      try {
        url = validateCallback(input.delivery.url).href;
      } catch {
        invalid();
      }
      id = await subscriptionId(principal.id, url, input.name, args);
    }
    await db
      .prepare(
        "UPDATE event_subscriptions SET state='stopped',signing_secret='',previous_signing_secret=NULL,previous_secret_until=0,revision=revision+1,lease_token=NULL,lease_until=0,stop_reason='unsubscribed' WHERE id=? AND principal_id=?",
      )
      .bind(id, principal.id)
      .run();
    return {};
  }
  if (method !== "events/subscribe") throw new EventProtocolError(-32601, "Method not found");
  const parsed = v.safeParse(eventRequestSchemas[method], params);
  if (!parsed.success) invalid();
  const request = parsed.output;
  const args = request.arguments as Record<string, string>;
  if (
    Object.keys(args).some(
      (key) => key !== (eventScope(request.name) === "mail:send" ? "operationId" : "ingestId"),
    )
  )
    invalid();
  if (
    !authorized(principal, request.name) ||
    !(await runtime.authorize(principal.id, request.name, args))
  )
    throw new EventProtocolError(-32001, "Event access denied");
  let url: string;
  try {
    url = validateCallback(request.delivery.url).href;
    decodeSigningSecret(request.delivery.secret);
  } catch {
    invalid();
  }
  const id = await subscriptionId(principal.id, url, request.name, args);
  const existing = await db
    .prepare("SELECT * FROM event_subscriptions WHERE id=? AND principal_id=?")
    .bind(id, principal.id)
    .first<Subscription>();
  if (!existing) {
    const count = await db
      .prepare("SELECT COUNT(*) AS count FROM event_subscriptions WHERE principal_id=?")
      .bind(principal.id)
      .first<number>("count");
    if ((count ?? 0) >= 100) throw new EventProtocolError(-32001, "Subscription limit reached");
  }
  const high = await db
    .prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM mail_events")
    .first<{ sequence: number }>();
  const start = existing?.start_sequence ?? high?.sequence ?? 0;
  let cursor = existing?.cursor ?? start;
  if (request.cursor !== undefined && request.cursor !== null) {
    if (!existing || !request.cursor.startsWith(`${id}:`)) invalid();
    const raw = request.cursor.slice(id.length + 1);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) invalid();
    const value = Number(raw);
    // Refresh may replay acknowledged records, but can never skip pending events
    // or reach records preceding this subscription's original creation.
    if (!Number.isSafeInteger(value) || value < start || value > existing.cursor) invalid();
    cursor = value;
  }
  const now = runtime.now?.() ?? Date.now();
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.delivery.secret)),
  );
  const secretHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const verified = await db
    .prepare(
      "SELECT expires_at FROM event_callback_verifications WHERE principal_id=? AND callback_url=? AND secret_hash=? AND expires_at>?",
    )
    .bind(principal.id, url, secretHash, now)
    .first();
  if (!verified) {
    try {
      await verifyCallback(runtime.http, url, request.delivery.secret, id, now);
    } catch {
      throw new EventProtocolError(-32015, "Callback verification failed", {
        reason: "challenge_failed",
      });
    }
    if ((runtime.now?.() ?? Date.now()) > now + 30_000)
      throw new EventProtocolError(-32015, "Callback verification expired", { reason: "timeout" });
    await db
      .prepare(`INSERT INTO event_callback_verifications (principal_id,callback_url,secret_hash,expires_at) VALUES (?,?,?,?)
      ON CONFLICT(principal_id,callback_url) DO UPDATE SET secret_hash=excluded.secret_hash,expires_at=excluded.expires_at`)
      .bind(principal.id, url, secretHash, now + 300_000)
      .run();
  }
  if ((runtime.now?.() ?? Date.now()) > now + 30_000)
    throw new EventProtocolError(-32015, "Callback verification expired", { reason: "timeout" });
  if (!(await runtime.authorize(principal.id, request.name, args)))
    throw new EventProtocolError(-32001, "Event access denied");
  const expires = now + Math.max(60_000, Math.min(request.ttlMs ?? 86_400_000, 86_400_000));
  if (existing) {
    const rotating =
      existing.signing_secret !== request.delivery.secret && existing.signing_secret !== "";
    const previousSecret = rotating
      ? existing.signing_secret
      : existing.previous_secret_until > now
        ? existing.previous_signing_secret
        : null;
    const previousUntil = rotating
      ? now + 300_000
      : previousSecret
        ? existing.previous_secret_until
        : 0;
    const result = await db
      .prepare(
        `UPDATE event_subscriptions SET signing_secret=?,previous_signing_secret=?,previous_secret_until=?,expires_at=?,cursor=?,state='active',revision=revision+1,attempts=0,next_attempt_at=0,lease_until=0,lease_token=NULL,stop_reason=NULL WHERE id=? AND principal_id=? AND revision=?`,
      )
      .bind(
        request.delivery.secret,
        previousSecret,
        previousUntil,
        expires,
        cursor,
        id,
        principal.id,
        existing.revision,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new EventProtocolError(-32015, "Subscription changed; retry", { reason: "conflict" });
  } else {
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO event_subscriptions (id,principal_id,name,arguments_json,callback_url,signing_secret,expires_at,start_sequence,cursor,state) SELECT ?,?,?,?,?,?,?,?,?,'active' WHERE (SELECT COUNT(*) FROM event_subscriptions WHERE principal_id=?)<100`,
      )
      .bind(
        id,
        principal.id,
        request.name,
        JSON.stringify(args),
        url,
        request.delivery.secret,
        expires,
        start,
        cursor,
        principal.id,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new EventProtocolError(-32015, "Subscription changed; retry", { reason: "conflict" });
  }
  return {
    id,
    refreshBefore: new Date(expires).toISOString(),
    cursor: cursorFor(id, cursor),
    truncated: false,
  };
}
