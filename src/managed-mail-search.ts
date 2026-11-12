/* oxlint-disable no-await-in-loop -- Serial bounded source reads and durable leases prevent memory spikes and duplicate provider calls. */
import { parseMailSearch } from "./mail-read.ts";
import { hasScope, type MailPrincipal } from "./principal.ts";
import { managedSourceFence, hasManagedAttachmentSources } from "./managed-mail-sources.ts";
import {
  bounded,
  managedMailRuntime,
  managedSourceScope,
  ManagedSearchError,
  readManagedText,
  record,
  reserveManagedCall,
  verifyManagedInstance,
  type ManagedMailEnvironment,
} from "./managed-search-runtime.ts";

interface SearchInput {
  query: string;
  mode?: "semantic" | "hybrid" | undefined;
  max_results?: number | undefined;
  filters?: string | undefined;
  archive_source?: "all" | "gmail" | "email_routing" | undefined;
  label_ids?: string[] | null | undefined;
}
interface Candidate {
  external_id: string;
  text_key: string;
  text_sha256: string;
  raw_sha256: string;
  manifest_key: string;
  raw_key: string;
  part: string;
  original_sha256: string;
  representation: string;
  conversion_policy: string | null;
}
/** Returns retrieved evidence only. Remote text must occur verbatim in the verified local source. */
export async function searchManagedMail(
  env: ManagedMailEnvironment,
  principal: MailPrincipal,
  args: SearchInput,
  base: string,
) {
  if (!hasScope(principal, "mail:read")) throw new ManagedSearchError("forbidden");
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 1000)
    throw new ManagedSearchError("invalid_query");
  const limit = args.max_results ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new ManagedSearchError("invalid_limit");
  const mode = args.mode ?? "hybrid";
  if (!["semantic", "hybrid"].includes(mode)) throw new ManagedSearchError("invalid_search_mode");
  const parsed = parseMailSearch(args.filters ?? "");
  const source = args.archive_source ?? "all",
    labels = [...new Set(args.label_ids ?? [])].sort();
  if (
    !["all", "gmail", "email_routing"].includes(source) ||
    labels.length > 10 ||
    labels.some((label) => !/^[A-Za-z0-9_-]{1,128}$/.test(label))
  )
    throw new ManagedSearchError("invalid_search_filter");
  const runtime = await managedMailRuntime(env);
  if (!runtime) throw new ManagedSearchError("managed_search_not_configured");
  if (mode === "hybrid" && !runtime.config.hybrid)
    throw new ManagedSearchError("managed_hybrid_search_disabled");
  await verifyManagedInstance(runtime, mode === "hybrid");
  await reserveManagedCall(env, runtime, "query", crypto.randomUUID());
  let response: Record<string, unknown>;
  try {
    response = record(
      await bounded(() =>
        runtime.binding.search({
          query: args.query,
          ai_search_options: {
            retrieval: {
              retrieval_type: mode === "semantic" ? "vector" : "hybrid",
              max_num_results: Math.min(30, limit * 3),
              context_expansion: 0,
              metadata_only: false,
              return_on_failure: false,
            },
            query_rewrite: { enabled: false },
            reranking: { enabled: false },
            cache: { enabled: false },
          },
        }),
      ),
    );
  } catch {
    throw new ManagedSearchError("managed_search_unavailable");
  }
  const chunks = response["chunks"];
  if (!Array.isArray(chunks) || chunks.length > 30)
    throw new ManagedSearchError("invalid_search_provider_response");
  const attachments = await hasManagedAttachmentSources(env);
  const scope = managedSourceScope(runtime, "d.raw_key");
  const clauses = [
    "d.item_key=?",
    "d.policy_hash=?",
    "d.state='ready'",
    managedSourceFence(attachments, "d"),
    scope.sql,
    ...parsed.clauses,
  ];
  const filters: (string | number)[] = [...scope.values, ...parsed.values];
  if (source !== "all") {
    clauses.push("s.source_kind=?");
    filters.push(source);
  }
  for (const label of labels) {
    clauses.push(
      "((s.source_kind='email_routing' AND ?='INBOX') OR (s.source_kind='gmail' AND EXISTS(SELECT 1 FROM json_each(COALESCE(g.label_ids_json,'[]')) WHERE value=?)))",
    );
    filters.push(label, label);
  }
  const matches = [];
  let omitted = 0,
    verifiedSources = 0;
  const seen = new Set<string>();
  for (const value of chunks) {
    const chunk = record(value),
      item = record(chunk["item"]);
    if (
      typeof chunk["id"] !== "string" ||
      chunk["id"].length > 128 ||
      typeof item["key"] !== "string" ||
      item["key"].length > 128 ||
      typeof chunk["text"] !== "string" ||
      !chunk["text"].trim() ||
      chunk["text"].length > 32768 ||
      typeof chunk["score"] !== "number" ||
      !Number.isFinite(chunk["score"]) ||
      chunk["score"] < 0 ||
      chunk["score"] > 1
    )
      throw new ManagedSearchError("invalid_search_provider_response");
    if (seen.has(item["key"])) continue;
    seen.add(item["key"]);
    const row =
      await env.MAIL_CATALOG.prepare(`SELECT s.external_id,d.text_key,d.text_sha256,d.raw_sha256,d.manifest_key,d.raw_key,
      d.part,d.original_sha256,d.representation,d.conversion_policy
      FROM managed_mail_documents d JOIN mail_extractions e ON e.raw_key=d.raw_key JOIN archive_sources s ON s.raw_key=d.raw_key
      LEFT JOIN gmail_messages g ON g.raw_key=s.raw_key WHERE ${clauses.join(" AND ")}`)
        .bind(item["key"], runtime.policy, ...filters)
        .first<Candidate>();
    if (!row) {
      omitted++;
      continue;
    }
    if (verifiedSources >= 10) {
      omitted++;
      continue;
    }
    verifiedSources++;
    let text: string;
    try {
      const verified = await readManagedText(
        env.MAIL_ARCHIVE,
        row.text_key,
        row.text_sha256,
        row.part === "body" ? 1024 * 1024 : 256 * 1024,
      );
      text = verified.text;
    } catch {
      omitted++;
      continue;
    }
    if (!text.includes(chunk["text"])) {
      omitted++;
      continue;
    }
    // Recheck the current source after asynchronous byte verification; invalidated results are never returned.
    const current =
      await env.MAIL_CATALOG.prepare(`SELECT 1 FROM managed_mail_documents WHERE raw_key=? AND part=? AND manifest_key=?
      AND text_sha256=? AND policy_hash=? AND state='ready' AND ${managedSourceScope(runtime).sql} AND ${managedSourceFence(attachments)}`)
        .bind(
          row.raw_key,
          row.part,
          row.manifest_key,
          row.text_sha256,
          runtime.policy,
          ...scope.values,
        )
        .first();
    if (!current) {
      omitted++;
      continue;
    }
    const messageId = `mail_${row.external_id}`;
    matches.push({
      message_id: messageId,
      excerpt: JSON.parse(JSON.stringify(chunk["text"].slice(0, 800))) as string,
      score: chunk["score"],
      citation: {
        part: row.part,
        representation: row.representation,
        sha256: row.text_sha256,
        original_sha256: row.original_sha256,
        raw_sha256: row.raw_sha256,
        file_uri: new URL(
          `/api/mail/${encodeURIComponent(messageId)}/${row.part === "body" ? "text" : `conversions/${row.part}/${row.text_sha256}`}`,
          base,
        ).href,
        original_file_uri: new URL(
          `/api/mail/${encodeURIComponent(messageId)}/${row.part === "body" ? "text" : `attachments/${row.part}`}`,
          base,
        ).href,
        raw_file_uri: new URL(`/api/mail/${encodeURIComponent(messageId)}/raw`, base).href,
        provider_chunk_id: chunk["id"],
      },
      mail_content_trust: "untrusted_data",
    });
    if (matches.length >= limit) break;
  }
  const coverage = (
    await env.MAIL_CATALOG.prepare(
      `SELECT state,COUNT(*) AS count FROM managed_mail_documents WHERE policy_hash=? AND ${managedSourceScope(runtime).sql} AND ${managedSourceFence(attachments)} GROUP BY state`,
    )
      .bind(runtime.policy, ...scope.values)
      .all<{ state: string; count: number }>()
  ).results;
  return {
    matches,
    next_page_token: null,
    coverage: {
      mode,
      corpus: "verified_mime_bodies_and_completed_attachment_text",
      body_byte_limit: 1024 * 1024,
      attachment_byte_limit: 256 * 1024,
      documents: coverage,
      omitted_candidates: omitted,
      ranked_candidates: chunks.length,
      verified_sources: verifiedSources,
      candidate_limit: Math.min(30, limit * 3),
      postfiltered_top_candidates: true,
      exhaustive: false,
      source_scope: runtime.config.sourceRawKeys ? "administrator_allowlist" : "archive",
      pagination_supported: false,
      attachment_derivatives_enabled: attachments,
      attachment_limit_per_message: 4,
      binary_attachments_included: false,
      html_only_bodies_included: false,
      query_rewriting: false,
      answer_generation: false,
      local_source_citations_verified: true,
      mail_content_trust: "untrusted_data",
    },
  };
}
