import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  commitPage,
  commitSource,
  readCheckpoint,
  type SourceObservation,
} from "../src/catalog.ts";
import { indexArchiveSource } from "../src/reconcile.ts";
import { beginProcessing, processingInstanceId } from "../src/processing-jobs.ts";
import { runGmailImportPage, startGmailImport } from "../src/gmail-import.ts";

const day = "2026-11-08";
const identifier = (number: number) =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const observation = (
  number: number,
  patch: Partial<SourceObservation> = {},
): SourceObservation => ({
  ingestId: identifier(number),
  rawKey: `ingest/${day}/${identifier(number)}/raw.eml`,
  receiptKey: `ingest/${day}/${identifier(number)}/receipt.json`,
  receivedAt: `${day}T00:00:00.000Z`,
  snapshot: null,
  forward: null,
  rawState: "present",
  receiptState: "missing",
  rawSize: 1,
  rawSha256: "a".repeat(64),
  notifyEvents: false,
  ...patch,
});
const session = () => env.MAIL_CATALOG.withSession("first-primary");
beforeAll(() => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM processing_jobs; DELETE FROM archive_sources; DELETE FROM archive_issues; DELETE FROM mail_events; UPDATE archive_scan SET cursor=NULL,pass=0,revision=0 WHERE id=1;",
  );
});

it.each([2, 25])(
  "commits %s unrelated sources from one checkpoint and preserves later event statements",
  async (count) => {
    const db = session(),
      checkpoint = await readCheckpoint(db);
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) => index + 1).map((number) =>
        commitSource(db, checkpoint, observation(number, { notifyEvents: true }), []),
      ),
    );
    expect(results).toEqual(
      Array.from({ length: count }, () => ({ committed: true, indexed: 1, issues: 0 })),
    );
    expect(await readCheckpoint(db)).toEqual({ cursor: null, revision: count, pass: 0 });
    const rows = (
      await env.MAIL_CATALOG.prepare(
        "SELECT observed_revision FROM archive_sources ORDER BY observed_revision",
      ).all<{ observed_revision: number }>()
    ).results;
    expect(rows.map((row) => row.observed_revision)).toEqual(
      Array.from({ length: count }, (_, index) => index),
    );
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
    ).toEqual({ count });
  },
);

it("rejects a stale same-source observation and every associated issue/event mutation", async () => {
  const db = session(),
    checkpoint = await readCheckpoint(db);
  const newer = observation(1, { rawState: "missing", rawSize: null, rawSha256: null });
  expect((await commitSource(db, checkpoint, newer, [])).committed).toBe(true);
  expect(
    await commitSource(db, checkpoint, observation(1, { notifyEvents: true }), [
      { key: newer.rawKey, code: "missing_raw" },
    ]),
  ).toEqual({ committed: false, indexed: 0, issues: 0 });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT raw_state,raw_sha256 FROM archive_sources").first(),
  ).toEqual({ raw_state: "missing", raw_sha256: null });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_issues").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
  ).toEqual({ count: 0 });
  expect((await readCheckpoint(db)).revision).toBe(1);
});

it("does not insert Gmail provenance or events behind a stale same-key observation", async () => {
  const db = session(),
    checkpoint = await readCheckpoint(db),
    target = observation(1);
  const newer = {
    ...target,
    sourceKind: "gmail" as const,
    sourceNamespace: "synthetic-cas",
    rawState: "invalid" as const,
    receiptState: "invalid" as const,
  };
  expect((await commitPage(db, checkpoint, [newer], [], "winner-cursor")).committed).toBe(true);
  const gmail = {
    schemaVersion: "gmail-import-v1" as const,
    accountNamespace: "synthetic-cas",
    messageId: "synthetic-message",
    threadId: "synthetic-thread",
    internalDate: String(Date.parse(target.receivedAt!)),
    labelIds: ["SENT"],
    importedAt: `${day}T01:00:00.000Z`,
    rawKey: target.rawKey,
    rawSize: 1,
    rawSha256: target.rawSha256!,
  };
  expect(
    await commitSource(db, checkpoint, { ...target, gmail, notifyEvents: true }, [
      { key: target.rawKey, code: "evidence_mismatch" },
    ]),
  ).toEqual({ committed: false, indexed: 0, issues: 0 });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM gmail_messages").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_issues").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.MAIL_CATALOG.prepare(
      "SELECT raw_state,receipt_state,notify_events FROM archive_sources",
    ).first(),
  ).toEqual({ raw_state: "invalid", receipt_state: "invalid", notify_events: 0 });
  expect(await readCheckpoint(db)).toEqual({ cursor: "winner-cursor", revision: 1, pass: 0 });
});

it("preserves previously authorized live event provenance when a later observation omits it", async () => {
  const db = session();
  expect(
    (await commitSource(db, await readCheckpoint(db), observation(1, { notifyEvents: true }), []))
      .committed,
  ).toBe(true);
  expect((await commitSource(db, await readCheckpoint(db), observation(1), [])).committed).toBe(
    true,
  );
  expect(
    await env.MAIL_CATALOG.prepare("SELECT notify_events FROM archive_sources").first(
      "notify_events",
    ),
  ).toBe(1);
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
  ).toEqual({ count: 1 });
});

