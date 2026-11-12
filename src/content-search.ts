import { MailReadError, parseMailSearch, type MailReadEnvironment } from "./mail-read.ts";
import { hasScope, type MailPrincipal } from "./principal.ts";

const VERSION = "text-v2";
const CHUNK = 3500;
const OVERLAP = 200;
interface Extraction {
  raw_key: string;
  manifest_key: string;
  body_text_key: string | null;
  body_html_key: string | null;
  attachments_json: string;
}
interface Part {
  index: number;
  mimeType: string;
  key: string;
  size: number;
  sha256: string;
}
interface Chunk {
  part: string;
  ordinal: number;
  text: string;
  sha256: string;
  original_sha256?: string;
  representation?: string;
  source_part?: string;
}
interface Conversion {
  part_index: number;
  state: string;
  failure_code: string | null;
  result_key: string | null;
  result_sha256: string | null;
  source_sha256: string;
  representation: string | null;
  policy_hash: string;
}
class UnsupportedEncoding extends Error {}

async function verifiedText(bucket: R2Bucket, key: string, digest: string, maximum: number) {
  const object = await bucket.get(key);
  if (!object) throw new Error("Search source unavailable");
  if (object.size > maximum) {
    await object.body.cancel();
    throw new Error("Search source exceeds bound");
  }
  const bytes = await object.arrayBuffer();
  const actual = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (actual !== digest) throw new Error("Search source changed");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new UnsupportedEncoding("Unsupported text encoding");
  }
}
function chunks(text: string, part: string, sha256: string): Chunk[] {
  const result: Chunk[] = [];
  for (let start = 0; start < text.length; start += CHUNK - OVERLAP) {
    result.push({ part, ordinal: result.length, text: text.slice(start, start + CHUNK), sha256 });
    if (start + CHUNK >= text.length) break;
  }
  return result;
}

/** Bounded rebuild from immutable MIME derivatives; never fetches message URLs. */
export async function indexMailContent(env: MailReadEnvironment, source: Extraction) {
  const entries: Chunk[] = [];
  const omitted: string[] = [];
  if (source.body_text_key) {
    const digest = source.body_text_key.split("/").at(-1)!;
    const text = await verifiedText(
      env.MAIL_ARCHIVE,
      source.body_text_key,
      digest,
      6 * 1024 * 1024,
    );
    entries.push(...chunks(text.slice(0, 100_000), "body", digest));
    if (text.length > 100_000) omitted.push("body_truncated");
  } else if (source.body_html_key) omitted.push("html_only_body");
  const attachments = JSON.parse(source.attachments_json) as Part[];
  const conversions = (
    await env.MAIL_CATALOG.prepare(
      "SELECT part_index,state,failure_code,result_key,result_sha256,source_sha256,representation,policy_hash FROM attachment_conversions WHERE raw_key=? AND manifest_key=? ORDER BY part_index",
    )
      .bind(source.raw_key, source.manifest_key)
      .all<Conversion>()
  ).results;
  const conversionSnapshot = JSON.stringify(
    conversions.map((c) => [c.part_index, c.state, c.result_sha256, c.policy_hash]),
  );
  let selected = 0;
  let derivedSelected = 0;
  let derivedCharacters = 0;
  for (const part of attachments) {
    if (part.mimeType !== "text/plain") {
      const converted = conversions.find(
        (c) => c.part_index === part.index && c.source_sha256 === part.sha256,
      );
      if (converted?.state === "complete" && converted.result_key && converted.result_sha256) {
        if (
          ["local_zip_manifest", "local_decrypted_pdf"].includes(converted.representation ?? "")
        ) {
          omitted.push(`part_${part.index}:derivative_available_without_searchable_text`);
          continue;
        }
        if (derivedSelected >= 4 || derivedCharacters >= 64000) {
          omitted.push(`part_${part.index}:derivative_search_count_or_character_limit`);
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- At most four immutable, bounded derivative objects per message.
        const text = await verifiedText(
          env.MAIL_ARCHIVE,
          converted.result_key,
          converted.result_sha256,
          256 * 1024,
        );
        const projected = text.slice(0, 64000 - derivedCharacters);
        entries.push(
          ...chunks(projected, `converted_${part.index}`, converted.result_sha256).map((chunk) => ({
            ...chunk,
            original_sha256: part.sha256,
            representation: converted.representation ?? "derived_text",
            source_part: `part_${part.index}`,
          })),
        );
        derivedSelected++;
        derivedCharacters += projected.length;
        if (projected.length < text.length)
          omitted.push(`part_${part.index}:derivative_search_truncated`);
      } else
        omitted.push(
          `part_${part.index}:${converted?.failure_code ?? converted?.state ?? "conversion_not_enabled_or_pending"}`,
        );
      continue;
    }
    if (part.size > 64 * 1024 || selected >= 8) {
      omitted.push(`part_${part.index}:size_or_count_limit`);
      continue;
    }
    selected += 1;
    let text: string;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep attachment reads sequential and bounded.
      text = await verifiedText(env.MAIL_ARCHIVE, part.key, part.sha256, 64 * 1024);
    } catch (error) {
      if (!(error instanceof UnsupportedEncoding)) throw error;
      omitted.push(`part_${part.index}:unsupported_encoding`);
      continue;
    }
    entries.push(...chunks(text.slice(0, 16_000), `part_${part.index}`, part.sha256));
    if (text.length > 16_000) omitted.push(`part_${part.index}:truncated`);
  }
  const db = env.MAIL_CATALOG.withSession("first-primary");
  const guard = `EXISTS (SELECT 1 FROM mail_extractions WHERE raw_key=? AND extractor_version='mime-v1' AND status='complete' AND manifest_key=?) AND (SELECT json_group_array(json_array(part_index,state,result_sha256,policy_hash)) FROM (SELECT part_index,state,result_sha256,policy_hash FROM attachment_conversions WHERE raw_key=? AND manifest_key=? ORDER BY part_index))=?`;
  const guardValues = [
    source.raw_key,
    source.manifest_key,
    source.raw_key,
    source.manifest_key,
    conversionSnapshot,
  ];
  const coverage = JSON.stringify({
    version: VERSION,
    omitted,
    chunks: entries.length,
    conversions: conversions.map((c) => ({
      part: `part_${c.part_index}`,
      state: c.state,
      failure_code: c.failure_code,
      representation: c.representation,
    })),
  });
  // Every mutation uses the same extraction fence. D1 batches commit atomically.
  await db.batch([
    db
      .prepare(`DELETE FROM mail_search_chunks WHERE raw_key=? AND ${guard}`)
      .bind(source.raw_key, ...guardValues),
    ...entries.map((entry) =>
      db
        .prepare(
          `INSERT INTO mail_search_chunks(raw_key,part,ordinal,text,sha256,original_sha256,representation,source_part) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`,
        )
        .bind(
          source.raw_key,
          entry.part,
          entry.ordinal,
          entry.text,
          entry.sha256,
          entry.original_sha256 ?? entry.sha256,
          entry.representation ?? "original_text",
          entry.source_part ?? entry.part,
          ...guardValues,
        ),
    ),
    db
      .prepare(`INSERT INTO mail_search_documents(raw_key,manifest_key,status,coverage_json,next_attempt_at) SELECT ?,?,'ready',?,0 WHERE ${guard}
      ON CONFLICT(raw_key) DO UPDATE SET manifest_key=excluded.manifest_key,status='ready',coverage_json=excluded.coverage_json,next_attempt_at=0`)
      .bind(source.raw_key, source.manifest_key, coverage, ...guardValues),
  ]);
}

