import * as v from "valibot";
import { gmailId, gmailNamespace } from "./gmail-provenance.ts";
import {
  GMAIL_IMPORT_RAW_LIMIT,
  GmailImportError,
  type GmailTransport,
} from "./gmail-transport.ts";
import type { GmailImportScope } from "./gmail-import.ts";

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
const hash = async (text: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const scopeSchema = v.strictObject({
  accountNamespace: v.string(),
  before: v.number(),
  after: v.optional(v.number()),
  includeSpamTrash: v.boolean(),
});
const pageSchema = v.strictObject({
  schemaVersion: v.literal(1),
  accountHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  scope: scopeSchema,
  pageToken: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))),
  messageIds: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    v.maxLength(10),
  ),
  nextPageToken: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))),
});
const metadataSchema = v.strictObject({
  schemaVersion: v.literal(1),
  accountHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  id: v.string(),
  threadId: v.string(),
  internalDate: v.string(),
  labelIds: v.pipe(v.array(v.pipe(v.string(), v.maxLength(128))), v.maxLength(100)),
  rawSize: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(GMAIL_IMPORT_RAW_LIMIT)),
  rawSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
function sameScope(
  left: {
    accountNamespace: string;
    before: number;
    after?: number | undefined;
    includeSpamTrash: boolean;
  },
  right: GmailImportScope,
) {
  return (
    left.accountNamespace === right.accountNamespace &&
    left.before === right.before &&
    left.after === right.after &&
    left.includeSpamTrash === right.includeSpamTrash
  );
}
async function readObject(bucket: R2Bucket, key: string, maximum: number) {
  const object = await bucket.get(key);
  if (!object) throw new GmailImportError("connector_stage_missing");
  if (object.size > maximum) {
    await object.body.cancel();
    throw new GmailImportError("connector_stage_too_large");
  }
  const bytes = new Uint8Array(object.size);
  const reader = object.body.getReader();
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GmailImportError("connector_stage_timeout")), 15000);
  });
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- One exact-size staged object with a whole-stream deadline.
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (part.value.byteLength > bytes.length - length)
        throw new GmailImportError("connector_stage_size_mismatch");
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    if (length !== object.size) throw new GmailImportError("connector_stage_size_mismatch");
    return bytes;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
    reader.releaseLock();
  }
}
async function readJson(bucket: R2Bucket, key: string) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        await readObject(bucket, key, 16 * 1024),
      ),
    ) as unknown;
  } catch (error) {
    if (error instanceof GmailImportError) throw error;
    throw new GmailImportError("connector_stage_invalid");
  }
}

/** Only the administrator writes this staging prefix after reading the connected account. */
export function createConnectorGmailTransport(options: {
  bucket: R2Bucket;
  importId: string;
  expectedAccountHash: string;
  scope: GmailImportScope;
}): GmailTransport {
  if (!gmailNamespace(options.importId) || !/^[a-f0-9]{64}$/.test(options.expectedAccountHash))
    throw new GmailImportError("invalid_import_configuration");
  const prefix = `imports/gmail-connector-v1/${options.importId}`;
  return {
    async list(parameters) {
      if (
        parameters.q !==
          `before:${options.scope.before}${options.scope.after === undefined ? "" : ` after:${options.scope.after}`}` ||
        parameters.includeSpamTrash !== options.scope.includeSpamTrash ||
        parameters.maxResults !== 10
      )
        throw new GmailImportError("connector_scope_mismatch");
      const cursor = parameters.pageToken ?? null;
      if (cursor !== null && (!cursor || cursor.length > 2048))
        throw new GmailImportError("connector_stage_invalid");
      const key = await hash(JSON.stringify(cursor));
      let value: v.InferOutput<typeof pageSchema>;
      try {
        value = v.parse(pageSchema, await readJson(options.bucket, `${prefix}/pages/${key}.json`));
      } catch (error) {
        if (error instanceof GmailImportError) throw error;
        throw new GmailImportError("connector_stage_invalid");
      }
      if (
        value.accountHash !== options.expectedAccountHash ||
        !sameScope(value.scope, options.scope) ||
        value.pageToken !== cursor
      )
        throw new GmailImportError("connector_scope_mismatch");
      if (
        !value.messageIds.every(gmailId) ||
        new Set(value.messageIds).size !== value.messageIds.length ||
        (value.nextPageToken !== null &&
          (value.nextPageToken === cursor || value.messageIds.length === 0))
      )
        throw new GmailImportError("connector_stage_invalid");
      return {
        messages: value.messageIds.map((id) => ({ id })),
        ...(value.nextPageToken === null ? {} : { nextPageToken: value.nextPageToken }),
      };
    },
    async getRaw(id) {
      if (!gmailId(id)) throw new GmailImportError("gmail_invalid_message");
      let value: v.InferOutput<typeof metadataSchema>;
      try {
        value = v.parse(
          metadataSchema,
          await readJson(options.bucket, `${prefix}/messages/${id}.json`),
        );
      } catch (error) {
        if (error instanceof GmailImportError) throw error;
        throw new GmailImportError("connector_stage_invalid");
      }
      if (value.id !== id || value.accountHash !== options.expectedAccountHash)
        throw new GmailImportError("connector_scope_mismatch");
      if (
        !options.scope.includeSpamTrash &&
        value.labelIds.some((label) => label === "SPAM" || label === "TRASH")
      )
        throw new GmailImportError("gmail_message_outside_scope");
      const rawBytes = await readObject(
        options.bucket,
        `${prefix}/raw/${id}/${value.rawSha256}.eml`,
        GMAIL_IMPORT_RAW_LIMIT,
      );
      if (
        rawBytes.byteLength !== value.rawSize ||
        hex(await crypto.subtle.digest("SHA-256", rawBytes)) !== value.rawSha256
      )
        throw new GmailImportError("connector_stage_integrity_mismatch");
      return {
        id: value.id,
        threadId: value.threadId,
        internalDate: value.internalDate,
        labelIds: value.labelIds,
        rawBytes,
      };
    },
  };
}
