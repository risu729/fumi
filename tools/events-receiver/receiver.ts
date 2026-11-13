import { DurableObject } from "cloudflare:workers";
import { parseSecrets, verifySignatures } from "./verify.ts";

/** Temporary MCP Events acceptance receiver. It answers callback verification,
 * verifies Standard Webhooks signatures and keeps only event IDs, signature
 * results and receipt times. Event payload data is never stored. */

export const EVENT_NAMES = [
  "email.received",
  "email.ready",
  "email.processing_failed",
  "email.send_status_changed",
  "email.delivery_status_changed",
] as const;
const MAX_BODY_BYTES = 262_144;
const MAX_RECORDS = 2000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export interface DeliveryRecord {
  /** `webhook-id`; for events this equals the payload's `eventId`. */
  eventId: string;
  kind: "verification" | "event";
  name: string | null;
  presented: number;
  matchedKeys: number[];
  receivedAt: number;
}
export interface DeliveryResults {
  deliveries: DeliveryRecord[];
  rejected: number;
}
export interface DeliveryStore {
  record(record: DeliveryRecord): Promise<void>;
  reject(): Promise<void>;
  list(): Promise<DeliveryResults>;
}
export interface ReceiverConfig {
  SIGNING_SECRETS: string;
  READ_TOKEN: string;
}
interface ReceiverEnv extends ReceiverConfig {
  RESULTS: DurableObjectNamespace<Results>;
}

function plain(status: number): Response {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
function sameToken(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
async function boundedText(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Bound streamed request bytes.
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) return null;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function handleReceiver(
  request: Request,
  config: ReceiverConfig,
  store: DeliveryStore,
  now: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return plain(204);
  if (url.pathname === "/results" && request.method === "GET") {
    const header = request.headers.get("authorization") ?? "";
    if (config.READ_TOKEN.length < 32 || !sameToken(header, `Bearer ${config.READ_TOKEN}`))
      return plain(401);
    return json(await store.list());
  }
  if (url.pathname !== "/events") return plain(404);
  if (request.method !== "POST") return plain(405);
  const id = request.headers.get("webhook-id") ?? "";
  const timestamp = request.headers.get("webhook-timestamp") ?? "";
  const signature = request.headers.get("webhook-signature") ?? "";
  if (!ID_PATTERN.test(id)) return plain(400);
  const body = await boundedText(request);
  if (body === null) return plain(413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return plain(400);
  }
  if (!parsed || typeof parsed !== "object") return plain(400);
  const message = parsed as Record<string, unknown>;
  const verification = message["type"] === "verification";
  if (verification && typeof message["challenge"] !== "string") return plain(400);
  if (!verification && message["eventId"] !== id) return plain(400);
  const name =
    !verification && EVENT_NAMES.includes(message["name"] as (typeof EVENT_NAMES)[number])
      ? (message["name"] as string)
      : null;
  const result = await verifySignatures(
    parseSecrets(config.SIGNING_SECRETS),
    id,
    timestamp,
    body,
    signature,
    Math.floor(now / 1000),
  );
  if (!result.valid) {
    // Unauthenticated callers can only increment a counter, never fill the store.
    await store.reject();
    return plain(401);
  }
  await store.record({
    eventId: id,
    kind: verification ? "verification" : "event",
    name,
    presented: result.presented,
    matchedKeys: result.matchedKeys,
    receivedAt: now,
  });
  return verification ? json({ challenge: message["challenge"] }) : plain(204);
}

export class Results extends DurableObject<ReceiverConfig> {
  constructor(state: DurableObjectState, env: ReceiverConfig) {
    super(state, env);
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, presented INTEGER NOT NULL, matched_keys TEXT NOT NULL, received_at INTEGER NOT NULL)",
    );
    state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS rejected (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL)",
    );
  }
  record(record: DeliveryRecord): void {
    const sql = this.ctx.storage.sql;
    const count = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM deliveries").one();
    if (count.count >= MAX_RECORDS) return;
    sql.exec(
      "INSERT INTO deliveries (event_id,kind,name,presented,matched_keys,received_at) VALUES (?,?,?,?,?,?)",
      record.eventId,
      record.kind,
      record.name,
      record.presented,
      record.matchedKeys.join(","),
      record.receivedAt,
    );
  }
  reject(): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO rejected (id,count) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET count=count+1",
    );
  }
  list(): DeliveryResults {
    const sql = this.ctx.storage.sql;
    const rejected = sql.exec<{ count: number }>("SELECT count FROM rejected WHERE id=1").toArray();
    return {
      rejected: rejected[0]?.count ?? 0,
      deliveries: sql
        .exec<{
          event_id: string;
          kind: "verification" | "event";
          name: string | null;
          presented: number;
          matched_keys: string;
          received_at: number;
        }>("SELECT * FROM deliveries ORDER BY seq")
        .toArray()
        .map((row) => ({
          eventId: row.event_id,
          kind: row.kind,
          name: row.name,
          presented: row.presented,
          matchedKeys: row.matched_keys === "" ? [] : row.matched_keys.split(",").map(Number),
          receivedAt: row.received_at,
        })),
    };
  }
}

export default {
  async fetch(request, env) {
    const stub = env.RESULTS.get(env.RESULTS.idFromName("results"));
    return handleReceiver(request, env, {
      record: async (record) => {
        await stub.record(record);
      },
      reject: async () => {
        await stub.reject();
      },
      list: async () => stub.list(),
    });
  },
} satisfies ExportedHandler<ReceiverEnv>;