export async function repairContentSearch(env: MailReadEnvironment, now = Date.now()) {
  const rows = (
    await env.MAIL_CATALOG.prepare(`SELECT e.raw_key,e.manifest_key,e.body_text_key,e.body_html_key,e.attachments_json
    FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
    LEFT JOIN mail_search_documents d ON d.raw_key=e.raw_key
    WHERE s.raw_state='present' AND e.status='complete' AND (d.raw_key IS NULL OR d.manifest_key!=e.manifest_key OR (d.status='retry' AND d.next_attempt_at<=?))
    ORDER BY CASE s.source_kind WHEN 'email_routing' THEN 0 ELSE 1 END,COALESCE(d.next_attempt_at,0),e.raw_key LIMIT 3`)
      .bind(now)
      .all<Extraction>()
  ).results;
  let indexed = 0;
  let deferred = 0;
  for (const row of rows) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Bound decoded mail memory to one message.
      await indexMailContent(env, row);
      indexed += 1;
    } catch {
      deferred += 1;
      // oxlint-disable-next-line no-await-in-loop -- Persist a fixed retry outcome before continuing.
      await env.MAIL_CATALOG.prepare(`INSERT INTO mail_search_documents(raw_key,manifest_key,status,coverage_json,next_attempt_at)
        SELECT ?,?,'retry','{}',? WHERE EXISTS (SELECT 1 FROM mail_extractions WHERE raw_key=? AND status='complete' AND manifest_key=?)
        ON CONFLICT(raw_key) DO UPDATE SET next_attempt_at=excluded.next_attempt_at
        WHERE mail_search_documents.status='retry' AND mail_search_documents.manifest_key=excluded.manifest_key`)
        .bind(row.raw_key, row.manifest_key, now + 300_000, row.raw_key, row.manifest_key)
        .run();
    }
  }
  return { indexed, deferred };
}

