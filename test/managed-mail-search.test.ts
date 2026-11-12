import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repairManagedMailCorpus } from "../src/managed-mail-corpus.ts";
import { searchManagedMail } from "../src/managed-mail-search.ts";
import {
  hexDigest,
  readManagedText,
  managedMailRuntime,
  type ManagedMailEnvironment,
} from "../src/managed-search-runtime.ts";
import { readMailResource } from "../src/mail-read.ts";
import { dispatchMailTool } from "../src/mcp.ts";
import type { MailPrincipal } from "../src/principal.ts";

const reader: MailPrincipal = { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] };
const config = {
  version: 1,
  enabled: true,
  revision: "synthetic-v1",
  instanceId: "synthetic-corpus",
  maxUploads: 10,
  maxQueries: 10,
  hybrid: true,
};
const base = "https://mail.example.invalid";
const encode = (text: string) => new TextEncoder().encode(text);
async function object(text: string, role: string) {
  const bytes = encode(text),
    sha256 = await hexDigest(bytes),
    key = `synthetic/managed/${role}/${sha256}`;
  await env.MAIL_ARCHIVE.put(key, bytes, { sha256 });
  return { key, sha256, size: bytes.length };
}
async function source(
  id = "one",
  text = "振込期限は来週の月曜日です。Invoice amount 12,345 yen.",
  rawKey?: string,
) {
  const raw = await object(`Synthetic original ${id}`, `raw/${id}`),
    body = await object(text, "body-text");
  if (rawKey) {
    await env.MAIL_ARCHIVE.put(rawKey, encode(`Synthetic original ${id}`), { sha256: raw.sha256 });
    raw.key = rawKey;
  }
  const manifest = await object(
    JSON.stringify({ rawSha256: raw.sha256, body: { text: body } }),
    "manifest",
  );
  await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,
    raw_sha256,raw_state,receipt_state,observed_pass,observed_revision) VALUES('email_routing','ingress-v1',?,?,?,'2026-11-12T00:00:00.000Z',?,'present','missing',0,0)`)
    .bind(id, raw.key, `${raw.key}.receipt`, raw.sha256)
    .run();
  await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,
    attachments_json,attachment_count,body_json_key,body_text_key,manifest_key,updated_at) VALUES(?,'mime-v1',?,1,?,'complete',?,'[]',0,'synthetic/body-json',?,?,0)`)
    .bind(
      raw.key,
      raw.sha256,
      id,
      JSON.stringify({
        subject: `Synthetic ${id}`,
        from: { address: "sender@example.invalid" },
        to: [],
      }),
      body.key,
      manifest.key,
    )
    .run();
  return { raw, body, manifest, text };
}
const canonical = (number: number, day = "2026-11-12") =>
  `ingest/${day}/00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}/raw.eml`;