it.each(["page", "source"] as const)(
  "orders a same-source %s winner against its stale competitor",
  async (first) => {
    const db = session(),
      checkpoint = await readCheckpoint(db);
    const newer = observation(1, { rawState: "invalid" });
    const commit =
      first === "page"
        ? commitPage(db, checkpoint, [newer], [], "winner-cursor")
        : commitSource(db, checkpoint, newer, []);
    expect((await commit).committed).toBe(true);
    const stale =
      first === "page"
        ? commitSource(db, checkpoint, observation(1), [{ key: "stale", code: "invalid_key" }])
        : commitPage(
            db,
            checkpoint,
            [observation(1)],
            [{ key: "stale", code: "invalid_key" }],
            "stale-cursor",
          );
    expect(await stale).toEqual({ committed: false, indexed: 0, issues: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT raw_state FROM archive_sources").first("raw_state"),
    ).toBe("invalid");
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_issues").first(),
    ).toEqual({ count: 0 });
    expect(await readCheckpoint(db)).toEqual({
      cursor: first === "page" ? "winner-cursor" : null,
      revision: 1,
      pass: 0,
    });
  },
);

it("allows an unrelated source after a page advances without restoring an older cursor or pass", async () => {
  const db = session(),
    first = await readCheckpoint(db);
  expect((await commitPage(db, first, [observation(2)], [], "next-page")).committed).toBe(true);
  expect((await commitSource(db, first, observation(1), [])).committed).toBe(true);
  expect(await readCheckpoint(db)).toEqual({ cursor: "next-page", revision: 2, pass: 0 });
  const second = await readCheckpoint(db);
  expect((await commitPage(db, second, [observation(3)], [], null)).committed).toBe(true);
  expect((await commitSource(db, second, observation(4), [])).committed).toBe(true);
  expect(await readCheckpoint(db)).toEqual({ cursor: null, revision: 4, pass: 1 });
});

it("keeps an obsolete Workflow attempt from publishing a source or advancing the global epoch", async () => {
  const target = observation(1),
    instance = processingInstanceId(target.rawKey);
  await env.MAIL_CATALOG.prepare(
    "INSERT INTO processing_jobs(raw_key,pipeline_version,instance_id,state,created_at,updated_at,next_check_at) VALUES(?,'mime-v1',?,'running',0,0,0)",
  )
    .bind(target.rawKey, instance)
    .run();
  const db = session(),
    checkpoint = await readCheckpoint(db);
  await env.MAIL_CATALOG.prepare("UPDATE processing_jobs SET state='failed' WHERE raw_key=?")
    .bind(target.rawKey)
    .run();
  expect(
    await commitSource(
      db,
      checkpoint,
      target,
      [{ key: target.rawKey, code: "missing_raw" }],
      instance,
    ),
  ).toEqual({ committed: false, indexed: 0, issues: 0 });
  expect(await readCheckpoint(db)).toEqual(checkpoint);
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_sources").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_issues").first(),
  ).toEqual({ count: 0 });
});

it("indexes canonical imported Gmail despite a competing unrelated commit on every metadata observation", async () => {
  const scope = {
    accountNamespace: "synthetic-cas",
    before: 1_800_000_000,
    includeSpamTrash: false,
  };
  const workflow = {
    createBatch: vi
      .fn()
      .mockImplementation(async ({ instances }: { instances: { id: string }[] }) => ({
        created: instances.map(({ id }) => ({ id })),
        errors: [],
      })),
    get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
  };
  const context = { ...env, MAIL_PROCESSING: workflow };
  await startGmailImport(context, "synthetic-cas", scope);
  await runGmailImportPage(
    context,
    {
      list: async () => ({ messages: [{ id: "synthetic-cas-message" }] }),
      getRaw: async () => ({
        id: "synthetic-cas-message",
        threadId: "synthetic-cas-thread",
        internalDate: String(Date.parse(`${day}T00:00:00.000Z`)),
        labelIds: ["SENT"],
        raw: btoa("Subject: Synthetic CAS\r\n\r\nSynthetic content\r\n"),
      }),
    },
    "synthetic-cas",
    scope,
  );
  const rawKey = (await env.MAIL_CATALOG.prepare("SELECT raw_key FROM gmail_messages").first<{
    raw_key: string;
  }>())!.raw_key;
  const instance = processingInstanceId(rawKey);
  expect(await beginProcessing(session(), { rawKey, pipelineVersion: "mime-v1", attempt: 0 })).toBe(
    true,
  );
  let competitors = 0;
  const bucket = {
    head: (key: string) => env.MAIL_ARCHIVE.head(key),
    get: async (key: string) => {
      const object = await env.MAIL_ARCHIVE.get(key),
        db = session();
      expect(
        (await commitSource(db, await readCheckpoint(db), observation(99), [])).committed,
      ).toBe(true);
      competitors++;
      return object;
    },
  } as unknown as R2Bucket;
  for (let attempt = 0; attempt < 6; attempt++) {
    // oxlint-disable-next-line no-await-in-loop -- Reproduce six formerly failing, independently competing catalog attempts.
    expect(await indexArchiveSource(bucket, env.MAIL_CATALOG, rawKey, instance)).toMatchObject({
      indexed: 1,
      issues: 0,
      rawState: "present",
      receiptState: "valid",
    });
  }
  expect(competitors).toBe(6);
  expect(
    await env.MAIL_CATALOG.prepare("SELECT message_id,label_ids_json FROM gmail_messages").first(),
  ).toEqual({ message_id: "synthetic-cas-message", label_ids_json: '["SENT"]' });
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
  ).toEqual({ count: 0 });
});
