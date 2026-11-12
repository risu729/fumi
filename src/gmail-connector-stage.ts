import * as v from "valibot";
import { apiOrigin } from "./auth.ts";
import { hasScope, type MailPrincipal } from "./principal.ts";

export const CONNECTOR_STAGE_PATH = "/api/admin/gmail-import/stage";
const INPUT_LIMIT = 2_500_000;
const encoder = new TextEncoder();
const id = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,128}$/));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const scopeSchema = v.strictObject({
  accountNamespace: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/)),
  before: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(8_640_000_000_000)),
  after: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  includeSpamTrash: v.boolean(),
});
const configurationSchema = v.strictObject({
  transport: v.literal("connector"),
  importId: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/)),
  expectedAccountHash: digest,
  scope: scopeSchema,
});
const inputSchema = v.strictObject({
  schemaVersion: v.literal(1),
  importId: v.string(),
  accountHash: digest,
  scope: scopeSchema,
  entries: v.pipe(
    v.array(
      v.strictObject({
        id,
        threadId: id,
        internalDate: v.pipe(v.string(), v.regex(/^\d{1,16}$/)),
        labelIds: v.pipe(v.array(id), v.maxLength(100)),
        raw: v.pipe(v.string(), v.maxLength(INPUT_LIMIT)),
        rawSize: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(INPUT_LIMIT)),
        rawSha256: digest,
      }),
    ),
    v.minLength(1),
    v.maxLength(10),
  ),
});
interface StageEnvironment {
  API_ORIGIN: string;
  GMAIL_IMPORT_CONFIG?: string | undefined;
  MAIL_ARCHIVE: R2Bucket;
}
class StageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const hash = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
function cancel(body: ReadableStream<Uint8Array> | null | undefined) {
  void body?.cancel().catch(() => undefined);
}
async function bounded<T>(
  operation: Promise<T>,
  until: number,
  late?: (value: T) => void,
): Promise<T> {
  if (Date.now() >= until) {
    void operation.then(
      (value) => late?.(value),
      () => undefined,
    );
    throw new StageError("connector_stage_timeout", 504);
  }
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const expire = () => {
      expired = true;
      reject(new StageError("connector_stage_timeout", 504));
    };
    timer = setTimeout(expire, until - Date.now());
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (expired)
      void operation.then(
        (value) => late?.(value),
        () => undefined,
      );
  }
}
async function readBytes(body: ReadableStream<Uint8Array>, maximum: number, until: number) {
  const reader = body.getReader();
  const output = new Uint8Array(maximum);
  let length = 0;
  let empty = 0;
  try {
    for (let chunks = 0; chunks < 4096; chunks++) {
      if (Date.now() >= until) throw new StageError("connector_stage_timeout", 504);
      // oxlint-disable-next-line no-await-in-loop -- One bounded stream and shared absolute deadline.
      const part = await bounded(reader.read(), until);
      if (part.done) return output.slice(0, length);
      if (part.value.byteLength === 0) {
        if (++empty >= 8) throw new StageError("connector_stage_invalid", 400);
        continue;
      }
      empty = 0;
      if (part.value.byteLength > maximum - length)
        throw new StageError("connector_stage_too_large", 413);
      output.set(part.value, length);
      length += part.value.byteLength;
    }
    throw new StageError("connector_stage_invalid", 400);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function configuration(env: StageEnvironment) {
  if (!env.GMAIL_IMPORT_CONFIG || env.GMAIL_IMPORT_CONFIG.length > 16_384)
    throw new StageError("connector_stage_not_configured", 503);
  const parsed = v.safeParse(configurationSchema, JSON.parse(env.GMAIL_IMPORT_CONFIG));
  if (!parsed.success || (parsed.output.scope.after ?? 0) >= parsed.output.scope.before)
    throw new StageError("connector_stage_not_configured", 503);
  return parsed.output;
}
async function createOnce(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  sha256: string,
  until: number,
) {
  if (Date.now() >= until) throw new StageError("connector_stage_timeout", 504);
  // Atomic creation also protects concurrent/retried requests. Never overwrite.
  await bounded(
    bucket.put(key, bytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256,
      httpMetadata: { contentType: "application/octet-stream" },
    }),
    until,
  );
  if (Date.now() >= until) throw new StageError("connector_stage_timeout", 504);
  const object = await bounded(bucket.get(key), until, (late) => cancel(late?.body));
  if (!object || object.size !== bytes.length) {
    cancel(object?.body);
    throw new StageError("connector_stage_conflict");
  }
  const actual = await readBytes(object.body, bytes.length, until);
  if (actual.length !== bytes.length || (await bounded(hash(actual), until)) !== sha256)
    throw new StageError("connector_stage_conflict");
}

/** Operator-attested connector bytes only; this endpoint does not authenticate Gmail. */
export async function handleConnectorStage(
  request: Request,
  env: StageEnvironment,
  principal: MailPrincipal,
): Promise<Response> {
  const respond = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  // JWT authentication belongs to the parent HTTP handler. Recheck the operator
  // grant and same origin here before reading any untrusted request bytes.
  if (!hasScope(principal, "mail:import")) return respond({ error: { code: "forbidden" } }, 403);
  try {
    const url = new URL(request.url);
    const origin = apiOrigin(env);
    if (url.origin !== origin || request.headers.get("origin") !== origin)
      return respond({ error: { code: "origin_not_allowed" } }, 403);
    if (url.pathname !== CONNECTOR_STAGE_PATH)
      return respond({ error: { code: "not_found" } }, 404);
    if (request.method !== "POST") return respond({ error: { code: "method_not_allowed" } }, 405);
    if (
      url.search ||
      url.hash ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
        request.headers.get("content-type") ?? "",
      ) ||
      request.headers.has("content-encoding") ||
      !/^[a-f0-9]{64}$/.test(request.headers.get("x-fumi-stage-sha256") ?? "")
    )
      throw new StageError("connector_stage_invalid", 400);
    const cfg = configuration(env);
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d{1,10}$/.test(length) || Number(length) > INPUT_LIMIT))
      throw new StageError("connector_stage_too_large", 413);
    if (!request.body) throw new StageError("connector_stage_invalid", 400);
    const input = await readBytes(request.body, INPUT_LIMIT, Date.now() + 15_000);
    if (length !== null && Number(length) !== input.length)
      throw new StageError("connector_stage_length_mismatch", 400);
    if ((await hash(input)) !== request.headers.get("x-fumi-stage-sha256"))
      throw new StageError("connector_stage_request_mismatch", 400);
    let value: v.InferOutput<typeof inputSchema>;
    try {
      value = v.parse(
        inputSchema,
        JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input)),
      );
    } catch {
      throw new StageError("connector_stage_invalid", 400);
    }
    if (
      value.importId !== cfg.importId ||
      value.accountHash !== cfg.expectedAccountHash ||
      value.scope.accountNamespace !== cfg.scope.accountNamespace ||
      value.scope.before !== cfg.scope.before ||
      value.scope.after !== cfg.scope.after ||
      value.scope.includeSpamTrash !== cfg.scope.includeSpamTrash
    )
      throw new StageError("connector_stage_scope_mismatch", 409);
    if (new Set(value.entries.map((entry) => entry.id)).size !== value.entries.length)
      throw new StageError("connector_stage_invalid", 400);
    // Validate and hash the complete batch before making the first write.
    const entries = await Promise.all(
      value.entries.map(async (entry) => {
        const time = Number(entry.internalDate);
        if (
          !Number.isSafeInteger(time) ||
          time < (cfg.scope.after ?? 0) * 1000 ||
          time >= cfg.scope.before * 1000 ||
          new Set(entry.labelIds).size !== entry.labelIds.length ||
          (!cfg.scope.includeSpamTrash &&
            entry.labelIds.some((label) => label === "SPAM" || label === "TRASH")) ||
          !/^[A-Za-z0-9_-]*={0,2}$/.test(entry.raw)
        )
          throw new StageError("connector_stage_invalid", 400);
        let binary: string;
        try {
          binary = atob(entry.raw.replace(/-/g, "+").replace(/_/g, "/"));
        } catch {
          throw new StageError("connector_stage_invalid", 400);
        }
        const canonical = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        if (canonical !== entry.raw.replace(/=+$/, ""))
          throw new StageError("connector_stage_invalid", 400);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        const sha256 = await hash(bytes);
        if (bytes.length !== entry.rawSize || sha256 !== entry.rawSha256)
          throw new StageError("connector_stage_integrity_mismatch", 400);
        const metadata = encoder.encode(
          JSON.stringify({
            schemaVersion: 1,
            accountHash: cfg.expectedAccountHash,
            id: entry.id,
            threadId: entry.threadId,
            internalDate: entry.internalDate,
            labelIds: entry.labelIds,
            rawSize: bytes.length,
            rawSha256: sha256,
          }),
        );
        if (metadata.length > 16 * 1024) throw new StageError("connector_stage_invalid", 400);
        return { entry, bytes, sha256, metadata, metadataSha: await hash(metadata) };
      }),
    );
    const prefix = `imports/gmail-connector-v1/${cfg.importId}`;
    const until = Date.now() + 30_000;
    for (let offset = 0; offset < entries.length; offset += 5) {
      // oxlint-disable-next-line no-await-in-loop -- At most five bounded immutable writes/readbacks in flight.
      const results = await Promise.allSettled(
        entries.slice(offset, offset + 5).map(async (item) => {
          await createOnce(
            env.MAIL_ARCHIVE,
            `${prefix}/raw/${item.entry.id}/${item.sha256}.eml`,
            item.bytes,
            item.sha256,
            until,
          );
          await createOnce(
            env.MAIL_ARCHIVE,
            `${prefix}/messages/${item.entry.id}.json`,
            item.metadata,
            item.metadataSha,
            until,
          );
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    return respond({
      schemaVersion: 1,
      requestSha256: request.headers.get("x-fumi-stage-sha256"),
      staged: entries.map((item) => ({
        id: item.entry.id,
        size: item.bytes.length,
        sha256: item.sha256,
      })),
    });
  } catch (error) {
    return respond(
      {
        error: {
          code: error instanceof StageError ? error.code : "connector_stage_unavailable",
        },
      },
      error instanceof StageError ? error.status : 503,
    );
  }
}
