import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  repairContentSearch,
  searchMailContent,
  indexMailContent,
  indexContentSearchSource,
} from "../src/content-search.ts";
import { dispatchMailTool } from "../src/mcp.ts";
import { MAX_SEARCH_FILTERS, readMailResource } from "../src/mail-read.ts";
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
    `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES('email_routing','ingress-v1',?,?,?,'2026-11-11T00:00:00.000Z','present','missing',?,0,0)`,
  )
    .bind(id, row.raw_key, `${row.raw_key}.receipt`, "a".repeat(64))
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
  await env.MAIL_CATALOG.exec(
    "DELETE FROM mail_identity; DELETE FROM mail_extractions; DELETE FROM archive_sources; DELETE FROM processing_jobs;",
  );
});

async function completedJob(rawKey: string, instanceId: string) {
  await env.MAIL_CATALOG.prepare("UPDATE mail_extractions SET instance_id=? WHERE raw_key=?")
    .bind(instanceId, rawKey)
    .run();
  await env.MAIL_CATALOG.prepare(`INSERT INTO processing_jobs(raw_key,pipeline_version,instance_id,state,created_at,updated_at,next_check_at,completed_at)
    VALUES(?,'mime-v1',?,'complete',0,0,0,0)`)
    .bind(rawKey, instanceId)
    .run();
}
describe("bounded content retrieval", () => {
  it("shows a chunk once per copy group within a page unless copies are expanded", async () => {
    const rows = [
      await insert("copy-live", "duplicated copy needle"),
      await insert("copy-gmail", "duplicated copy needle"),
      await insert("copy-alone", "duplicated copy needle"),
    ];
    for (const row of rows)
      // oxlint-disable-next-line no-await-in-loop -- Index entries in order; results list newest first.
      expect(await indexMailContent(env, row)).toBe(true);
    // Synthetic identity rows: the first two originals are copies of one message.
    for (const [row, group] of [
      [rows[0]!, "a".repeat(64)],
      [rows[1]!, "a".repeat(64)],
      [rows[2]!, "b".repeat(64)],
    ] as const)
      // oxlint-disable-next-line no-await-in-loop -- Ordered synthetic rows.
      await env.MAIL_CATALOG.prepare(
        `INSERT INTO mail_identity(raw_key,identity_version,raw_sha256,status,group_id,group_rule,indexed_at)
        VALUES(?,'identity-v2',?,'complete',?,'message_id_dkim','2026-11-11T00:00:00.000Z')`,
      )
        .bind(row.raw_key, "a".repeat(64), group)
        .run();
    const collapsed = await searchMailContent(env, reader, { query: "copy needle" }, base);
    expect(collapsed.matches.map((match) => [match.message_id, match.group_id])).toEqual([
      ["mail_copy-alone", "b".repeat(64)],
      ["mail_copy-gmail", "a".repeat(64)],
    ]);
    expect(collapsed.coverage).toMatchObject({ duplicate_copies_omitted: 1 });
    const expanded = await searchMailContent(
      env,
      reader,
      { query: "copy needle", expand_copies: true },
      base,
    );
    expect(expanded.matches.map((match) => match.message_id)).toEqual([
      "mail_copy-alone",
      "mail_copy-gmail",
      "mail_copy-live",
    ]);
    expect(expanded.coverage).toMatchObject({ duplicate_copies_omitted: 0 });
  });
  it("fences an immediate projection against an attempt change during R2 reads and missing originals", async () => {
    const source = await insert("workflow-fenced", "immediate fenced needle");
    await completedJob(source.raw_key, "synthetic-old-instance");
    const get = env.MAIL_ARCHIVE.get.bind(env.MAIL_ARCHIVE);
    const spy = vi.spyOn(env.MAIL_ARCHIVE, "get").mockImplementationOnce(async (...args) => {
      await env.MAIL_CATALOG.prepare(
        "UPDATE processing_jobs SET instance_id='synthetic-new-instance',attempt=1 WHERE raw_key=?",
      )
        .bind(source.raw_key)
        .run();
      return get(...args);
    });
    try {
      expect(await indexContentSearchSource(env, source.raw_key, "synthetic-old-instance")).toEqual(
        { status: "skipped" },
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_search_chunks").first("n"),
    ).toBe(0);
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET instance_id='synthetic-new-instance' WHERE raw_key=?",
    )
      .bind(source.raw_key)
      .run();
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_state='missing' WHERE raw_key=?")
      .bind(source.raw_key)
      .run();
    expect(await indexContentSearchSource(env, source.raw_key, "synthetic-new-instance")).toEqual({
      status: "skipped",
    });
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_state='present' WHERE raw_key=?")
      .bind(source.raw_key)
      .run();
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT e.instance_id extraction_instance,j.instance_id job_instance,j.state,s.raw_state FROM mail_extractions e JOIN processing_jobs j ON j.raw_key=e.raw_key JOIN archive_sources s ON s.raw_key=e.raw_key WHERE e.raw_key=?",
      )
        .bind(source.raw_key)
        .first(),
    ).toEqual({
      extraction_instance: "synthetic-new-instance",
      job_instance: "synthetic-new-instance",
      state: "complete",
      raw_state: "present",
    });
    expect(await indexContentSearchSource(env, source.raw_key, "synthetic-old-instance")).toEqual({
      status: "skipped",
    });
    expect(await indexContentSearchSource(env, source.raw_key, "synthetic-new-instance")).toEqual({
      status: "ready",
    });
    expect(
      (await searchMailContent(env, reader, { query: "fenced needle" }, base)).matches,
    ).toHaveLength(1);
  });
  it("persists immediate indexing failures for repair without changing successful MIME state", async () => {
    const source = await insert("workflow-retry", "durable immediate retry needle");
    await completedJob(source.raw_key, "synthetic-instance");
    await env.MAIL_ARCHIVE.delete(source.body_text_key!);
    await expect(
      indexContentSearchSource(env, source.raw_key, "synthetic-instance", 100),
    ).rejects.toThrow("Content indexing unavailable");
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM processing_jobs WHERE raw_key=?")
        .bind(source.raw_key)
        .first("state"),
    ).toBe("complete");
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT status,next_attempt_at FROM mail_search_documents WHERE raw_key=?",
      )
        .bind(source.raw_key)
        .first(),
    ).toEqual({ status: "retry", next_attempt_at: 300100 });
    await object("durable immediate retry needle");
    expect(await repairContentSearch(env, 300100)).toEqual({ indexed: 1, deferred: 0 });
    const first = await env.MAIL_CATALOG.prepare(
      "SELECT id FROM mail_search_chunks WHERE raw_key=?",
    )
      .bind(source.raw_key)
      .first("id");
    expect(await indexContentSearchSource(env, source.raw_key, "synthetic-instance")).toEqual({
      status: "ready",
    });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT id FROM mail_search_chunks WHERE raw_key=?")
        .bind(source.raw_key)
        .first("id"),
    ).toBe(first);
    expect(
      (await searchMailContent(env, reader, { query: "retry needle" }, base)).matches,
    ).toHaveLength(1);
  });
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
  it("counts a projection fenced by a conversion change during repair as deferred", async () => {
    const source = await insert("raced", "raced body needle", {
      text: "synthetic original scanned PDF",
      mimeType: "application/pdf",
    });
    const part = JSON.parse(source.attachments_json)[0]!;
    const open = env.MAIL_CATALOG.withSession.bind(env.MAIL_CATALOG);
    const conversion = env.MAIL_CATALOG.prepare(
      `INSERT INTO attachment_conversions(raw_key,part_index,manifest_key,mime_sha256,source_key,source_sha256,source_size,source_mime,policy_hash,state,updated_at)
         VALUES(?,0,?,?,?,?,?,?,?,'pending',0)`,
    ).bind(
      source.raw_key,
      source.manifest_key,
      "a".repeat(64),
      part.key,
      part.sha256,
      part.size,
      part.mimeType,
      "b".repeat(64),
    );
    // A conversion starts after repair read the conversion snapshot but before it publishes.
    const spy = vi.spyOn(env.MAIL_CATALOG, "withSession").mockImplementationOnce((constraint) => {
      const session = open(constraint);
      const batch = session.batch.bind(session);
      session.batch = async (statements) => {
        await conversion.run();
        return batch(statements);
      };
      return session;
    });
    try {
      expect(await repairContentSearch(env, 100)).toEqual({ indexed: 0, deferred: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_search_documents").first("n"),
    ).toBe(0);
    // Nothing was published, so the next pass picks the source up without a retry delay.
    expect(await repairContentSearch(env, 101)).toEqual({ indexed: 1, deferred: 0 });
    expect(
      (await searchMailContent(env, reader, { query: "raced body" }, base)).matches,
    ).toHaveLength(1);
  });
  it("reindexes a live conversion before historical backlog and backfills the remaining slots", async () => {
    const historical = [];
    for (let index = 0; index < 4; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Build a deterministic historical backlog.
      historical.push(await insert(`a-history-${index}`, "historical searchable content"));
    }
    await env.MAIL_CATALOG.prepare(
      "UPDATE archive_sources SET source_kind='gmail',source_namespace='synthetic-account'",
    ).run();
    const missing = await insert("a-missing-live", "missing original must not consume a slot");
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_state='missing' WHERE raw_key=?")
      .bind(missing.raw_key)
      .run();
    const live = await insert("z-live", "live body", {
      text: "synthetic original scanned PDF",
      mimeType: "application/pdf",
    });
    expect(historical.every((row) => row.raw_key < live.raw_key)).toBe(true);
    await indexMailContent(env, live);
    const original = JSON.parse(live.attachments_json)[0]!;
    const converted = await object("new live converted needle");
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO attachment_conversions(raw_key,part_index,manifest_key,mime_sha256,source_key,source_sha256,source_size,source_mime,policy_hash,state,representation,result_key,result_sha256,result_size,provenance_json,updated_at)
       VALUES(?,0,?,?,?,?,?,?,?,'complete','managed_ocr_indexed_text',?,?,?,'{}',0)`,
    )
      .bind(
        live.raw_key,
        live.manifest_key,
        "a".repeat(64),
        original.key,
        original.sha256,
        original.size,
        original.mimeType,
        "b".repeat(64),
        converted.key,
        converted.sha256,
        converted.size,
      )
      .run();
    expect(
      await env.MAIL_CATALOG.prepare("SELECT status FROM mail_search_documents WHERE raw_key=?")
        .bind(live.raw_key)
        .first(),
    ).toBeNull();
    expect(await repairContentSearch(env, 100)).toEqual({ indexed: 3, deferred: 0 });
    expect(
      (
        await env.MAIL_CATALOG.prepare(
          "SELECT raw_key FROM mail_search_documents ORDER BY raw_key",
        ).all<{ raw_key: string }>()
      ).results.map((row) => row.raw_key),
    ).toEqual([historical[0]!.raw_key, historical[1]!.raw_key, live.raw_key]);
    expect(
      (await searchMailContent(env, reader, { query: "converted needle" }, base)).matches,
    ).toMatchObject([
      {
        message_id: "mail_z-live",
        citation: { part: "converted_0", sha256: converted.sha256 },
      },
    ]);
    expect(await repairContentSearch(env, 101)).toEqual({ indexed: 2, deferred: 0 });
    expect(await repairContentSearch(env, 102)).toEqual({ indexed: 0, deferred: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT status FROM mail_search_documents WHERE raw_key=?")
        .bind(missing.raw_key)
        .first(),
    ).toBeNull();
  });
  it("defers a live retry until due while historical sources continue to backfill", async () => {
    for (let index = 0; index < 4; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Historical work remains available during the retry delay.
      await insert(`a-history-${index}`, "historical searchable content");
    }
    await env.MAIL_CATALOG.prepare(
      "UPDATE archive_sources SET source_kind='gmail',source_namespace='synthetic-account'",
    ).run();
    const live = await insert("z-live-retry", "live retry needle");
    await env.MAIL_ARCHIVE.delete(live.body_text_key!);
    expect(await repairContentSearch(env, 100)).toEqual({ indexed: 2, deferred: 1 });
    expect(await repairContentSearch(env, 101)).toEqual({ indexed: 2, deferred: 0 });
    expect(await repairContentSearch(env, 300099)).toEqual({ indexed: 0, deferred: 0 });
    await object("live retry needle");
    expect(await repairContentSearch(env, 300100)).toEqual({ indexed: 1, deferred: 0 });
    expect(
      (await searchMailContent(env, reader, { query: "retry needle" }, base)).matches,
    ).toMatchObject([{ message_id: "mail_z-live-retry" }]);
  });
  it("searches and indexes only an extraction of the original the catalog holds now", async () => {
    const missing = await insert("stale-missing", "stale needle one");
    const changed = await insert("stale-changed", "stale needle two");
    const blocked = await insert("stale-blocked", "stale needle three");
    const current = await insert("stale-current", "stale needle four");
    for (const row of [missing, changed, blocked, current])
      // oxlint-disable-next-line no-await-in-loop -- Four synthetic messages, indexed in order.
      expect(await indexMailContent(env, row)).toBe(true);
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_state='missing' WHERE raw_key=?")
      .bind(missing.raw_key)
      .run();
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_sha256=? WHERE raw_key=?")
      .bind("b".repeat(64), changed.raw_key)
      .run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET status='blocked',failure_code='source_changed' WHERE raw_key=?",
    )
      .bind(blocked.raw_key)
      .run();
    const result = await searchMailContent(env, reader, { query: "stale needle" }, base);
    expect(result.matches.map((match) => match.message_id)).toEqual(["mail_stale-current"]);
    expect(result.coverage).toMatchObject({ extracted_messages: 1, indexed_messages: 1 });
    // Indexing never publishes a projection of a stale extraction.
    await env.MAIL_CATALOG.exec(
      "DELETE FROM mail_search_chunks; DELETE FROM mail_search_documents;",
    );
    expect(await indexMailContent(env, missing)).toBe(false);
    expect(await indexMailContent(env, changed)).toBe(false);
    await completedJob(changed.raw_key, "synthetic-changed-instance");
    expect(
      await indexContentSearchSource(env, changed.raw_key, "synthetic-changed-instance"),
    ).toEqual({ status: "skipped" });
    expect(await repairContentSearch(env)).toEqual({ indexed: 1, deferred: 0 });
    expect(await repairContentSearch(env)).toEqual({ indexed: 0, deferred: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT raw_key FROM mail_search_documents").all(),
    ).toMatchObject({ results: [{ raw_key: current.raw_key }] });
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
  it("binds the most metadata filters D1 allows next to the phrase and cursor", async () => {
    await insert("first", "bounded filter needle");
    await insert("second", "bounded filter needle");
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET metadata_json=json_set(metadata_json,'$.subject','\u00c4nderung')",
    ).run();
    await repairContentSearch(env);
    // Each subject:Ä binds two values, the most a filter can bind.
    const filters = (count: number) =>
      Array.from({ length: count }, () => "subject:\u00c4").join(" ");
    const first = await searchMailContent(
      env,
      reader,
      { query: "needle", filters: filters(MAX_SEARCH_FILTERS), max_results: 1 },
      base,
    );
    expect(first.matches).toHaveLength(1);
    const second = await searchMailContent(
      env,
      reader,
      {
        query: "needle",
        filters: filters(MAX_SEARCH_FILTERS),
        max_results: 1,
        next_page_token: first.next_page_token!,
      },
      base,
    );
    expect([...first.matches, ...second.matches].map((m) => m.message_id).sort()).toEqual([
      "mail_first",
      "mail_second",
    ]);
    await expect(
      searchMailContent(
        env,
        reader,
        { query: "needle", filters: filters(MAX_SEARCH_FILTERS + 1) },
        base,
      ),
    ).rejects.toMatchObject({ code: "query_too_long" });
  });
  it("filters by metadata values longer than D1's LIKE pattern limit", async () => {
    await insert("long-subject", "long filter needle");
    await insert("short-subject", "long filter needle");
    const subject = "令和八年度合成請求書のご案内（試験用）";
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET metadata_json=json_set(metadata_json,'$.subject',?) WHERE raw_key LIKE '%/long-subject/%'",
    )
      .bind(subject)
      .run();
    await repairContentSearch(env);
    const result = await searchMailContent(
      env,
      reader,
      { query: "needle", filters: `subject:${subject}` },
      base,
    );
    expect(result.matches.map((m) => m.message_id)).toEqual(["mail_long-subject"]);
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
  it("never splits a surrogate pair at chunk, truncation or excerpt boundaries", async () => {
    const emoji = "\u{1f600}";
    const stored = async (rawKey: string) =>
      (
        await env.MAIL_CATALOG.prepare(
          "SELECT part,ordinal,text FROM mail_search_chunks WHERE raw_key=? ORDER BY part,ordinal",
        )
          .bind(rawKey)
          .all<{ part: string; ordinal: number; text: string }>()
      ).results;
    // Compare booleans: printing a lone surrogate breaks the test runner's UTF-8 transport.
    const wellFormed = (text: string) => text.isWellFormed() && !text.includes("�");
    // Emoji across the second chunk's start (3300), the first chunk's end (3500) and the body cut (100,000).
    const head = `${"x".repeat(3299)}${emoji}${"y".repeat(198)}${emoji}`;
    const body = await insert(
      "surrogate-body",
      `${head}${"z".repeat(99_999 - head.length)}${emoji}tail`,
      { text: `${"a".repeat(15_999)}${emoji}after`, mimeType: "text/plain" },
    );
    await indexMailContent(env, body);
    const chunks = await stored(body.raw_key);
    expect(chunks.every((chunk) => wellFormed(chunk.text))).toBe(true);
    const bodyChunks = chunks.filter((chunk) => chunk.part === "body");
    expect(bodyChunks[0]!.text === `${"x".repeat(3299)}${emoji}${"y".repeat(198)}`).toBe(true);
    expect(bodyChunks[1]!.text.startsWith(`${emoji}${"y".repeat(198)}${emoji}z`)).toBe(true);
    expect(bodyChunks.at(-1)!.text.endsWith("zzz")).toBe(true);
    expect(
      chunks
        .filter((chunk) => chunk.part === "part_0")
        .at(-1)!
        .text.endsWith("aaa"),
    ).toBe(true);
    const coverage = await env.MAIL_CATALOG.prepare(
      "SELECT coverage_json FROM mail_search_documents WHERE raw_key=?",
    )
      .bind(body.raw_key)
      .first<{ coverage_json: string }>();
    expect(JSON.parse(coverage!.coverage_json)).toMatchObject({
      omitted: ["body_truncated", "part_0:truncated"],
    });
    // A phrase across the first chunk boundary still cites the chunk that holds it whole.
    const straddle = await searchMailContent(env, reader, { query: `y${emoji}z` }, base);
    expect(straddle.matches.map((match) => match.citation.chunk)).toEqual([1]);
    expect(wellFormed(straddle.matches[0]!.excerpt)).toBe(true);

    // The searchable derivative budget (64,000 units) ends inside a pair.
    const derived = await insert("surrogate-derived", "derived body", {
      text: "synthetic scanned original",
      mimeType: "application/pdf",
    });
    const original = JSON.parse(derived.attachments_json)[0]!;
    const converted = await object(`${"d".repeat(63_999)}${emoji}after`);
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO attachment_conversions(raw_key,part_index,manifest_key,mime_sha256,source_key,source_sha256,source_size,source_mime,policy_hash,state,representation,result_key,result_sha256,result_size,provenance_json,updated_at)
       VALUES(?,0,?,?,?,?,?,?,?,'complete','managed_ocr_indexed_text',?,?,?,'{}',0)`,
    )
      .bind(
        derived.raw_key,
        derived.manifest_key,
        "a".repeat(64),
        original.key,
        original.sha256,
        original.size,
        original.mimeType,
        "b".repeat(64),
        converted.key,
        converted.sha256,
        converted.size,
      )
      .run();
    await indexMailContent(env, derived);
    const derivedChunks = (await stored(derived.raw_key)).filter(
      (chunk) => chunk.part === "converted_0",
    );
    expect(derivedChunks.every((chunk) => wellFormed(chunk.text))).toBe(true);
    expect(derivedChunks.at(-1)!.text.endsWith("ddd")).toBe(true);

    // The excerpt window (150 units around the match) starts and ends inside a pair.
    await insert(
      "surrogate-excerpt",
      `${"p".repeat(10)}${emoji}${"q".repeat(149)}needle${"r".repeat(149)}${emoji}tail`,
    );
    await repairContentSearch(env);
    const excerpt = (await searchMailContent(env, reader, { query: "needle" }, base)).matches[0]!
      .excerpt;
    expect(excerpt === `…${emoji}${"q".repeat(149)}needle${"r".repeat(149)}…`).toBe(true);
  });
  it("spends the derivative budget when a surrogate pair shortens the derivative cut", async () => {
    const source = await insert("surrogate-budget", "budget body", {
      text: "synthetic scanned original",
      mimeType: "application/pdf",
    });
    const first = JSON.parse(source.attachments_json)[0]!;
    const second = { ...first, index: 1, ...(await object("synthetic second original")) };
    source.attachments_json = JSON.stringify([first, second]);
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET attachments_json=?,attachment_count=2 WHERE raw_key=?",
    )
      .bind(source.attachments_json, source.raw_key)
      .run();
    for (const [part, text] of [
      [first, `${"d".repeat(63_999)}\u{1f600}after`],
      [second, "second derivative needle"],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- Two synthetic derivatives in index order.
      const converted = await object(text);
      // oxlint-disable-next-line no-await-in-loop -- Two synthetic derivatives in index order.
      await env.MAIL_CATALOG.prepare(
        `INSERT INTO attachment_conversions(raw_key,part_index,manifest_key,mime_sha256,source_key,source_sha256,source_size,source_mime,policy_hash,state,representation,result_key,result_sha256,result_size,provenance_json,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,'complete','managed_ocr_indexed_text',?,?,?,'{}',0)`,
      )
        .bind(
          source.raw_key,
          part.index,
          source.manifest_key,
          "a".repeat(64),
          part.key,
          part.sha256,
          part.size,
          part.mimeType,
          "b".repeat(64),
          converted.key,
          converted.sha256,
          converted.size,
        )
        .run();
    }
    expect(await indexMailContent(env, source)).toBe(true);
    // The first cut stops at 63,999 units only to keep the pair whole; the budget is still spent.
    const coverage = await env.MAIL_CATALOG.prepare(
      "SELECT coverage_json FROM mail_search_documents WHERE raw_key=?",
    )
      .bind(source.raw_key)
      .first<{ coverage_json: string }>();
    expect(JSON.parse(coverage!.coverage_json)).toMatchObject({
      omitted: [
        "part_0:derivative_search_truncated",
        "part_1:derivative_search_count_or_character_limit",
      ],
    });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) n FROM mail_search_chunks WHERE raw_key=? AND part='converted_1'",
      )
        .bind(source.raw_key)
        .first("n"),
    ).toBe(0);
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