async function convertedFixture(original: Awaited<ReturnType<typeof source>>) {
  const kinds = [
    ["application/zip", "local_zip_text"],
    ["application/pdf", "managed_ocr_indexed_text"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "managed_document_text",
    ],
    ["image/png", "managed_ocr_indexed_text"],
  ] as const;
  const parts = await Promise.all(
    kinds.map(async ([mimeType, representation], index) => ({
      index,
      mimeType,
      representation,
      original: await object(
        `Synthetic original attachment ${index}`,
        `targeted-original-${index}`,
      ),
      derivative: await object(
        `選択した添付 ${index} Invoice amount 12,345 yen.`,
        `targeted-text-${index}`,
      ),
    })),
  );
  const attachments = parts.map((part) => ({
    index: part.index,
    ...part.original,
    mimeType: part.mimeType,
  }));
  const manifest = await object(
    JSON.stringify({ rawSha256: original.raw.sha256, body: { text: original.body }, attachments }),
    "targeted-manifest",
  );
  await env.MAIL_CATALOG.prepare(
    "UPDATE mail_extractions SET manifest_key=?,attachments_json=?,attachment_count=4 WHERE raw_key=?",
  )
    .bind(manifest.key, JSON.stringify(attachments), original.raw.key)
    .run();
  await Promise.all(
    parts.map((part) =>
      env.MAIL_CATALOG.prepare(`INSERT INTO attachment_conversions(raw_key,mime_sha256,part_index,manifest_key,source_key,source_sha256,source_size,
    source_mime,policy_hash,state,result_key,result_sha256,result_size,representation,provenance_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'complete',?,?,?,?,'{}',0)`)
        .bind(
          original.raw.key,
          original.raw.sha256,
          part.index,
          manifest.key,
          part.original.key,
          part.original.sha256,
          part.original.size,
          part.mimeType,
          "synthetic-conversion-v1",
          part.derivative.key,
          part.derivative.sha256,
          part.derivative.size,
          part.representation,
        )
        .run(),
    ),
  );
  return parts;
}
function provider() {
  const items = new Map<string, { key: string; bytes: Uint8Array }>();
  const upload = vi.fn(async (key: string, blob: Blob) => {
    const id = `item-${items.size}`;
    items.set(id, { key, bytes: new Uint8Array(await blob.arrayBuffer()) });
    return { id, key, status: "queued" };
  });
  const info = vi.fn(async () => ({
    id: config.instanceId,
    index_method: { vector: true, keyword: true },
  }));
  const search = vi.fn(async (_args: AiSearchSearchRequest) => ({
    search_query: "synthetic",
    chunks: [...items.values()].map((item) => ({
      id: `chunk-${item.key}`,
      type: "text",
      score: 0.9,
      text: new TextDecoder().decode(item.bytes),
      item: { key: item.key },
    })),
  }));
  const binding = {
    info,
    items: {
      upload,
      get: (id: string) => ({
        info: async () => ({ id, key: items.get(id)?.key, status: "completed" }),
      }),
    },
    search,
  };
  return { binding, upload, search, info, items };
}
const runtime = (
  binding: ReturnType<typeof provider>["binding"],
  patch: Record<string, unknown> = {},
): ManagedMailEnvironment => ({
  ...env,
  MANAGED_MAIL_SEARCH: binding,
  MANAGED_MAIL_SEARCH_CONFIG: JSON.stringify({ ...config, ...patch }),
});
async function ready(context: ManagedMailEnvironment, now = Date.now()) {
  await repairManagedMailCorpus(context, now);
  await repairManagedMailCorpus(context, now + 300001);
}
beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
  // Stable projection contract from the independently reviewed optional migration0011.
  // IF NOT EXISTS also exercises the real table when this branch is integrated with conversion.
  await env.MAIL_CATALOG.prepare(`CREATE TABLE IF NOT EXISTS attachment_conversions(raw_key TEXT,mime_sha256 TEXT NOT NULL,part_index INTEGER,manifest_key TEXT,
    source_key TEXT,source_sha256 TEXT,source_size INTEGER,source_mime TEXT,policy_hash TEXT,state TEXT,
    result_key TEXT,result_sha256 TEXT,result_size INTEGER,representation TEXT,provenance_json TEXT,updated_at INTEGER DEFAULT 0,PRIMARY KEY(raw_key,part_index))`).run();
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM mail_extractions; DELETE FROM archive_sources; DELETE FROM managed_mail_calls; DELETE FROM attachment_conversions;",
  );
});
describe("optional managed body corpus and semantic retrieval", () => {
  it("makes no provider call or ingestion without private opt-in and requires mail:read", async () => {
    await source();
    const remote = provider();
    expect(await repairManagedMailCorpus({ ...env, MANAGED_MAIL_SEARCH: remote.binding })).toEqual({
      enabled: false,
      processed: 0,
    });
    expect(remote.info).not.toHaveBeenCalled();
    expect(remote.upload).not.toHaveBeenCalled();
    await expect(searchManagedMail(env, reader, { query: "deadline" }, base)).rejects.toMatchObject(
      { code: "managed_search_not_configured" },
    );
    await expect(
      searchManagedMail(
        runtime(remote.binding),
        { ...reader, scopes: [] },
        { query: "deadline" },
        base,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(remote.search).not.toHaveBeenCalled();
  });
  it("uploads exact verified text once, polls durably, and returns semantic/hybrid evidence with original-byte citations through MCP", async () => {
    const original = await source();
    const remote = provider(),
      context = runtime(remote.binding);
    await ready(context);
    expect(
      remote.upload,
      JSON.stringify(
        (
          await env.MAIL_CATALOG.prepare(
            "SELECT part,state,failure_code FROM managed_mail_documents",
          ).all()
        ).results,
      ),
    ).toHaveBeenCalledTimes(1);
    expect([...remote.items.values()][0]!.bytes).toEqual(encode(original.text));
    const result = await searchManagedMail(
      context,
      reader,
      { query: "支払日はいつですか", mode: "semantic" },
      base,
    );
    expect(result.matches[0]!.excerpt).toBe(original.text);
    const citation = result.matches[0]!.citation;
    const resource = await readMailResource(
      new Request(citation.file_uri),
      env,
      reader,
      "mail_one",
      "text",
    );
    expect(await hexDigest(await resource.arrayBuffer())).toBe(citation.sha256);
    expect(citation.raw_sha256).toBe(original.raw.sha256);
    expect(remote.search.mock.calls[0]![0]).toMatchObject({
      ai_search_options: {
        retrieval: { retrieval_type: "vector", return_on_failure: false },
        query_rewrite: { enabled: false },
        reranking: { enabled: false },
        cache: { enabled: false },
      },
    });
    const result2 = await dispatchMailTool(
      "search_mail_semantic",
      { query: "payment deadline", mode: "hybrid" },
      { ...env, ...context },
      reader,
      base,
    );
    expect(result2["matches"] as unknown[]).toHaveLength(1);
    expect(remote.search.mock.calls[1]![0]).toMatchObject({
      ai_search_options: { retrieval: { retrieval_type: "hybrid" } },
    });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
    ).toEqual({ count: 0 });
  });
  it("rejects hallucinated provider text and unmapped remote keys and does not expose stale/corrupt sources", async () => {
    const original = await source();
    const remote = provider(),
      context = runtime(remote.binding);
    await ready(context);
    remote.search.mockResolvedValueOnce({
      search_query: "synthetic",
      chunks: [
        {
          id: "fake",
          type: "text",
          score: 0.9,
          text: "Invented invoice amount",
          item: { key: [...remote.items.values()][0]!.key },
        },
      ],
    });
    expect((await searchManagedMail(context, reader, { query: "invoice" }, base)).matches).toEqual(
      [],
    );
    remote.search.mockResolvedValueOnce({
      search_query: "synthetic",
      chunks: [
        {
          id: "fake",
          type: "text",
          score: 0.9,
          text: original.text,
          item: { key: "unrelated-private-source" },
        },
      ],
    });
    expect((await searchManagedMail(context, reader, { query: "invoice" }, base)).matches).toEqual(
      [],
    );
    await env.MAIL_ARCHIVE.put(original.body.key, "tampered");
    expect((await searchManagedMail(context, reader, { query: "invoice" }, base)).matches).toEqual(
      [],
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET manifest_key='replacement' WHERE raw_key=?",
    )
      .bind(original.raw.key)
      .run();
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS count FROM managed_mail_documents",
      ).first(),
    ).toEqual({ count: 0 });
  });
  it("applies archive metadata filters locally to bounded top candidates and states incomplete coverage", async () => {
    await source();
    const remote = provider(),
      context = runtime(remote.binding);
    await ready(context);
    const result = await searchManagedMail(
      context,
      reader,
      { query: "invoice", filters: 'subject:"does not match"' },
      base,
    );
    expect(result.matches).toEqual([]);
    expect(result.coverage).toMatchObject({
      postfiltered_top_candidates: true,
      exhaustive: false,
      pagination_supported: false,
      binary_attachments_included: false,
    });
    expect(
      (await searchManagedMail(context, reader, { query: "invoice", label_ids: ["SENT"] }, base))
        .matches,
    ).toEqual([]);
  });
  it("reserves a finite upload/query budget and never resubmits an ambiguous upload", async () => {
    await source();
    const remote = provider(),
      context = runtime(remote.binding, { maxQueries: 1 });
    remote.upload.mockRejectedValueOnce(new Error("private provider data"));
    await ready(context);
    expect(remote.upload).toHaveBeenCalledTimes(1);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT state,failure_code FROM managed_mail_documents",
      ).first(),
    ).toEqual({ state: "unknown", failure_code: "upload_outcome_unknown" });
    await searchManagedMail(context, reader, { query: "invoice" }, base);
    await expect(
      searchManagedMail(context, reader, { query: "invoice" }, base),
    ).rejects.toMatchObject({ code: "managed_search_budget_exhausted" });
    expect(remote.search).toHaveBeenCalledTimes(1);
  });
  it("fences concurrent ingestion and stale completion after MIME invalidation", async () => {
    const original = await source();
    const remote = provider(),
      context = runtime(remote.binding);
    remote.upload.mockImplementationOnce(async (key: string) => {
      await env.MAIL_CATALOG.prepare(
        "UPDATE mail_extractions SET manifest_key='replacement' WHERE raw_key=?",
      )
        .bind(original.raw.key)
        .run();
      return { id: "old-item", key, status: "queued" };
    });
    await Promise.all([repairManagedMailCorpus(context), repairManagedMailCorpus(context)]);
    expect(remote.upload).toHaveBeenCalledTimes(1);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS count FROM managed_mail_documents",
      ).first(),
    ).toEqual({ count: 0 });
  });
  it("checks the configured instance and blocks oversized body coverage without upload", async () => {
    await source("large", "x".repeat(1024 * 1024 + 1));
    const remote = provider(),
      context = runtime(remote.binding);
    await repairManagedMailCorpus(context);
    expect(remote.upload).not.toHaveBeenCalled();
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT state,failure_code FROM managed_mail_documents",
      ).first(),
    ).toEqual({ state: "blocked", failure_code: "managed_search_body_limit" });
    remote.info.mockResolvedValueOnce({
      id: "wrong-instance",
      index_method: { vector: true, keyword: true },
    });
    await expect(
      searchManagedMail(context, reader, { query: "invoice" }, base),
    ).rejects.toMatchObject({ code: "managed_search_instance_mismatch" });
    expect(remote.search).not.toHaveBeenCalled();
  });
  it("ingests completed OCR text with separate original and derived citations, and excludes changed conversion policy", async () => {
    const original = await source(),
      attachment = await object("Synthetic original scanned document", "attachment");
    const derivative = await object("Scanned invoice total 98,765 yen.", "ocr-text");
    const manifest = await object(
      JSON.stringify({
        rawSha256: original.raw.sha256,
        body: { text: original.body },
        attachments: [{ index: 0, ...attachment, mimeType: "application/pdf" }],
      }),
      "manifest",
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET manifest_key=?,attachments_json=?,attachment_count=1 WHERE raw_key=?",
    )
      .bind(
        manifest.key,
        JSON.stringify([{ index: 0, ...attachment, mimeType: "application/pdf" }]),
        original.raw.key,
      )
      .run();
    await env.MAIL_CATALOG.prepare(`INSERT INTO attachment_conversions(raw_key,mime_sha256,part_index,manifest_key,source_key,source_sha256,source_size,
      source_mime,policy_hash,state,result_key,result_sha256,result_size,representation,provenance_json,updated_at) VALUES(?,?,0,?,?,?,?,'application/pdf','conversion-v1','complete',?,?,?,'managed_ocr_indexed_text','{}',0)`)
      .bind(
        original.raw.key,
        original.raw.sha256,
        manifest.key,
        attachment.key,
        attachment.sha256,
        attachment.size,
        derivative.key,
        derivative.sha256,
        derivative.size,
      )
      .run();
    const remote = provider(),
      context = runtime(remote.binding);
    await ready(context);
    expect(remote.upload).toHaveBeenCalledTimes(2);
    const result = await searchManagedMail(context, reader, { query: "scanned receipt" }, base);
    const match = result.matches.find((item) => item.citation.part === "part_0")!;
    expect(match.excerpt).toBe("Scanned invoice total 98,765 yen.");
    expect(match.citation).toMatchObject({
      sha256: derivative.sha256,
      original_sha256: attachment.sha256,
      representation: "managed_ocr_indexed_text",
      file_uri: `${base}/api/mail/mail_one/conversions/part_0/${derivative.sha256}`,
      original_file_uri: `${base}/api/mail/mail_one/attachments/part_0`,
    });
    await env.MAIL_CATALOG.prepare(
      "UPDATE attachment_conversions SET policy_hash='conversion-revoked' WHERE raw_key=?",
    )
      .bind(original.raw.key)
      .run();
    expect(
      (await searchManagedMail(context, reader, { query: "scanned receipt" }, base)).matches.some(
        (item) => item.citation.part === "part_0",
      ),
    ).toBe(false);
    await ready(context, Date.now() + 600000);
    expect(remote.upload).toHaveBeenCalledTimes(2); // Same verified text reuses its durable remote item.
  });
  it("polls already submitted parts before a sustained new-source backlog", async () => {
    const original = await source("z-submitted"),
      remote = provider(),
      context = runtime(remote.binding),
      now = Date.now();
    await repairManagedMailCorpus(context, now);
    await source("a-pending");
    await source("b-pending");
    await source("c-pending");
    await repairManagedMailCorpus(context, now + 300001);
    expect(remote.upload).toHaveBeenCalledTimes(2);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT state FROM managed_mail_documents WHERE raw_key=? AND part='body'",
      )
        .bind(original.raw.key)
        .first("state"),
    ).toBe("ready");
  });
  it("retains ambiguous upload identities across MIME invalidation and recovers known item IDs without uploading twice", async () => {
    const original = await source(),
      remote = provider(),
      context = runtime(remote.binding),
      now = Date.now();
    remote.upload.mockRejectedValueOnce(new Error("synthetic lost response"));
    await repairManagedMailCorpus(context, now);
    const rebuiltBody = await object(original.text, "rebuilt-body");
    const rebuiltManifest = await object(
      JSON.stringify({ rawSha256: original.raw.sha256, body: { text: rebuiltBody } }),
      "rebuilt-manifest",
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET status='blocked',failure_code='source_missing' WHERE raw_key=?",
    )
      .bind(original.raw.key)
      .run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET status='complete',failure_code=NULL,body_text_key=?,manifest_key=? WHERE raw_key=?",
    )
      .bind(rebuiltBody.key, rebuiltManifest.key, original.raw.key)
      .run();
    await repairManagedMailCorpus(context, now + 300001);
    expect(remote.upload).toHaveBeenCalledTimes(1);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM managed_mail_documents WHERE raw_key=?")
        .bind(original.raw.key)
        .first("state"),
    ).toBe("unknown");
    const known = await source("known");
    await ready(context, now + 600001);
    const count = remote.upload.mock.calls.length;
    const knownBody = await object(known.text, "known-rebuilt-body");
    const knownManifest = await object(
      JSON.stringify({ rawSha256: known.raw.sha256, body: { text: knownBody } }),
      "known-rebuilt-manifest",
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET status='blocked',failure_code='source_missing' WHERE raw_key=?",
    )
      .bind(known.raw.key)
      .run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET status='complete',failure_code=NULL,body_text_key=?,manifest_key=? WHERE raw_key=?",
    )
      .bind(knownBody.key, knownManifest.key, known.raw.key)
      .run();
    await ready(context, now + 1200001);
    expect(remote.upload).toHaveBeenCalledTimes(count);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM managed_mail_documents WHERE raw_key=?")
        .bind(known.raw.key)
        .first("state"),
    ).toBe("ready");
  });
  it("bounds R2 object lookup and never waits for oversize cancellation", async () => {
    vi.useFakeTimers();
    try {
      const stalled = { get: () => new Promise<never>(() => undefined) } as unknown as R2Bucket;
      const check = expect(
        readManagedText(stalled, "synthetic", "a".repeat(64)),
      ).rejects.toMatchObject({ code: "managed_search_source_unavailable" });
      await vi.advanceTimersByTimeAsync(5001);
      await check;
      const hangingStream = new ReadableStream<Uint8Array>({
        cancel: () => new Promise<void>(() => undefined),
      });
      const unreadable = {
        get: async () => ({ size: 1, body: hangingStream }),
      } as unknown as R2Bucket;
      const streamCheck = expect(
        readManagedText(unreadable, "synthetic", "a".repeat(64)),
      ).rejects.toMatchObject({ code: "managed_search_source_unavailable" });
      await vi.advanceTimersByTimeAsync(5001);
      await streamCheck;
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const oversized = {
        get: async () => ({ size: 1024 * 1024 + 1, body: { cancel } }),
      } as unknown as R2Bucket;
      await expect(readManagedText(oversized, "synthetic", "a".repeat(64))).rejects.toMatchObject({
        code: "managed_search_source_unavailable",
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not let stale conversion rows starve later eligible sources", async () => {
    for (const id of ["a-poison", "b-poison", "c-poison"]) {
      // oxlint-disable-next-line no-await-in-loop -- Three earlier stale conversion fixtures exercise bounded discovery fairness.
      const original = await source(id);
      // oxlint-disable-next-line no-await-in-loop -- A stale complete conversion no longer belongs to the current MIME parts.
      await env.MAIL_CATALOG.prepare(
        "UPDATE mail_extractions SET body_text_key=NULL WHERE raw_key=?",
      )
        .bind(original.raw.key)
        .run();
      // oxlint-disable-next-line no-await-in-loop -- Fixture metadata only; no source bytes or provider calls.
      await env.MAIL_CATALOG.prepare(`INSERT INTO attachment_conversions(raw_key,mime_sha256,part_index,manifest_key,source_key,source_sha256,source_size,source_mime,
        policy_hash,state,result_key,result_sha256,result_size,representation,provenance_json,updated_at) VALUES(?,?,0,?,'stale',?,0,'application/pdf','stale','complete','stale',?,0,'managed_ocr_indexed_text','{}',0)`)
        .bind(
          original.raw.key,
          original.raw.sha256,
          original.manifest.key,
          "a".repeat(64),
          "b".repeat(64),
        )
        .run();
    }
    await source("z-healthy");
    const remote = provider();
    await ready(runtime(remote.binding));
    expect(remote.upload).toHaveBeenCalledTimes(1);
  });

  it("targets only the approved source before discovery limits and indexes its body plus four converted parts", async () => {
    await Promise.all(
      [1, 2, 3].map((index) =>
        source(`backlog_${index}`, "Unrelated older backlog", canonical(index, "2026-11-11")),
      ),
    );
    const selected = await source("selected", "選択した本文 invoice 12,345 yen.", canonical(4));
    const parts = await convertedFixture(selected);
    const remote = provider(),
      context = runtime(remote.binding, { sourceRawKeys: [selected.raw.key], maxUploads: 5 });
    const now = Date.now();
    for (let round = 0; round < 3; round++) {
      // oxlint-disable-next-line no-await-in-loop -- The existing two-part bounded worker deliberately needs three upload/poll rounds.
      await ready(context, now + round * 600002);
    }
    expect(remote.upload).toHaveBeenCalledTimes(5);
    expect(
      (await env.MAIL_CATALOG.prepare("SELECT DISTINCT raw_key FROM managed_mail_documents").all())
        .results,
    ).toEqual([{ raw_key: selected.raw.key }]);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS count FROM managed_mail_calls WHERE kind='upload'",
      ).first(),
    ).toEqual({ count: 5 });
    const result = await searchManagedMail(
      context,
      reader,
      { query: "請求額", mode: "hybrid" },
      base,
    );
    expect(result.matches).toHaveLength(5);
    expect(result.coverage).toMatchObject({
      source_scope: "administrator_allowlist",
      exhaustive: false,
    });
    for (const part of parts) {
      const match = result.matches.find((item) => item.citation.part === `part_${part.index}`)!;
      expect(match.message_id).toBe("mail_selected");
      expect(match.citation).toMatchObject({
        sha256: part.derivative.sha256,
        original_sha256: part.original.sha256,
        raw_sha256: selected.raw.sha256,
        representation: part.representation,
      });
    }
  });

  it("makes zero uploads or projection rows for a missing approved source", async () => {
    await source("unrelated", "unrelated", canonical(1));
    const remote = provider(),
      context = runtime(remote.binding, { sourceRawKeys: [canonical(9)] });
    expect(await repairManagedMailCorpus(context)).toMatchObject({ enabled: true, processed: 0 });
    expect(remote.upload).not.toHaveBeenCalled();
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS count FROM managed_mail_documents",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM managed_mail_calls").first(),
    ).toEqual({ count: 0 });
  });

  it("rejects invalid allowlists before provider contact and keeps absent-field hashes compatible and set-order stable", async () => {
    const remote = provider();
    expect((await managedMailRuntime(runtime(remote.binding)))!.policy).toBe(
      await hexDigest(encode(JSON.stringify(config))),
    );
    const first = await managedMailRuntime(
      runtime(remote.binding, { sourceRawKeys: [canonical(2), canonical(1)] }),
    );
    const second = await managedMailRuntime(
      runtime(remote.binding, { sourceRawKeys: [canonical(1), canonical(2)] }),
    );
    expect(first!.policy).toBe(second!.policy);
    expect(first!.policy).not.toBe((await managedMailRuntime(runtime(remote.binding)))!.policy);
    const variants = [
      [],
      [canonical(1), canonical(1)],
      Array.from({ length: 11 }, (_, index) => canonical(index + 1)),
      [canonical(1).replace("raw.eml", "receipt.json")],
      [canonical(1, "2026-02-30")],
      ["ingest/"],
      ["https://untrusted.example.invalid/source"],
      null,
    ];
    await Promise.all(
      variants.map(async (sourceRawKeys) => {
        await expect(
          repairManagedMailCorpus(runtime(remote.binding, { sourceRawKeys })),
        ).rejects.toMatchObject({ code: "invalid_managed_search_configuration" });
      }),
    );
    expect(remote.info).not.toHaveBeenCalled();
    expect(remote.upload).not.toHaveBeenCalled();
  });

  it("preserves old-policy ambiguous receipts and never retries their upload when targeting another source", async () => {
    const old = await source("old_unknown", "Old ambiguous bytes", canonical(1));
    const remote = provider(),
      unrestricted = runtime(remote.binding, { maxUploads: 1 });
    const now = Date.now();
    remote.upload.mockRejectedValueOnce(new Error("Synthetic unknown submission"));
    await repairManagedMailCorpus(unrestricted, now);
    const retained = await env.MAIL_CATALOG.prepare("SELECT * FROM managed_mail_calls").all();
    const selected = await source("new_selected", "New explicit targeted bytes", canonical(2));
    const restricted = runtime(remote.binding, {
      maxUploads: 1,
      sourceRawKeys: [selected.raw.key],
    });
    await ready(restricted, now + 300001);
    await ready(restricted, now + 900003);
    expect(remote.upload).toHaveBeenCalledTimes(2);
    const oldCall = retained.results[0]!;
    expect(
      await env.MAIL_CATALOG.prepare("SELECT * FROM managed_mail_calls WHERE call_id=?")
        .bind(oldCall["call_id"])
        .first(),
    ).toEqual(oldCall);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM managed_mail_documents WHERE raw_key=?")
        .bind(old.raw.key)
        .first("state"),
    ).toBe("unknown");
    await repairManagedMailCorpus(unrestricted, now + 1500005);
    expect(remote.upload).toHaveBeenCalledTimes(2);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM managed_mail_documents WHERE raw_key=?")
        .bind(old.raw.key)
        .first("state"),
    ).toBe("unknown");
  });

  it("postfilters out-of-scope current-policy rows before source reads and coverage even if the provider returns them", async () => {
    const outside = await source("outside", "Outside the approved source set", canonical(1));
    const remote = provider();
    await ready(runtime(remote.binding));
    const context = runtime(remote.binding, { sourceRawKeys: [canonical(2)] });
    const policy = (await managedMailRuntime(context))!.policy;
    await env.MAIL_CATALOG.prepare(
      "UPDATE managed_mail_documents SET policy_hash=? WHERE raw_key=?",
    )
      .bind(policy, outside.raw.key)
      .run();
    const reads: string[] = [];
    const bucket = {
      get: (key: string) => {
        reads.push(key);
        return env.MAIL_ARCHIVE.get(key);
      },
    } as unknown as R2Bucket;
    const result = await searchManagedMail(
      { ...context, MAIL_ARCHIVE: bucket },
      reader,
      { query: "Outside", mode: "semantic" },
      base,
    );
    expect(result.matches).toEqual([]);
    expect(result.coverage.documents).toEqual([]);
    expect(result.coverage.omitted_candidates).toBe(1);
    expect(reads).toEqual([]);
  });
});
