import { env } from "cloudflare:workers";
import { applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMPORT_COVERAGE_SQL,
  runGmailImportPage,
  startGmailImport,
  type GmailImportEnvironment,
} from "../src/gmail-import.ts";
import { handleGmailImport } from "../src/gmail-import-http.ts";
import { processingInstanceId } from "../src/processing-jobs.ts";

// Synthetic provider IDs, namespaces and bodies only.
const scope = {
  accountNamespace: "coverage-account",
  before: 1_800_000_000,
  includeSpamTrash: true,
};
const operator = { id: "synthetic-operator", scopes: ["mail:import"], fromAddresses: [] };
const base = "https://mail.example.invalid/api/admin/gmail-import/";
const queued = {
  ...env,
  MAIL_PROCESSING: {
    createBatch: vi
      .fn()
      .mockImplementation(async ({ instances }: { instances: { id: string }[] }) => ({
        created: instances.map(({ id }) => ({ id })),
        errors: [],
      })),
    get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
  },
};
const body = btoa(
  "From: synthetic@example.invalid\r\nSubject: Coverage\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic coverage text\r\n",
);
function client(ids: string[]) {
  return {
    list: vi.fn(async () => ({ messages: ids.map((id) => ({ id })) })),
    getRaw: vi.fn(async (id: string) => ({
      id,
      threadId: "synthetic-thread",
      internalDate: "1700000000000",
      labelIds: ["SENT"],
      raw: body,
    })),
  };
}
/** Import one complete page; `processing` decides whether real Workflows run. */
async function importRun(
  importId: string,
  ids: string[],
  processing: GmailImportEnvironment = queued,
) {
  const transport = client(ids);
  await startGmailImport(env, importId, scope);
  expect(await runGmailImportPage(processing, transport, importId, scope)).toMatchObject({
    status: "complete",
  });
  const keys = new Map<string, string>();
  for (const id of ids) {
    // oxlint-disable-next-line no-await-in-loop -- Small synthetic lookup.
    const key = await env.MAIL_CATALOG.prepare(
      "SELECT raw_key FROM gmail_import_items WHERE import_id=? AND message_id=?",
    )
      .bind(importId, id)
      .first<string>("raw_key");
    keys.set(id, key!);
  }
  return { transport, keys, runtime: { importId, scope, transport } };
}
async function status(runtime: Parameters<typeof handleGmailImport>[3], query = "") {
  const response = await handleGmailImport(
    new Request(`${base}status${query}`),
    env,
    operator,
    runtime,
  );
  return { code: response.status, body: (await response.json()) as Record<string, unknown> };
}
const emptyMime = {
  complete: 0,
  blocked: 0,
  failed: 0,
  pending: 0,
  unknown: 0,
  blocked_reasons: {},
  failed_reasons: {},
};
const emptyLexical = { ready: 0, retry: 0, pending: 0, not_applicable: 0, ready_with_omissions: 0 };
const emptyManaged = { ready: 0, in_progress: 0, attention: 0, none: 0 };

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.clearAllMocks();
  await env.MAIL_CATALOG.exec(
    "DELETE FROM managed_mail_documents; DELETE FROM mail_search_chunks; DELETE FROM mail_search_documents; DELETE FROM routing_shadow_decisions; DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM processing_jobs; DELETE FROM archive_sources; DELETE FROM mail_events;",
  );
  const objects = await env.MAIL_ARCHIVE.list();
  if (objects.objects.length) await env.MAIL_ARCHIVE.delete(objects.objects.map((o) => o.key));
});