interface SyntheticMessage {
  id: string;
  subject: string;
  receivedAt: string;
  attachments: number;
  current: boolean;
  ready: boolean;
}
// Writes catalog rows directly: search reads only D1, and indexing thousands of
// messages through repair would take three per pass.
async function catalog(messages: SyntheticMessage[]) {
  const statements = messages.flatMap((message) => {
    const rawKey = `ingest/2026-11-11/${message.id}/raw.eml`;
    const manifestKey = `synthetic/manifest/${message.id}`;
    return [
      env.MAIL_CATALOG.prepare(
        `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES('email_routing','ingress-v1',?,?,?,?,?,'missing',?,0,0)`,
      ).bind(
        message.id,
        rawKey,
        `${rawKey}.receipt`,
        message.receivedAt,
        message.current ? "present" : "missing",
        "a".repeat(64),
      ),
      env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,attachment_count,body_json_key,body_text_key,body_html_key,manifest_key,updated_at)
        VALUES(?,'mime-v1',?,1,?,'complete',?,'[]',?,'synthetic/body-json',NULL,NULL,?,0)`).bind(
        rawKey,
        "a".repeat(64),
        message.id,
        JSON.stringify({ subject: message.subject }),
        message.attachments,
        manifestKey,
      ),
      env.MAIL_CATALOG.prepare(
        "INSERT INTO mail_search_documents(raw_key,manifest_key,status,coverage_json,next_attempt_at) VALUES(?,?,?,'{}',0)",
      ).bind(rawKey, manifestKey, message.ready ? "ready" : "retry"),
    ];
  });
  for (let start = 0; start < statements.length; start += 300)
    // oxlint-disable-next-line no-await-in-loop -- Keep each synthetic batch small.
    await env.MAIL_CATALOG.batch(statements.slice(start, start + 300));
}
async function chunkRows(rows: { id: string; ordinal: number; text: string }[]) {
  const statements = rows.map((row) =>
    env.MAIL_CATALOG.prepare(
      "INSERT INTO mail_search_chunks(raw_key,part,ordinal,text,sha256) VALUES(?,'body',?,?,?)",
    ).bind(`ingest/2026-11-11/${row.id}/raw.eml`, row.ordinal, row.text, "b".repeat(64)),
  );
  for (let start = 0; start < statements.length; start += 300)
    // oxlint-disable-next-line no-await-in-loop -- Keep each synthetic batch small.
    await env.MAIL_CATALOG.batch(statements.slice(start, start + 300));
}
// The search statement as searchMailContent prepared and bound it.
async function searchStatement(input: Parameters<typeof searchMailContent>[2]) {
  const prepare = env.MAIL_CATALOG.prepare.bind(env.MAIL_CATALOG);
  let captured: { sql: string; values: unknown[] } | undefined;
  const spy = vi.spyOn(env.MAIL_CATALOG, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (!sql.includes("mail_search_fts MATCH")) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      captured = { sql, values };
      return bind(...values);
    };
    return statement;
  });
  try {
    const result = await searchMailContent(env, reader, input, base);
    return { result, ...captured! };
  } finally {
    spy.mockRestore();
  }
}
// The continuation token format every earlier version issued and accepted.
function pageToken(before: number, query: string, filter: string) {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ before, query, filter }))),
  );
}
describe("content search paging", () => {
  it("lets FTS5 walk matches in descending rowid order with the cursor as its bound", async () => {
    await catalog([
      {
        id: "plan",
        subject: "Synthetic plan",
        receivedAt: "2026-11-11T00:00:00.000Z",
        attachments: 1,
        current: true,
        ready: true,
      },
    ]);
    await chunkRows([{ id: "plan", ordinal: 0, text: "synthetic plan needle" }]);
    for (const filters of ["", "subject:plan after:2026-11-01 has:attachment"]) {
      // oxlint-disable-next-line no-await-in-loop -- One filter at a time keeps the spy scoped.
      const { sql, values } = await searchStatement({
        query: "needle",
        filters,
        next_page_token: pageToken(Number.MAX_SAFE_INTEGER, "needle", filters),
      });
      // oxlint-disable-next-line no-await-in-loop -- Same as above.
      const plan = await env.MAIL_CATALOG.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail);
      expect(details.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([]);
      // FTS5 sets idxNum flags 0x40 (ORDER BY rowid) and 0x80 (DESC) when it consumes the
      // ORDER BY, and puts "<" in idxStr when it applies the rowid upper bound itself.
      const scan = /^SCAN mail_search_fts VIRTUAL TABLE INDEX (\d+):(\S*)$/.exec(details[0]!);
      expect(scan).not.toBeNull();
      expect(Number(scan![1]) & 0xc0).toBe(0xc0);
      expect(scan![2]).toContain("<");
    }
  });
  it("reads a bounded number of rows per page however many chunks match", async () => {
    const messages = Array.from({ length: 2000 }, (_, index) => ({
      id: `bulk-${index}`,
      subject: "Synthetic bulk",
      receivedAt: "2026-11-11T00:00:00.000Z",
      attachments: 0,
      current: true,
      ready: true,
    }));
    await catalog(messages);
    await chunkRows(messages.map(({ id }) => ({ id, ordinal: 0, text: "the common needle" })));
    const first = await searchStatement({ query: "the" });
    expect(first.result.matches).toHaveLength(20);
    const second = await searchStatement({
      query: "the",
      next_page_token: first.result.next_page_token!,
    });
    expect(second.result.matches).toHaveLength(20);
    expect(second.result.matches[0]!.message_id).toBe("mail_bulk-1979");
    for (const { sql, values } of [first, second]) {
      // oxlint-disable-next-line no-await-in-loop -- Measure one page at a time.
      const { meta } = await env.MAIL_CATALOG.prepare(sql)
        .bind(...values)
        .all();
      // Sorting every match reads each of the 2,000 matches and its joined rows (about
      // 12,000 rows); walking rowids in order stops after the 21 rows the page needs.
      expect(meta.rows_read).toBeLessThan(500);
    }
  });
  it("returns the same pages and continuation tokens as ordering by chunk ID", async () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      id: `page-${String(index).padStart(2, "0")}`,
      subject: index % 2 ? `Beta ${index}` : `Alpha ${index}`,
      receivedAt: `2026-11-0${1 + (index % 9)}T00:00:00.000Z`,
      attachments: index % 3 === 0 ? 1 : 0,
      current: index % 7 !== 3,
      ready: index % 11 !== 5,
    }));
    await catalog(messages);
    // Interleave messages so that consecutive chunk IDs belong to different messages.
    await chunkRows(
      [0, 1, 2].flatMap((ordinal) =>
        messages.map(({ id }, index) => ({
          id,
          ordinal,
          text: (index + ordinal) % 3 ? `synthetic ${ordinal} Needle text` : "no match here",
        })),
      ),
    );
    // Removed chunks leave gaps in the ID sequence and in the FTS rowids.
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_search_chunks WHERE id%5=0").run();
    const stored = (
      await env.MAIL_CATALOG.prepare(
        "SELECT c.id,s.external_id,c.ordinal,c.text FROM mail_search_chunks c JOIN archive_sources s ON s.raw_key=c.raw_key ORDER BY c.id DESC",
      ).all<{ id: number; external_id: string; ordinal: number; text: string }>()
    ).results;
    const byId = new Map(messages.map((message) => [message.id, message]));
    const cases: [string, (message: SyntheticMessage) => boolean][] = [
      ["", () => true],
      ["subject:alpha", (message) => message.subject.startsWith("Alpha")],
      [
        "has:attachment after:2026-11-04",
        (message) => message.attachments > 0 && message.receivedAt >= "2026-11-04",
      ],
    ];
    for (const [filters, accepts] of cases) {
      // The order every earlier version returned: chunk ID descending.
      const expected = stored.filter((row) => {
        const message = byId.get(row.external_id)!;
        return (
          row.text.toLowerCase().includes("needle") &&
          message.current &&
          message.ready &&
          accepts(message)
        );
      });
      expect(expected.length).toBeGreaterThan(7);
      const pages: { ids: string[]; token: string | null }[] = [];
      let token: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- Each page needs the previous token.
        const page = await searchMailContent(
          env,
          reader,
          { query: "needle", filters, max_results: 7, next_page_token: token },
          base,
        );
        pages.push({
          ids: page.matches.map((match) => `${match.message_id}#${match.citation.chunk}`),
          token: page.next_page_token,
        });
        token = page.next_page_token ?? undefined;
      } while (token);
      const expectedPages = [];
      for (let start = 0; start < expected.length; start += 7) {
        const rows = expected.slice(start, start + 7);
        expectedPages.push({
          ids: rows.map((row) => `mail_${row.external_id}#${row.ordinal}`),
          token: start + 7 < expected.length ? pageToken(rows.at(-1)!.id, "needle", filters) : null,
        });
      }
      expect(pages).toEqual(expectedPages);
      // A token can name a chunk that was removed since; the next page starts below it.
      const removed = expected[3]!.id - (expected[3]!.id % 5);
      // oxlint-disable-next-line no-await-in-loop -- One filter at a time.
      const resumed = await searchMailContent(
        env,
        reader,
        {
          query: "needle",
          filters,
          max_results: 3,
          next_page_token: pageToken(removed, "needle", filters),
        },
        base,
      );
      expect(resumed.matches.map((match) => `${match.message_id}#${match.citation.chunk}`)).toEqual(
        expected
          .filter((row) => row.id < removed)
          .slice(0, 3)
          .map((row) => `mail_${row.external_id}#${row.ordinal}`),
      );
    }
  });
});
