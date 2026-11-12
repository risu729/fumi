/* oxlint-disable no-await-in-loop -- Serial bounded source reads and durable leases prevent memory spikes and duplicate provider calls. */
import * as v from "valibot";
import {
  BODY_LIMIT,
  bounded,
  hexDigest,
  managedMailRuntime,
  managedSourceScope,
  ManagedSearchError,
  readManagedText,
  record,
  verifyManagedInstance,
  type ManagedMailEnvironment,
  type ManagedMailRuntime,
} from "./managed-search-runtime.ts";
import {
  hasManagedAttachmentSources,
  managedAttachmentSources,
  managedSourceFence,
  attachmentMembership,
} from "./managed-mail-sources.ts";

interface Document {
  raw_key: string;
  part: string;
  manifest_key: string;
  raw_sha256: string;
  text_key: string;
  text_sha256: string;
  original_key: string;
  original_sha256: string;
  representation: string;
  conversion_policy: string | null;
  policy_hash: string;
  item_key: string;
  item_id: string | null;
  state: string;
  submitted_at: number | null;
}
async function discover(
  env: ManagedMailEnvironment,
  runtime: ManagedMailRuntime,
  attachments: boolean,
  now: number,
) {
  const scope = managedSourceScope(runtime, "e.raw_key");
  const attachmentMissing = attachments
    ? `OR EXISTS(SELECT 1 FROM attachment_conversions a WHERE a.raw_key=e.raw_key AND a.manifest_key=e.manifest_key
    AND a.state='complete' AND a.representation IN ('managed_document_text','managed_ocr_indexed_text','local_zip_text')
    AND ${attachmentMembership()}
    AND a.part_index IN (SELECT b.part_index FROM attachment_conversions b WHERE b.raw_key=e.raw_key AND b.manifest_key=e.manifest_key AND b.state='complete'
      AND b.representation IN ('managed_document_text','managed_ocr_indexed_text','local_zip_text') AND ${attachmentMembership("b")} ORDER BY b.part_index LIMIT 4)
    AND NOT EXISTS(SELECT 1 FROM managed_mail_documents d WHERE d.raw_key=e.raw_key AND d.part='part_'||a.part_index
      AND d.policy_hash=? AND d.text_sha256=a.result_sha256 AND d.conversion_policy=a.policy_hash))`
    : "";
  const rows = (
    await env.MAIL_CATALOG.prepare(`SELECT e.raw_key,e.manifest_key,e.raw_sha256,e.body_text_key FROM mail_extractions e
    JOIN archive_sources s ON s.raw_key=e.raw_key WHERE e.extractor_version='mime-v1' AND e.status='complete'
    AND s.raw_state='present' AND s.raw_sha256=e.raw_sha256 AND ${scope.sql} AND ((e.body_text_key IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM managed_mail_documents d WHERE d.raw_key=e.raw_key AND d.part='body' AND d.policy_hash=?)) ${attachmentMissing})
    ORDER BY e.raw_key LIMIT 3`)
      .bind(...scope.values, runtime.policy, ...(attachments ? [runtime.policy] : []))
      .all<{
        raw_key: string;
        manifest_key: string;
        raw_sha256: string;
        body_text_key: string | null;
      }>()
  ).results;
  for (const row of rows) {
    const parts: {
      part: string;
      key: string;
      sha: string;
      originalKey: string;
      originalSha: string;
      representation: string;
      conversionPolicy: string | null;
    }[] = [];
    if (row.body_text_key)
      parts.push({
        part: "body",
        key: row.body_text_key,
        sha: row.body_text_key.split("/").at(-1)!,
        originalKey: row.body_text_key,
        originalSha: row.body_text_key.split("/").at(-1)!,
        representation: "original_text",
        conversionPolicy: null,
      });
    if (attachments) {
      const converted = await managedAttachmentSources(env, row.raw_key);
      parts.push(
        ...converted.map((a) => ({
          part: `part_${a.part_index}`,
          key: a.result_key,
          sha: a.result_sha256,
          originalKey: a.source_key,
          originalSha: a.source_sha256,
          representation: a.representation,
          conversionPolicy: a.policy_hash,
        })),
      );
    }
    for (const part of parts) {
      const key = `fumi-text-${await hexDigest(new TextEncoder().encode(JSON.stringify([row.raw_key, row.raw_sha256, part.part, part.sha, runtime.policy])))}.txt`;
      // Attempt identities survive projection deletion, including a MIME retry returning the same bytes.
      const prior = await env.MAIL_CATALOG.prepare(
        "SELECT item_id,submitted_at FROM managed_mail_calls WHERE kind='upload' AND item_key=?",
      )
        .bind(key)
        .first<{ item_id: string | null; submitted_at: number | null }>();
      await env.MAIL_CATALOG.prepare(`INSERT INTO managed_mail_documents(raw_key,part,manifest_key,raw_sha256,text_key,text_sha256,
        original_key,original_sha256,representation,conversion_policy,policy_hash,item_key,state,failure_code,item_id,submitted_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_extractions e WHERE raw_key=? AND status='complete' AND manifest_key=? AND ${scope.sql})
        ON CONFLICT(raw_key,part) DO UPDATE SET manifest_key=excluded.manifest_key,raw_sha256=excluded.raw_sha256,text_key=excluded.text_key,
        text_sha256=excluded.text_sha256,original_key=excluded.original_key,original_sha256=excluded.original_sha256,
        representation=excluded.representation,conversion_policy=excluded.conversion_policy,policy_hash=excluded.policy_hash,
        item_key=excluded.item_key,item_id=excluded.item_id,state=excluded.state,failure_code=excluded.failure_code,lease_token=NULL,lease_until=0,next_attempt_at=0,
        submitted_at=excluded.submitted_at,updated_at=excluded.updated_at WHERE managed_mail_documents.policy_hash!=excluded.policy_hash
        OR managed_mail_documents.text_sha256!=excluded.text_sha256 OR managed_mail_documents.conversion_policy IS NOT excluded.conversion_policy`)
        .bind(
          row.raw_key,
          part.part,
          row.manifest_key,
          row.raw_sha256,
          part.key,
          part.sha,
          part.originalKey,
          part.originalSha,
          part.representation,
          part.conversionPolicy,
          runtime.policy,
          key,
          prior?.item_id ? "submitted" : prior ? "unknown" : "pending",
          prior && !prior.item_id ? "upload_prior_outcome_unknown" : null,
          prior?.item_id ?? null,
          prior?.submitted_at ?? null,
          now,
          row.raw_key,
          row.manifest_key,
          ...scope.values,
        )
        .run();
    }
  }
}
async function verifiedBody(env: ManagedMailEnvironment, row: Document) {
  const digest = row.manifest_key.split("/").at(-1)!;
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(row.text_sha256))
    throw new ManagedSearchError("invalid_managed_search_source");
  const manifestText = await readManagedText(
    env.MAIL_ARCHIVE,
    row.manifest_key,
    digest,
    128 * 1024,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText.text) as unknown;
  } catch {
    throw new ManagedSearchError("invalid_managed_search_source");
  }
  const ref = v.object({
    key: v.string(),
    sha256: v.string(),
    size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  });
  const manifest = v.safeParse(
    v.object({
      rawSha256: v.literal(row.raw_sha256),
      body: v.object({ text: v.nullable(ref) }),
      attachments: v.optional(
        v.array(v.object({ index: v.number(), key: v.string(), sha256: v.string() })),
        [],
      ),
    }),
    parsed,
  );
  if (!manifest.success) throw new ManagedSearchError("invalid_managed_search_source");
  let size: number | undefined;
  if (row.part === "body") {
    const text = manifest.output.body.text;
    if (!text || text.key !== row.text_key || text.sha256 !== row.text_sha256)
      throw new ManagedSearchError("invalid_managed_search_source");
    if (text.size > BODY_LIMIT) throw new ManagedSearchError("managed_search_body_limit");
    size = text.size;
  } else if (
    !manifest.output.attachments.some(
      (part) =>
        part.index === Number(row.part.slice(5)) &&
        part.key === row.original_key &&
        part.sha256 === row.original_sha256,
    )
  )
    throw new ManagedSearchError("invalid_managed_search_source");
  return readManagedText(
    env.MAIL_ARCHIVE,
    row.text_key,
    row.text_sha256,
    row.part === "body" ? BODY_LIMIT : 256 * 1024,
    size,
  );
}
/** Explicit opt-in uploads only current verified MIME body text. Unknown uploads never replay automatically. */
export async function repairManagedMailCorpus(env: ManagedMailEnvironment, now = Date.now()) {
  const runtime = await managedMailRuntime(env);
  if (!runtime) return { enabled: false, processed: 0 };
  await verifyManagedInstance(runtime, runtime.config.hybrid);
  const attachments = await hasManagedAttachmentSources(env),
    fence = managedSourceFence(attachments),
    scope = managedSourceScope(runtime);
  await env.MAIL_CATALOG.prepare(
    `DELETE FROM managed_mail_documents WHERE ${scope.sql} AND NOT ${fence}`,
  )
    .bind(...scope.values)
    .run();
  await discover(env, runtime, attachments, now);
  await env.MAIL_CATALOG.prepare(
    `UPDATE managed_mail_documents SET state='unknown',failure_code='upload_outcome_unknown',lease_token=NULL,lease_until=0 WHERE ${scope.sql} AND state='uploading' AND lease_until<=?`,
  )
    .bind(...scope.values, now)
    .run();
  const rows = (
    await env.MAIL_CATALOG.prepare(`SELECT * FROM managed_mail_documents WHERE policy_hash=? AND state IN ('pending','submitted')
    AND next_attempt_at<=? AND lease_until<=? AND ${scope.sql} AND ${fence}
    ORDER BY CASE WHEN state='submitted' THEN 0 ELSE 1 END,next_attempt_at,raw_key,part LIMIT 2`)
      .bind(runtime.policy, now, now, ...scope.values)
      .all<Document>()
  ).results;
  let processed = 0;
  for (const row of rows) {
    const token = crypto.randomUUID(),
      claimTime = Math.max(now, Date.now());
    const claim =
      await env.MAIL_CATALOG.prepare(`UPDATE managed_mail_documents SET lease_token=?,lease_until=? WHERE raw_key=? AND part=? AND policy_hash=?
      AND state=? AND state IN ('pending','submitted') AND next_attempt_at<=? AND lease_until<=? AND ${scope.sql} AND ${fence}`)
        .bind(
          token,
          claimTime + 30000,
          row.raw_key,
          row.part,
          runtime.policy,
          row.state,
          claimTime,
          claimTime,
          ...scope.values,
        )
        .run();
    if (claim.meta.changes !== 1) continue;
    processed++;
    await processDocument(env, runtime, row, token, now, fence);
  }
  return { enabled: true, processed, attachment_derivatives_enabled: attachments };
}
async function processDocument(
  env: ManagedMailEnvironment,
  runtime: ManagedMailRuntime,
  row: Document,
  token: string,
  now: number,
  fence: string,
) {
  if (runtime.config.sourceRawKeys && !runtime.config.sourceRawKeys.includes(row.raw_key)) return;
  const scope = managedSourceScope(runtime);
  const owned = `raw_key=? AND part=? AND policy_hash=? AND lease_token=? AND ${scope.sql} AND ${fence}`;
  const values = [row.raw_key, row.part, runtime.policy, token, ...scope.values];
  const update = (sql: string, ...args: (string | number | null)[]) =>
    env.MAIL_CATALOG.prepare(`UPDATE managed_mail_documents SET ${sql} WHERE ${owned}`)
      .bind(...args, ...values)
      .run();
  let uploadStarted = false;
  try {
    if (row.state === "submitted") {
      if (!row.item_id || row.submitted_at === null)
        throw new ManagedSearchError("invalid_search_provider_response");
      if (now - row.submitted_at > 86400000)
        throw new ManagedSearchError("managed_search_indexing_timeout");
      const info = record(await bounded(() => runtime.binding.items.get(row.item_id!).info()));
      if (info["id"] !== row.item_id || info["key"] !== row.item_key)
        throw new ManagedSearchError("invalid_search_provider_response");
      if (["queued", "running"].includes(String(info["status"]))) {
        await update("lease_token=NULL,lease_until=0,next_attempt_at=?", now + 300000);
        return;
      }
      if (info["status"] !== "completed")
        throw new ManagedSearchError("managed_search_indexing_failed");
      await update(
        "state='ready',failure_code=NULL,lease_token=NULL,lease_until=0,updated_at=?",
        now,
      );
      return;
    }
    const body = await verifiedBody(env, row);
    if (!body.text.trim()) throw new ManagedSearchError("managed_search_empty_body");
    const guard = `${owned} AND state='pending' AND lease_until>?`;
    const reserved = await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare(`INSERT OR IGNORE INTO managed_mail_calls(call_id,policy_hash,kind,created_at,item_key) SELECT ?,?,'upload',?,?
        FROM managed_mail_documents WHERE ${guard}
        AND (SELECT COUNT(*) FROM managed_mail_calls WHERE policy_hash=? AND kind='upload')<?`).bind(
        token,
        runtime.policy,
        now,
        row.item_key,
        ...values,
        Date.now(),
        runtime.policy,
        runtime.config.maxUploads,
      ),
      // The source-fenced reservation and state change share this atomic D1 batch.
      env.MAIL_CATALOG.prepare(`UPDATE managed_mail_documents SET state='uploading',updated_at=?
        WHERE ${owned} AND state='pending'
        AND EXISTS(SELECT 1 FROM managed_mail_calls WHERE call_id=?)`).bind(now, ...values, token),
    ]);
    if (reserved[0]!.meta.changes !== 1 || reserved[1]!.meta.changes !== 1)
      throw new ManagedSearchError("managed_search_budget_exhausted");
    uploadStarted = true;
    const result = record(
      await bounded(() =>
        runtime.binding.items.upload(
          row.item_key,
          new Blob([body.bytes], { type: "text/plain;charset=utf-8" }),
        ),
      ),
    );
    const itemId = result["id"];
    if (
      typeof itemId !== "string" ||
      !/^[\w-]{1,128}$/.test(itemId) ||
      result["key"] !== row.item_key
    )
      throw new ManagedSearchError("invalid_search_provider_response");
    await env.MAIL_CATALOG.prepare(
      "UPDATE managed_mail_calls SET item_id=?,submitted_at=? WHERE call_id=? AND item_key=?",
    )
      .bind(itemId, now, token, row.item_key)
      .run();
    await update(
      "state='submitted',item_id=?,submitted_at=?,next_attempt_at=?,lease_token=NULL,lease_until=0,updated_at=?",
      itemId,
      now,
      now + 300000,
      now,
    );
  } catch (error) {
    const code = error instanceof ManagedSearchError ? error.code : "managed_search_unavailable";
    const retry =
      !uploadStarted &&
      ["managed_search_unavailable", "managed_search_source_unavailable"].includes(code);
    await update(
      "state=?,failure_code=?,lease_token=NULL,lease_until=0,next_attempt_at=?,updated_at=?",
      uploadStarted ? "unknown" : retry ? row.state : "blocked",
      uploadStarted ? "upload_outcome_unknown" : code,
      now + 300000,
      now,
    );
  }
}
