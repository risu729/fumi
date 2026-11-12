import * as v from "valibot";

const id = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const url = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.check((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.hash &&
        !parsed.search &&
        !parsed.port &&
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(parsed.hostname) &&
        !/(?:^|\.)(?:localhost|local|internal|invalid|test|onion|home|lan)$/.test(parsed.hostname)
      );
    } catch {
      return false;
    }
  }),
);
const httpAdapterSchema = v.strictObject({
  kind: v.picklist(["https", "service"]),
  offerUrl: url,
  statusUrl: url,
  authRef: id,
  serviceRef: v.nullable(id),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000)),
});
export const adapterSchema = v.union([
  httpAdapterSchema,
  v.strictObject({
    kind: v.literal("rpc"),
    serviceRef: id,
    timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000)),
  }),
]);
export type PluginAdapter = v.InferOutput<typeof adapterSchema>;
export const webhookAdapterSchema = v.strictObject({
  kind: v.literal("webhook"),
  url,
  authRef: id,
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000)),
});
export const notificationAdapterSchema = v.union([adapterSchema, webhookAdapterSchema]);
export type NotificationAdapter = v.InferOutput<typeof notificationAdapterSchema>;
export type WebhookAdapter = v.InferOutput<typeof webhookAdapterSchema>;
export type OfferResult =
  | "handled"
  | "not_applicable"
  | "retryable_error"
  | "rejected"
  | "uncertain"
  | "not_found";
const receiptSchema = v.strictObject({
  schemaVersion: v.literal(1),
  operationId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  requestSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  result: v.picklist([
    "handled",
    "not_applicable",
    "retryable_error",
    "rejected",
    "uncertain",
    "not_found",
  ]),
});
export type OfferReceipt = v.InferOutput<typeof receiptSchema>;
export interface OfferTransport {
  auth: Readonly<Record<string, string>>;
  services?: Readonly<Record<string, Pick<Fetcher, "fetch">>>;
  rpcServices?: Readonly<Record<string, RoutingOfferService>>;
  fetch?: typeof fetch;
}
export interface PluginOfferRequest {
  schemaVersion: 1;
  kind: "owner" | "notification";
  operationId: string;
  source: { eventId: string; rawSha256: string; receivedAt: string | null };
  pluginId?: string;
  manifestVersion?: string;
  manifestSha256?: string;
  classification?: {
    outcome: "review";
    category: string | null;
    urgent: boolean;
    evidenceCode: string;
  };
  input: Record<string, unknown>;
}
export interface RoutingOfferService {
  offer(
    request: PluginOfferRequest & {
      requestSha256: string;
      attempt: { generation: number; expiresAt: number };
    },
  ): Promise<unknown>;
  receipt(request: {
    schemaVersion: 1;
    operationId: string;
    requestSha256: string;
  }): Promise<unknown>;
}
/** Canonical protocol JSON: sorted object keys, preserved arrays, JSON primitive
 * encoding. Protocol values contain no floating-point numbers or undefined. */
export function canonicalOfferJson(value: unknown): string {
  function canonical(input: unknown, depth: number): unknown {
    if (depth > 16) throw new Error("Invalid protocol value");
    if (input === null || typeof input === "string" || typeof input === "boolean" || input === 1)
      return input;
    if (Array.isArray(input) && input.length <= 32)
      return input.map((item) => canonical(item, depth + 1));
    if (input && typeof input === "object") {
      const entries = Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (entries.length > 32) throw new Error("Invalid protocol value");
      return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item, depth + 1)]));
    }
    throw new Error("Invalid protocol value");
  }
  return JSON.stringify(canonical(value, 0));
}

/** Exact-size/byte bounded reads; the caller supplies the shared operation deadline. */
export async function readDispatchBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  deadlineMs: number,
): Promise<string> {
  if (!body) throw new Error("Missing bounded data");
  const reader = body.getReader();
  const bytes = new Uint8Array(limit);
  let offset = 0;
  let emptyChunks = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Bounded read deadline")), deadlineMs);
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- A byte cap and one shared deadline bound streaming.
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) {
        if (++emptyChunks > 8) throw new Error("Bounded stream stalled");
        continue;
      }
      emptyChunks = 0;
      if (chunk.value.byteLength > limit - offset) throw new Error("Bounded data too large");
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes.subarray(0, offset),
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}

