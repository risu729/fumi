/**
 * Shared, bounded building blocks for the optional Claude calls: bounded reads of
 * private R2 configuration, the shared daily call budget and one structured-output
 * request to the fixed Anthropic origin. Used by routing classification
 * (`routing-policy.ts`) and link selection (`link-selection.ts`).
 *
 * Nothing here logs. Errors carry fixed messages, never a prompt, response or key.
 */
import * as v from "valibot";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

const responseSchema = v.object({
  stop_reason: v.literal("end_turn"),
  content: v.tuple([v.strictObject({ type: v.literal("text"), text: v.string() })]),
});

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Policy input unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The object exists but its size, stream or deadline made it unreadable. */
export class BoundedObjectReadError extends Error {}

/** Lookup and complete stream share one deadline; late R2 results are discarded. */
export async function boundedObjectText(bucket: R2Bucket, key: string, limit: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  let finished = false;
  try {
    const pending = bucket.get(key);
    void pending
      .then((late) => {
        if (finished && controller.signal.aborted && late)
          void late.body.cancel().catch(() => undefined);
        return undefined;
      })
      .catch(() => undefined);
    const object = await abortable(pending, controller.signal);
    if (!object) return null;
    if (object.size > limit) {
      void object.body.cancel().catch(() => undefined);
      throw new BoundedObjectReadError("Policy input exceeds bound");
    }
    try {
      return { object, input: await boundedText(object.body, limit, controller.signal) };
    } catch {
      throw new BoundedObjectReadError("Policy input unavailable");
    }
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}

/** Both the body and time limits apply to the complete stream, not just headers. */
export async function boundedText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let emptyChunks = 0;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Policy input unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- One bounded stream is read sequentially.
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      if (part.value.byteLength === 0) {
        if (++emptyChunks > 8) throw new Error("Policy input stalled");
        continue;
      }
      emptyChunks = 0;
      length += part.value.byteLength;
      if (length > limit) throw new Error("Policy input exceeds bound");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}

/**
 * Atomically reserve one call in the shared UTC-day budget (`routing_model_budget`).
 * Returns false once `maxCallsPerDay` calls are reserved for that day. A reserved
 * call is never refunded, because an ambiguous provider request may have been billed.
 */
export async function reserveModelCall(
  db: D1Database | D1DatabaseSession,
  now: number,
  maxCallsPerDay: number,
) {
  const budget = await db
    .prepare(`INSERT INTO routing_model_budget(utc_day,calls) VALUES (?,1)
      ON CONFLICT(utc_day) DO UPDATE SET calls=calls+1 WHERE calls<? RETURNING calls`)
    .bind(new Date(now).toISOString().slice(0, 10), maxCallsPerDay)
    .first();
  return !!budget;
}

export interface StructuredOutputRequest {
  fetch?: typeof fetch | undefined;
  apiKey: string;
  model: string;
  maxTokens: number;
  system: string;
  /** The single user message. Callers put untrusted data here, never in `system`. */
  user: string;
  schema: Record<string, unknown>;
  /** Covers the request and the whole response body. */
  signal: AbortSignal;
  maxResponseBytes: number;
}

/**
 * Send one request without tools to the fixed Anthropic origin, with
 * `redirect: "manual"` and JSON-schema output. Returns the single text block of a
 * complete answer, or `{ ok: false }` for an HTTP error or redirect (not followed).
 * Throws on a network failure, timeout, oversized body, refusal, partial answer or
 * any other response shape.
 */
export async function requestStructuredOutput(
  request: StructuredOutputRequest,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const response = await (request.fetch ?? fetch)(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    redirect: "manual",
    signal: request.signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": request.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: { format: { type: "json_schema", schema: request.schema } },
    }),
  });
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    return { ok: false };
  }
  const wire = await boundedText(response.body, request.maxResponseBytes, request.signal);
  const parsed = v.parse(responseSchema, JSON.parse(wire.text) as unknown);
  return { ok: true, text: parsed.content[0].text };
}
