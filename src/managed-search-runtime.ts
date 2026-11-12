import * as v from "valibot";
import { MailReadError, type MailReadEnvironment } from "./mail-read.ts";
import { archiveCandidate } from "./archive-key.ts";

export interface ManagedMailBinding {
  info(): Promise<unknown>;
  items: {
    upload(name: string, content: Blob): Promise<unknown>;
    get(id: string): { info(): Promise<unknown> };
  };
  search(parameters: AiSearchSearchRequest): Promise<unknown>;
}
declare global {
  namespace Cloudflare {
    interface Env {
      MANAGED_MAIL_SEARCH?: AiSearchInstance;
      MANAGED_MAIL_SEARCH_CONFIG?: string;
    }
  }
}
export interface ManagedMailEnvironment extends MailReadEnvironment {
  MANAGED_MAIL_SEARCH?: ManagedMailBinding;
  MANAGED_MAIL_SEARCH_CONFIG?: string;
}
const configurationSchema = v.strictObject({
  version: v.literal(1),
  enabled: v.literal(true),
  revision: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,64}$/)),
  instanceId: v.pipe(v.string(), v.regex(/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/), v.maxLength(32)),
  maxUploads: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000)),
  maxQueries: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000)),
  hybrid: v.boolean(),
  sourceRawKeys: v.optional(
    v.pipe(
      v.array(
        v.pipe(
          v.string(),
          v.check((key) => {
            const candidate = archiveCandidate(key);
            return candidate !== null && key === `${candidate.prefix}/raw.eml`;
          }),
        ),
      ),
      v.minLength(1),
      v.maxLength(10),
      v.check((keys) => new Set(keys).size === keys.length),
    ),
  ),
});
export class ManagedSearchError extends MailReadError {}
export const BODY_LIMIT = 1024 * 1024;
export const hexDigest = async (bytes: Uint8Array | ArrayBuffer) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
export async function managedMailRuntime(env: ManagedMailEnvironment) {
  if (!env.MANAGED_MAIL_SEARCH_CONFIG) return null;
  try {
    const input = JSON.parse(env.MANAGED_MAIL_SEARCH_CONFIG) as unknown;
    if (input && typeof input === "object" && "enabled" in input && input.enabled === false)
      return null;
    const config = v.parse(configurationSchema, input);
    // A source set has no ordering semantics; reordering it must not reset budgets.
    config.sourceRawKeys?.sort();
    if (!env.MANAGED_MAIL_SEARCH) return null;
    const policy = await hexDigest(new TextEncoder().encode(JSON.stringify(config)));
    return { config, policy, binding: env.MANAGED_MAIL_SEARCH };
  } catch {
    throw new ManagedSearchError("invalid_managed_search_configuration");
  }
}
export type ManagedMailRuntime = NonNullable<Awaited<ReturnType<typeof managedMailRuntime>>>;
export function managedSourceScope(runtime: ManagedMailRuntime, column = "raw_key") {
  return runtime.config.sourceRawKeys
    ? {
        sql: `${column} IN (${runtime.config.sourceRawKeys.map(() => "?").join(",")})`,
        values: runtime.config.sourceRawKeys,
      }
    : { sql: "1", values: [] };
}
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ManagedSearchError("invalid_search_provider_response");
  return value as Record<string, unknown>;
};
export async function bounded<T>(request: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ManagedSearchError("managed_search_unavailable")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function verifyManagedInstance(runtime: ManagedMailRuntime, hybrid = false) {
  const info = record(await bounded(() => runtime.binding.info()));
  const methods = record(info["index_method"]);
  if (
    info["id"] !== runtime.config.instanceId ||
    methods["vector"] !== true ||
    (hybrid && methods["keyword"] !== true)
  )
    throw new ManagedSearchError("managed_search_instance_mismatch");
}
export async function reserveManagedCall(
  env: ManagedMailEnvironment,
  runtime: ManagedMailRuntime,
  kind: "query",
  callId: string,
) {
  const result =
    await env.MAIL_CATALOG.prepare(`INSERT INTO managed_mail_calls(call_id,policy_hash,kind,created_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM managed_mail_calls WHERE policy_hash=? AND kind=?)<?`)
      .bind(
        callId,
        runtime.policy,
        kind,
        Date.now(),
        runtime.policy,
        kind,
        runtime.config.maxQueries,
      )
      .run();
  if (result.meta.changes !== 1) throw new ManagedSearchError("managed_search_budget_exhausted");
}
/** Preserve UTF-8 bytes, including a BOM, so citations hash the exact downloadable source. */
export async function readManagedText(
  bucket: R2Bucket,
  key: string,
  hash: string,
  maximum = BODY_LIMIT,
  expectedSize?: number,
) {
  let object: R2ObjectBody | null = null,
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ManagedSearchError("managed_search_source_unavailable")),
      5000,
    );
  });
  try {
    const pending = bucket.get(key);
    void pending
      .then((late) => {
        if (finished && late) void late.body.cancel().catch(() => undefined);
        return undefined;
      })
      .catch(() => undefined);
    object = await Promise.race([pending, deadline]);
    if (
      !object ||
      object.size > maximum ||
      (expectedSize !== undefined && object.size !== expectedSize)
    )
      throw new ManagedSearchError("managed_search_source_unavailable");
    const bytes = new Uint8Array(object.size);
    let length = 0;
    reader = object.body.getReader();
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- One exact-size source and whole-stream deadline.
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (chunk.value.length > bytes.length - length)
        throw new ManagedSearchError("managed_search_source_unavailable");
      bytes.set(chunk.value, length);
      length += chunk.value.length;
    }
    if (length !== bytes.length || (await Promise.race([hexDigest(bytes), deadline])) !== hash)
      throw new ManagedSearchError("managed_search_source_unavailable");
    try {
      return {
        bytes,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      };
    } catch {
      throw new ManagedSearchError("managed_search_unsupported_encoding");
    }
  } finally {
    finished = true;
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else if (object) void object.body.cancel().catch(() => undefined);
  }
}
