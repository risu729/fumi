import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repairContentSearch, searchMailContent, indexMailContent } from "../src/content-search.ts";
import { dispatchMailTool } from "../src/mcp.ts";
import { readMailResource } from "../src/mail-read.ts";
import type { MailPrincipal } from "../src/principal.ts";

const reader: MailPrincipal = { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] };
const base = "https://mail.example.invalid";
async function object(text: string) {
  const bytes = new TextEncoder().encode(text);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const key = `synthetic/search/${sha256}`;
  await env.MAIL_ARCHIVE.put(key, bytes, { sha256 });
  return { key, sha256, size: bytes.length };
}
async function insert(
  id: string,
  text: string | null,
  attachment?: { text: string; mimeType: string },
) {
  const body = text === null ? null : await object(text);
  const part = attachment
    ? { index: 0, mimeType: attachment.mimeType, ...(await object(attachment.text)) }
    : null;
  const row = {
    raw_key: `ingest/2026-11-11/${id}/raw.eml`,
    manifest_key: `synthetic/manifest/${id}`,
    body_text_key: body?.key ?? null,
    body_html_key: text === null ? "opaque-html" : null,
    attachments_json: JSON.stringify(part ? [part] : []),
  };
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,observed_pass,observed_revision) VALUES('email_routing','ingress-v1',?,?,?,'2026-11-11T00:00:00.000Z','present','missing',0,0)`,
  )
    .bind(id, row.raw_key, `${row.raw_key}.receipt`)
    .run();
  await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,attachment_count,body_json_key,body_text_key,body_html_key,manifest_key,updated_at)
    VALUES(?,'mime-v1',?,1,?,'complete',?,?,?,?,?,?,?,0)`)
    .bind(
      row.raw_key,
      "a".repeat(64),
      id,
      JSON.stringify({ subject: "Synthetic invoice", from: { address: "sender@example.invalid" } }),
      row.attachments_json,
      part ? 1 : 0,
      "synthetic/body-json",
      row.body_text_key,
      row.body_html_key,
      row.manifest_key,
    )
    .run();
  return row;
}
beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec("DELETE FROM mail_extractions; DELETE FROM archive_sources;");
});
describe("bounded content retrieval", () => {
  it("finds Japanese phrases and exact numbers with authenticated provenance", async () => {
    await insert("japanese", "今月の請求書は合計12,345円です。");
    expect(await repairContentSearch(env)).toEqual({ indexed: 1, deferred: 0 });
    const result = await searchMailContent(
      env,
      reader,
      { query: "請求書", filters: "from:sender@example.invalid after:2026-11-10" },
      base,
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      message_id: "mail_japanese",
      citation: { part: "body", file_uri: `${base}/api/mail/mail_japanese/text` },
    });
    expect(result.matches[0]!.excerpt).toContain("請求書");
    expect((await searchMailContent(env, reader, { query: "12,345" }, base)).matches).toHaveLength(
      1,
    );
    expect(result.coverage).toMatchObject({
      indexed_messages: 1,
      extracted_messages: 1,
      semantic_search: false,
    });
    const response = await readMailResource(
      new Request(result.matches[0]!.citation.file_uri),
      env,
      reader,
      "mail_japanese",
      "text",
    );
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", await response.arrayBuffer())),
    ]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    expect(hash).toBe(result.matches[0]!.citation.sha256);
  });
  it("indexes text attachments but reports unsupported representations", async () => {
    await insert("text-file", "body", { text: "添付の支払明細です。", mimeType: "text/plain" });
    await insert("pdf", null, { text: "unconverted PDF", mimeType: "application/pdf" });
    await repairContentSearch(env);
    const result = await searchMailContent(env, reader, { query: "支払明細" }, base);
    expect(result.matches[0]).toMatchObject({
      citation: { part: "part_0", file_uri: `${base}/api/mail/mail_text-file/attachments/part_0` },
    });
    const coverage = await env.MAIL_CATALOG.prepare(
      "SELECT coverage_json FROM mail_search_documents WHERE raw_key LIKE '%/pdf/%'",
    ).first<{ coverage_json: string }>();
    expect(JSON.parse(coverage!.coverage_json)).toMatchObject({
      omitted: ["html_only_body", "part_0:conversion_not_enabled_or_pending"],
    });
  });
  it("retries corrupt or missing derivatives without publishing partial results or starving work", async () => {
    const broken = await insert("a-broken", "private missing content");
    await env.MAIL_ARCHIVE.delete(broken.body_text_key!);
    await insert("b-good", "matching content");
    expect(await repairContentSearch(env, 100)).toEqual({ indexed: 1, deferred: 1 });
    expect(await repairContentSearch(env, 101)).toEqual({ indexed: 0, deferred: 0 });
    expect((await searchMailContent(env, reader, { query: "private" }, base)).matches).toEqual([]);
    expect(
      (await searchMailContent(env, reader, { query: "matching" }, base)).matches,
    ).toHaveLength(1);
  });
  it("removes obsolete indexed text on extraction invalidation and fences stale publication", async () => {
    const row = await insert("changed", "obsolete needle");
    await repairContentSearch(env);
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET manifest_key='replacement' WHERE raw_key=?",
    )
      .bind(row.raw_key)
      .run();
    await indexMailContent(env, row);
    expect((await searchMailContent(env, reader, { query: "needle" }, base)).matches).toEqual([]);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM mail_search_chunks").first(),
    ).toEqual({ n: 0 });
  });
  it("preserves overlap matches and bounds indexed content, exposing truncation", async () => {
    await insert(
      "long",
      "x".repeat(3497) + "boundary-marker" + "y".repeat(100_000) + "beyond-limit",
    );
    await repairContentSearch(env);
    const result = await searchMailContent(env, reader, { query: "boundary-marker" }, base);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.coverage).toMatchObject({ omitted: ["body_truncated"] });
    expect((await searchMailContent(env, reader, { query: "beyond-limit" }, base)).matches).toEqual(
      [],
    );
  });
  it("uses literal FTS input, bounded keyset pages and query-bound cursors", async () => {
    await insert("first", 'literal OR "quoted" needle');
    await insert("second", 'literal OR "quoted" needle');
    await repairContentSearch(env);
    const first = await searchMailContent(env, reader, { query: "needle", max_results: 1 }, base);
    expect(first.next_page_token).not.toBeNull();
    await insert("late", "late needle");
    await repairContentSearch(env);
    const second = await searchMailContent(
      env,
      reader,
      { query: "needle", max_results: 1, next_page_token: first.next_page_token! },
      base,
    );
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]!.message_id).not.toEqual(first.matches[0]!.message_id);
    expect(second.matches[0]!.message_id).not.toBe("mail_late");
    expect(
      (await searchMailContent(env, reader, { query: 'OR "quoted"' }, base)).matches,
    ).toHaveLength(2);
    await expect(
      searchMailContent(
        env,
        reader,
        { query: "different", next_page_token: first.next_page_token! },
        base,
      ),
    ).rejects.toMatchObject({ code: "invalid_page_token" });
    await expect(searchMailContent(env, reader, { query: "ab" }, base)).rejects.toMatchObject({
      code: "invalid_content_query",
    });
  });
  it("returns the entire matching phrase when it exceeds the FTS snippet token limit", async () => {
    const query = "a".repeat(100);
    await insert("long-phrase", `prefix ${query} suffix`);
    await repairContentSearch(env);
    expect((await searchMailContent(env, reader, { query }, base)).matches[0]!.excerpt).toContain(
      query,
    );
    await insert("unicode-offset", "İ".repeat(500) + "needle");
    await repairContentSearch(env);
    expect(
      (await searchMailContent(env, reader, { query: "needle" }, base)).matches[0]!.excerpt,
    ).toContain("needle");
  });
  it("enforces mail read grants at the MCP boundary and exposes source citations", async () => {
    await insert("mcp", "find this synthetic needle");
    await repairContentSearch(env);
    const context = { ...env, EMAIL: { send: vi.fn() } as unknown as SendEmail };
    await expect(
      dispatchMailTool(
        "search_mail_content",
        { query: "needle" },
        context,
        { ...reader, scopes: [] },
        base,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await dispatchMailTool("search_mail_content", { query: "needle" }, context, reader, base),
    ).toMatchObject({ matches: [{ message_id: "mail_mcp" }] });
  });
});