describe("historical import downstream coverage", () => {
  it("separates archival completion from pending MIME extraction", async () => {
    const { runtime } = await importRun("pending-run", ["a1", "a2"]);
    expect(await status(runtime)).toEqual({
      code: 200,
      body: {
        status: "complete",
        imported_count: 2,
        revision: 1,
        pending_count: 0,
        busy: false,
        downstream: {
          window: {
            after: null,
            items: 2,
            limit: 1000,
            truncated: false,
            next_after: null,
            order: "provider_message_id",
          },
          archive: { original_present: 2, original_missing_or_unknown: 0 },
          mime: { ...emptyMime, pending: 2 },
          lexical_index: { ...emptyLexical, not_applicable: 2 },
          managed_corpus: { ...emptyManaged, none: 2 },
        },
      },
    });
  });

  it("reports blocked MIME by its coverage reason and failed jobs by fixed code", async () => {
    const { runtime, keys } = await importRun("failed-run", ["b1", "b2", "b3"]);
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO mail_extractions(raw_key,extractor_version,instance_id,status,failure_code,updated_at) VALUES (?,'mime-v1','synthetic-blocked','blocked','input_too_large',0)",
    )
      .bind(keys.get("b1"))
      .run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE processing_jobs SET state='failed',failure_code='workflow_failed' WHERE raw_key=?",
    )
      .bind(keys.get("b2"))
      .run();
    const { body: result } = await status(runtime);
    expect(result["downstream"]).toMatchObject({
      window: { items: 3, truncated: false },
      mime: {
        ...emptyMime,
        blocked: 1,
        failed: 1,
        pending: 1,
        blocked_reasons: { input_too_large: 1 },
        failed_reasons: { workflow_failed: 1 },
      },
      lexical_index: { ...emptyLexical, not_applicable: 3 },
    });
    // Neither the source key, the provider ID nor any message text is echoed.
    const text = JSON.stringify(result);
    expect(text).not.toContain("ingest/");
    expect(text).not.toContain("b1");
    expect(text).not.toContain("Synthetic coverage");
  });

  it("counts completed extraction and lexical indexing after the real Workflow", async () => {
    const { runtime, keys } = await importRun("indexed-run", ["c1"], env);
    await using instance = await introspectWorkflowInstance(
      env.MAIL_PROCESSING,
      processingInstanceId(keys.get("c1")!),
    );
    await instance.waitForStatus("complete");
    expect((await status(runtime)).body["downstream"]).toMatchObject({
      archive: { original_present: 1, original_missing_or_unknown: 0 },
      mime: { ...emptyMime, complete: 1 },
      lexical_index: { ...emptyLexical, ready: 1 },
      managed_corpus: { ...emptyManaged, none: 1 },
    });
  });

  it("classifies a mixed run and pages through items with a bounded cursor", async () => {
    const ids = ["d1", "d2", "d3", "d4", "d5", "d6"];
    const { runtime, keys } = await importRun("mixed-run", ids, env);
    for (const id of ids) {
      // oxlint-disable-next-line no-await-in-loop -- Wait for each synthetic Workflow.
      await using instance = await introspectWorkflowInstance(
        env.MAIL_PROCESSING,
        processingInstanceId(keys.get(id)!),
      );
      // oxlint-disable-next-line no-await-in-loop -- Wait for each synthetic Workflow.
      await instance.waitForStatus("complete");
    }
    const key = (id: string) => keys.get(id)!;
    // d1 stays indexed; d2 indexed with an omitted part; d3 deferred for retry;
    // d4 awaits indexing; d5 MIME is blocked; d6 original is no longer observed.
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare(
        `UPDATE mail_search_documents SET coverage_json=json_set(coverage_json,'$.omitted',json('["part_1:size_or_count_limit"]')) WHERE raw_key=?`,
      ).bind(key("d2")),
      env.MAIL_CATALOG.prepare(
        "UPDATE mail_search_documents SET status='retry',next_attempt_at=1 WHERE raw_key=?",
      ).bind(key("d3")),
      env.MAIL_CATALOG.prepare("DELETE FROM mail_search_documents WHERE raw_key=?").bind(key("d4")),
      env.MAIL_CATALOG.prepare(
        "UPDATE mail_extractions SET status='blocked',failure_code='parser_limit' WHERE raw_key=?",
      ).bind(key("d5")),
      env.MAIL_CATALOG.prepare(
        "UPDATE archive_sources SET raw_state='missing' WHERE raw_key=?",
      ).bind(key("d6")),
    ]);
    const managed = (id: string, part: string, state: string) =>
      env.MAIL_CATALOG.prepare(`INSERT INTO managed_mail_documents(raw_key,part,manifest_key,raw_sha256,text_key,text_sha256,
        original_key,original_sha256,representation,policy_hash,item_key,state,updated_at)
        VALUES (?,?,'synthetic-manifest','00','synthetic-text','00','synthetic-original','00','original_text','synthetic-policy',?,?,0)`).bind(
        key(id),
        part,
        `synthetic-${id}-${part}`,
        state,
      );
    await env.MAIL_CATALOG.batch([
      managed("d1", "body", "ready"),
      managed("d2", "body", "ready"),
      managed("d2", "part_1", "submitted"),
      managed("d3", "body", "blocked"),
    ]);
    const expected = {
      archive: { original_present: 5, original_missing_or_unknown: 1 },
      mime: {
        ...emptyMime,
        complete: 4,
        blocked: 1,
        unknown: 1,
        blocked_reasons: { parser_limit: 1 },
      },
      lexical_index: {
        ready: 2,
        ready_with_omissions: 1,
        retry: 1,
        pending: 1,
        not_applicable: 2,
      },
      managed_corpus: { ready: 1, in_progress: 1, attention: 1, none: 3 },
    };
    expect((await status(runtime)).body["downstream"]).toMatchObject({
      window: { after: null, items: 6, truncated: false, next_after: null },
      ...expected,
    });
    // The cursor is a position inside the configured run only.
    expect((await status(runtime, "?after=d3")).body["downstream"]).toMatchObject({
      window: { after: "d3", items: 3, truncated: false, next_after: null },
      mime: { complete: 1, blocked: 1, unknown: 1 },
    });
    for (const query of [
      "?after=",
      "?after=a/b",
      "?after=d1&after=d2",
      "?run=other",
      "?after=d1&x=1",
    ])
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic rejection checks.
      expect((await status(runtime, query)).code).toBe(400);
    expect(
      (
        await handleGmailImport(
          new Request(`${base}page?after=d1`, { method: "POST" }),
          env,
          operator,
          runtime,
        )
      ).status,
    ).toBe(400);
  });

  it("bounds each window to 1,000 items and continues from the last examined ID", async () => {
    const { runtime } = await importRun("large-run", ["e0000"]);
    // Membership rows without catalog evidence exercise only the window bound.
    const rows = Array.from({ length: 1000 }, (_, index) =>
      env.MAIL_CATALOG.prepare(
        "INSERT INTO gmail_import_items(import_id,message_id,raw_key) VALUES ('large-run',?,?)",
      ).bind(`e${String(index + 1).padStart(4, "0")}`, `synthetic-missing-${index}`),
    );
    await env.MAIL_CATALOG.batch(rows);
    // Another run's items never enter this run's window.
    await startGmailImport(env, "other-run", scope);
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO gmail_import_items(import_id,message_id,raw_key) VALUES ('other-run','e9999','synthetic-other')",
    ).run();
    const first = (await status(runtime)).body["downstream"] as {
      window: Record<string, unknown>;
      mime: Record<string, unknown>;
    };
    expect(first.window).toEqual({
      after: null,
      items: 1000,
      limit: 1000,
      truncated: true,
      next_after: "e0999",
      order: "provider_message_id",
    });
    expect(first.mime).toMatchObject({ pending: 1, unknown: 999 });
    expect((await status(runtime, "?after=e0999")).body["downstream"]).toMatchObject({
      window: { after: "e0999", items: 1, truncated: false, next_after: null },
      archive: { original_present: 0, original_missing_or_unknown: 1 },
    });
  });

  it("keeps archival status when the coverage read fails", async () => {
    const { runtime } = await importRun("degraded-run", ["f1"]);
    const catalog = new Proxy(env.MAIL_CATALOG, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property, target) as unknown;
        return (sql: string) => {
          if (sql === IMPORT_COVERAGE_SQL) throw new Error("synthetic private failure");
          return target.prepare(sql);
        };
      },
    });
    const response = await handleGmailImport(
      new Request(`${base}status`),
      { ...env, MAIL_CATALOG: catalog },
      operator,
      runtime,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "complete",
      imported_count: 1,
      revision: 1,
      pending_count: 0,
      busy: false,
      downstream: { status: "unknown", reason: "coverage_query_unavailable" },
    });
  });

  it("reads only key ranges and key lookups", async () => {
    const plan = await env.MAIL_CATALOG.prepare(`EXPLAIN QUERY PLAN ${IMPORT_COVERAGE_SQL}`)
      .bind("plan-run", "")
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH gmail_import_items USING .*INDEX \S+ \(import_id=\? AND message_id>\?\)$/,
      ),
    );
    // Each source table is reached by its primary or unique key from the bounded sample.
    for (const alias of ["s", "e", "j", "d", "m"])
      expect(details).toContainEqual(
        expect.stringMatching(new RegExp(`^SEARCH ${alias} USING .*INDEX \\S+ \\(raw_key=\\?`)),
      );
    // Only the bounded CTE samples are scanned.
    for (const detail of details.filter((d) => d.startsWith("SCAN")))
      expect(detail).toMatch(/^SCAN (observed|sample|i)$/);
  });
});