export async function dispatchDigest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Generic providers acknowledge only HTTP acceptance. Unknown results are never
 * retried automatically: this adapter makes no remote idempotency/status promise. */
export async function exchangeWebhook(
  adapter: WebhookAdapter,
  transport: OfferTransport,
  operationId: string,
  requestSha256: string,
  payload: string,
): Promise<"accepted" | "uncertain"> {
  const secret = transport.auth[adapter.authRef];
  if (!secret || secret.length < 24 || secret.length > 4096 || /[\r\n]/.test(secret))
    return "uncertain";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Webhook deadline"));
    }, adapter.timeoutMs);
  });
  try {
    const response = await Promise.race([
      (transport.fetch ?? fetch)(adapter.url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          "Idempotency-Key": operationId,
          "X-Fumi-Request-Sha256": requestSha256,
        },
        body: payload,
      }),
      deadline,
    ]);
    await Promise.race([response.body?.cancel().catch(() => undefined), Promise.resolve()]);
    return response.status >= 200 && response.status < 300 ? "accepted" : "uncertain";
  } catch {
    return "uncertain";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The endpoint must atomically deduplicate operationId + requestSha256. HTTP status
 * alone is never proof of acceptance or of the absence of a committed side effect. */
export async function exchangeOffer(
  adapter: PluginAdapter,
  transport: OfferTransport,
  operationId: string,
  requestSha256: string,
  payload: string,
  statusOnly: boolean,
  attempt: { generation: number; expiresAt: number } = { generation: 1, expiresAt: 0 },
): Promise<OfferReceipt> {
  const uncertain: OfferReceipt = {
    schemaVersion: 1,
    operationId,
    requestSha256,
    result: "uncertain",
  };
  const secret = adapter.kind === "rpc" ? null : transport.auth[adapter.authRef];
  if (
    adapter.kind !== "rpc" &&
    (!secret || secret.length < 24 || secret.length > 4096 || /[\r\n]/.test(secret))
  )
    return uncertain;
  const service =
    adapter.kind !== "rpc" && adapter.serviceRef
      ? transport.services?.[adapter.serviceRef]
      : undefined;
  const rpc = adapter.kind === "rpc" ? transport.rpcServices?.[adapter.serviceRef] : undefined;
  if (
    (adapter.kind === "rpc" && !rpc) ||
    (adapter.kind === "service" && !service) ||
    (adapter.kind === "https" && adapter.serviceRef !== null)
  )
    return uncertain;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Adapter deadline"));
    }, adapter.timeoutMs);
  });
  try {
    if (adapter.kind === "rpc" && rpc) {
      const value = await Promise.race([
        statusOnly
          ? rpc.receipt({ schemaVersion: 1, operationId, requestSha256 })
          : rpc.offer({ ...(JSON.parse(payload) as PluginOfferRequest), requestSha256, attempt }),
        deadline,
      ]);
      const receipt = v.parse(receiptSchema, value);
      return receipt.operationId === operationId &&
        receipt.requestSha256 === requestSha256 &&
        (statusOnly || receipt.result !== "not_found")
        ? receipt
        : uncertain;
    }
    if (adapter.kind === "rpc") return uncertain;
    const request = new Request(statusOnly ? adapter.statusUrl : adapter.offerUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
        "Idempotency-Key": operationId,
        "X-Fumi-Request-Sha256": requestSha256,
      },
      body: statusOnly ? JSON.stringify({ schemaVersion: 1, operationId, requestSha256 }) : payload,
    });
    if (!statusOnly) {
      request.headers.set("X-Fumi-Generation", String(attempt.generation));
      request.headers.set("X-Fumi-Attempt-Expires-At", String(attempt.expiresAt));
    }
    const pending =
      adapter.kind === "service" && service
        ? service.fetch(request)
        : (transport.fetch ?? fetch)(request);
    const response = await Promise.race([pending, deadline]);
    if (response.status !== 200) {
      await Promise.race([response.body?.cancel().catch(() => undefined), Promise.resolve()]);
      return uncertain;
    }
    const json = await Promise.race([
      readDispatchBytes(response.body, 4096, adapter.timeoutMs),
      deadline,
    ]);
    const receipt = v.parse(receiptSchema, JSON.parse(json) as unknown);
    if (
      receipt.operationId !== operationId ||
      receipt.requestSha256 !== requestSha256 ||
      (!statusOnly && receipt.result === "not_found")
    )
      return uncertain;
    return receipt;
  } catch {
    return uncertain;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