interface SearchInput {
  query: string;
  filters?: string | undefined;
  max_results?: number | undefined;
  next_page_token?: string | undefined;
}
function excerpt(text: string, query: string, fallback: string) {
  const at = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(text)?.index ?? -1;
  if (at < 0) return fallback.slice(0, 1000);
  const start = Math.max(0, at - 150);
  const end = Math.min(text.length, at + query.length + 150);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
export async function searchMailContent(
  env: MailReadEnvironment,
  principal: MailPrincipal,
  input: SearchInput,
  base: string,
) {
  if (!hasScope(principal, "mail:read")) throw new MailReadError("forbidden");
  const query = input.query.trim();
  if ([...query].length < 3 || query.length > 200 || [...query].some((c) => c.charCodeAt(0) < 32))
    throw new MailReadError("invalid_content_query");
  const limit = input.max_results ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new MailReadError("invalid_limit");
  const filter = input.filters ?? "";
  const parsed = parseMailSearch(filter);
  let before = Number.MAX_SAFE_INTEGER;
  if (input.next_page_token) {
    try {
      if (input.next_page_token.length > 8192) throw new Error();
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          Uint8Array.from(atob(input.next_page_token), (c) => c.charCodeAt(0)),
        ),
      ) as { before: number; query: string; filter: string };
      if (
        !Number.isSafeInteger(value.before) ||
        value.before < 1 ||
        value.query !== query ||
        value.filter !== filter
      )
        throw new Error();
      before = value.before;
    } catch {
      throw new MailReadError("invalid_page_token");
    }
  }
  const rows = (
    await env.MAIL_CATALOG.prepare(`SELECT c.id,s.external_id,c.part,c.ordinal,c.sha256,c.text,c.original_sha256,c.representation,c.source_part,
    snippet(mail_search_fts,0,'','','…',48) AS excerpt,d.coverage_json
    FROM mail_search_fts JOIN mail_search_chunks c ON c.id=mail_search_fts.rowid
    JOIN mail_search_documents d ON d.raw_key=c.raw_key AND d.status='ready'
    JOIN archive_sources s ON s.raw_key=c.raw_key
    JOIN mail_extractions e ON e.raw_key=c.raw_key AND e.extractor_version='mime-v1' AND e.status='complete' AND e.manifest_key=d.manifest_key
    WHERE mail_search_fts MATCH ? AND c.id<? ${parsed.clauses.length ? `AND ${parsed.clauses.join(" AND ")}` : ""}
    ORDER BY c.id DESC LIMIT ?`)
      .bind(`"${query.replaceAll('"', '""')}"`, before, ...parsed.values, limit + 1)
      .all<{
        id: number;
        external_id: string;
        part: string;
        ordinal: number;
        sha256: string;
        original_sha256: string | null;
        representation: string | null;
        source_part: string | null;
        text: string;
        excerpt: string;
        coverage_json: string;
      }>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const coverage = await env.MAIL_CATALOG.prepare(`SELECT
    COUNT(*) AS extracted_messages,
    SUM(CASE WHEN d.status='ready' AND d.manifest_key=e.manifest_key THEN 1 ELSE 0 END) AS indexed_messages
    FROM mail_extractions e LEFT JOIN mail_search_documents d ON d.raw_key=e.raw_key WHERE e.status='complete'`).first();
  return {
    matches: page.map((row) => ({
      message_id: `mail_${row.external_id}`,
      excerpt: excerpt(row.text, query, row.excerpt),
      citation: {
        part: row.part,
        chunk: row.ordinal,
        sha256: row.sha256,
        representation: row.representation ?? "original_text",
        original_sha256: row.original_sha256 ?? row.sha256,
        original_file_uri: new URL(
          `/api/mail/mail_${encodeURIComponent(row.external_id)}/${row.part === "body" ? "text" : `attachments/${row.source_part ?? row.part}`}`,
          base,
        ).href,
        file_uri: new URL(
          `/api/mail/mail_${encodeURIComponent(row.external_id)}/${row.part.startsWith("converted_") ? `conversions/${row.source_part}/${row.sha256}` : row.part === "body" ? "text" : `attachments/${row.part}`}`,
          base,
        ).href,
      },
      coverage: JSON.parse(row.coverage_json) as Record<string, unknown>,
    })),
    next_page_token:
      rows.length > limit && last
        ? btoa(
            String.fromCharCode(
              ...new TextEncoder().encode(JSON.stringify({ before: last.id, query, filter })),
            ),
          )
        : null,
    coverage: {
      version: VERSION,
      ...coverage,
      searches: "bounded_plain_text_utf8_attachments_and_completed_derivatives",
      pending_and_unsupported_content_excluded: true,
      semantic_search: false,
    },
  };
}
