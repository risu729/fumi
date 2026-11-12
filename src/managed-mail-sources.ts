import type { ManagedMailEnvironment } from "./managed-search-runtime.ts";

/** The attachment adapter is independently optional; no missing-table exception means disabled coverage. */
export async function hasManagedAttachmentSources(env: ManagedMailEnvironment) {
  return !!(await env.MAIL_CATALOG.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_conversions'",
  ).first());
}
export function managedSourceFence(attachments: boolean, alias = "managed_mail_documents") {
  const d = alias;
  const converted = attachments
    ? `OR (${d}.part GLOB 'part_[0-9]*' AND EXISTS(SELECT 1 FROM attachment_conversions a,json_each(e.attachments_json) p
    WHERE a.raw_key=e.raw_key AND a.part_index=CAST(substr(${d}.part,6) AS INTEGER) AND a.state='complete' AND a.manifest_key=e.manifest_key
    AND a.result_key=${d}.text_key AND a.result_sha256=${d}.text_sha256 AND a.source_key=${d}.original_key
    AND a.source_sha256=${d}.original_sha256 AND a.mime_sha256=e.raw_sha256 AND a.policy_hash=${d}.conversion_policy AND a.representation=${d}.representation
    AND a.representation IN ('managed_document_text','managed_ocr_indexed_text','local_zip_text')
    AND json_extract(p.value,'$.index')=a.part_index AND json_extract(p.value,'$.key')=a.source_key
    AND json_extract(p.value,'$.sha256')=a.source_sha256 AND json_extract(p.value,'$.size')=a.source_size
    AND json_extract(p.value,'$.mimeType')=a.source_mime))`
    : "";
  return `EXISTS(SELECT 1 FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
    WHERE e.raw_key=${d}.raw_key AND e.extractor_version='mime-v1' AND e.status='complete' AND e.manifest_key=${d}.manifest_key
    AND e.raw_sha256=${d}.raw_sha256 AND s.raw_state='present' AND s.raw_sha256=e.raw_sha256
    AND ((${d}.part='body' AND e.body_text_key=${d}.text_key AND ${d}.text_key=${d}.original_key AND ${d}.text_sha256=${d}.original_sha256) ${converted}))`;
}
export interface ManagedAttachmentSource {
  part_index: number;
  source_key: string;
  source_sha256: string;
  result_key: string;
  result_sha256: string;
  representation: string;
  policy_hash: string;
}
export function attachmentMembership(a = "a", e = "e") {
  return `(${a}.mime_sha256=${e}.raw_sha256 AND EXISTS(SELECT 1 FROM json_each(${e}.attachments_json) p WHERE json_extract(p.value,'$.index')=${a}.part_index
    AND json_extract(p.value,'$.key')=${a}.source_key AND json_extract(p.value,'$.sha256')=${a}.source_sha256
    AND json_extract(p.value,'$.size')=${a}.source_size AND json_extract(p.value,'$.mimeType')=${a}.source_mime))`;
}
/** Projection of the attachment adapter's stable current-source contract; never enables conversion. */
export async function managedAttachmentSources(env: ManagedMailEnvironment, rawKey: string) {
  return (
    await env.MAIL_CATALOG.prepare(`SELECT a.part_index,a.source_key,a.source_sha256,a.result_key,a.result_sha256,a.representation,a.policy_hash
    FROM attachment_conversions a JOIN mail_extractions e ON e.raw_key=a.raw_key JOIN archive_sources s ON s.raw_key=e.raw_key
    WHERE a.raw_key=? AND a.state='complete' AND s.raw_state='present' AND e.status='complete' AND e.manifest_key=a.manifest_key
    AND a.representation IN ('managed_document_text','managed_ocr_indexed_text','local_zip_text')
    AND ${attachmentMembership()}
    ORDER BY a.part_index LIMIT 4`)
      .bind(rawKey)
      .all<ManagedAttachmentSource>()
  ).results;
}
