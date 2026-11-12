import * as v from "valibot";

interface PasswordEnvironment {
  MAIL_ARCHIVE: R2Bucket;
  MAIL_CATALOG: D1Database;
}
interface PasswordSource {
  raw_key: string;
  raw_sha256: string;
  source_namespace: string;
  source_kind: string;
  received_at: string | null;
  metadata_json: string;
  attachments_json: string;
  body_text_key: string | null;
  manifest_key: string;
}
const mailbox = v.object({ address: v.pipe(v.string(), v.maxLength(320)) });
const metadataSchema = v.object({
  from: v.nullable(mailbox),
  to: v.pipe(v.array(mailbox), v.maxLength(32)),
  cc: v.optional(v.pipe(v.array(mailbox), v.maxLength(32))),
  subject: v.nullable(v.string()),
  messageId: v.optional(v.nullable(v.string())),
  inReplyTo: v.optional(v.nullable(v.string())),
  references: v.optional(v.nullable(v.string())),
});
type Metadata = v.InferOutput<typeof metadataSchema>;
function metadata(json: string): Metadata | null {
  if (json.length > 32 * 1024) return null;
  try {
    return v.parse(metadataSchema, JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}
function participants(item: Metadata) {
  if (!item.from?.address || !item.to.length) return null;
  return JSON.stringify([
    item.from.address.toLowerCase(),
    [...new Set([...item.to, ...(item.cc ?? [])].map((x) => x.address.toLowerCase()))].sort(),
  ]);
}
function subject(value: string | null) {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:(?:re|fw|fwd|返信|転送)\s*[:：]\s*)+/iu, "");
}
function ids(item: Metadata) {
  const result = new Set<string>();
  for (const field of [item.messageId, item.inReplyTo, item.references]) {
    if (!field || field.length > 4096) continue;
    const matches = field.match(/<[^<>\s]{1,256}>/g) ?? [];
    if (matches.length) for (const match of matches.slice(0, 16)) result.add(match);
    else if (/^[^\s<>]{1,256}$/.test(field)) result.add(`<${field}>`);
  }
  return result;
}
async function text(env: PasswordEnvironment, key: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Password source unavailable")), 1000);
  });
  try {
    const pending = env.MAIL_ARCHIVE.get(key).then((item) => {
      if (expired) {
        void item?.body.cancel().catch(() => undefined);
        return null;
      }
      return item;
    });
    const item = await Promise.race([pending, deadline]);
    if (!item) return null;
    if (item.size > 24 * 1024) {
      await Promise.race([item.body.cancel().catch(() => undefined), Promise.resolve()]);
      return null;
    }
    reader = item.body.getReader();
    const bytes = new Uint8Array(item.size);
    let length = 0;
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Fixed byte and whole-stream bounds; never read mail-selected URLs.
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (part.value.byteLength > bytes.length - length) return null;
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    if (length !== bytes.length) return null;
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (digest !== key.split("/").at(-1)) return null;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } finally {
    expired = true;
    if (timer !== undefined) clearTimeout(timer);
    if (reader) {
      await Promise.race([reader.cancel().catch(() => undefined), Promise.resolve()]);
      reader.releaseLock();
    }
  }
}
function candidates(body: string, limit: number): string[] {
  const values: string[] = [];
  const pattern =
    /(?:password|passcode|パスワード|解凍キー|復号キー)\s*(?::|：|=|は|is)\s*[「『"']?([^\s「」『』"'<>]{1,128})/giu;
  for (const match of body.matchAll(pattern)) {
    const original = match[1]!;
    for (const value of [original, original.replace(/[。．.,;；]+$/u, "")]) {
      if (value && !values.includes(value) && values.length < limit) values.push(value);
    }
    if (values.length >= limit) break;
  }
  return values;
}

/** Password guesses are ephemeral data. A related-mail hint is never proof: the
 * caller must verify actual cryptographic decryption before retaining a derivative. */
export async function resolveAttachmentPasswords(
  env: PasswordEnvironment,
  input: { rawKey: string; attachmentSha256: string; limit: 8 },
): Promise<readonly string[]> {
  if (input.limit !== 8 || !/^[a-f0-9]{64}$/.test(input.attachmentSha256)) return [];
  const source =
    await env.MAIL_CATALOG.prepare(`SELECT s.raw_key,s.raw_sha256,s.source_namespace,s.source_kind,s.received_at,
    e.metadata_json,e.attachments_json,e.body_text_key,e.manifest_key FROM archive_sources s JOIN mail_extractions e ON e.raw_key=s.raw_key
    WHERE s.raw_key=? AND s.raw_state='present' AND e.raw_sha256=s.raw_sha256 AND e.extractor_version='mime-v1' AND e.status='complete'`)
      .bind(input.rawKey)
      .first<PasswordSource>();
  if (!source || source.attachments_json.length > 32 * 1024) return [];
  const selected = metadata(source.metadata_json);
  if (!selected) return [];
  const identity = participants(selected);
  if (!identity) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(source.attachments_json) as unknown;
  } catch {
    return [];
  }
  const files = v.safeParse(
    v.array(v.object({ sha256: v.string(), filename: v.optional(v.nullable(v.string())) })),
    decoded,
  );
  if (!files.success) return [];
  const attachment = files.output.find((x) => x.sha256 === input.attachmentSha256);
  if (!attachment) return [];
  const timestamp = Date.parse(source.received_at ?? "");
  if (!Number.isFinite(timestamp)) return [];
  const before = new Date(timestamp + 30 * 86400_000).toISOString();
  const after = new Date(timestamp - 30 * 86400_000).toISOString();
  const rows =
    await env.MAIL_CATALOG.prepare(`SELECT s.raw_key,s.raw_sha256,s.source_namespace,s.source_kind,s.received_at,
    e.metadata_json,e.attachments_json,e.body_text_key,e.manifest_key FROM archive_sources s JOIN mail_extractions e ON e.raw_key=s.raw_key
    WHERE s.source_namespace=? AND s.source_kind=? AND s.raw_state='present' AND s.received_at BETWEEN ? AND ?
    AND s.raw_sha256=e.raw_sha256 AND e.extractor_version='mime-v1' AND e.status='complete' AND e.body_text_key IS NOT NULL
    AND CASE WHEN json_valid(e.metadata_json) THEN lower(json_extract(e.metadata_json,'$.from.address')) ELSE NULL END=?
    ORDER BY CASE WHEN s.raw_key=? THEN 0 ELSE 1 END,ABS(julianday(s.received_at)-julianday(?)),s.raw_key LIMIT 12`)
      .bind(
        source.source_namespace,
        source.source_kind,
        after,
        before,
        selected.from!.address.toLowerCase(),
        input.rawKey,
        source.received_at,
      )
      .all<PasswordSource>();
  const related = ids(selected);
  const result: string[] = [];
  const started = Date.now();
  let reads = 0;
  for (const row of rows.results) {
    if (Date.now() - started >= 4000 || reads >= 4 || result.length >= 8) break;
    const other = metadata(row.metadata_json);
    if (!other || participants(other) !== identity || !row.body_text_key) continue;
    const threadMatch = [...ids(other)].some((id) => related.has(id));
    const subjectMatch =
      !!subject(selected.subject) && subject(other.subject) === subject(selected.subject);
    const same = row.raw_key === source.raw_key;
    const filename = attachment.filename;
    if (
      !same &&
      !threadMatch &&
      !subjectMatch &&
      (!filename || filename.length < 4 || filename.length > 256)
    )
      continue;
    reads++;
    let content: string | null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- At most four small verified bodies, bounded total lookup time.
      content = await text(env, row.body_text_key);
    } catch {
      continue;
    }
    if (!content || (!same && !threadMatch && !subjectMatch && !content.includes(filename!)))
      continue;
    for (const value of candidates(content, 8 - result.length))
      if (!result.includes(value)) result.push(value);
  }
  // A replaced/removed source cannot carry a result into a stale extraction job.
  const current =
    await env.MAIL_CATALOG.prepare(`SELECT 1 FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
    WHERE e.raw_key=? AND e.status='complete' AND e.manifest_key=? AND e.raw_sha256=? AND s.raw_sha256=e.raw_sha256 AND s.raw_state='present'`)
      .bind(source.raw_key, source.manifest_key, source.raw_sha256)
      .first();
  return current ? result : [];
}
