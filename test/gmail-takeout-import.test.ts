import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureTakeoutWorkflow,
  runTakeoutChunk,
  startTakeoutRun,
  takeoutConfig,
  TAKEOUT_CHUNK_ENTRIES,
  type TakeoutConfig,
} from "../src/gmail-takeout-import.ts";
import { parseGmailProvenance } from "../src/gmail-provenance.ts";
import { reconcileArchive } from "../src/reconcile.ts";
import { GmailImportError } from "../src/gmail-transport.ts";

const workflow = {
  createBatch: vi
    .fn()
    .mockImplementation(async ({ instances }: { instances: { id: string }[] }) => ({
      created: instances.map(({ id }) => ({ id })),
      errors: [],
    })),
  get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
};
const env = { ...runtimeEnv, MAIL_PROCESSING: workflow };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const namespace = "synthetic-takeout";

// Synthetic entries only; the From_ dates are real weekdays.
const message = (n: number, body = `Body ${n}.`) =>
  `Message-ID: <m${n}@example.invalid>\r\nSubject: Synthetic ${n}\r\n\r\n${body}\r\n`;
const entry = (n: number, body?: string, labels = "Inbox,Opened") =>
  `From ${1_000_000 + n}@xxx Tue Jul 08 09:44:${String(n % 60).padStart(2, "0")} +0000 2025\r\n` +
  `X-GM-THRID: ${1_000_000 + (n - (n % 2))}\r\nX-Gmail-Labels: ${labels}\r\n${message(n, body)}\r\n`;
const mbox = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => entry(from + index)).join("");

async function upload(text: string, keys: string[]): Promise<TakeoutConfig["objects"]> {
  const bytes = encoder.encode(text);
  const size = Math.ceil(bytes.length / keys.length);
  const objects: TakeoutConfig["objects"] = [];
  for (const [index, key] of keys.entries()) {
    const part = bytes.subarray(index * size, Math.min(bytes.length, (index + 1) * size));
    // oxlint-disable-next-line no-await-in-loop -- Parts are uploaded in order.
    await env.TAKEOUT_ARCHIVE.put(key, part);
    objects.push({ key, size: part.length });
  }
  return objects;
}

const config = (runId: string, objects: TakeoutConfig["objects"], extra = {}): TakeoutConfig =>
  takeoutConfig({
    GMAIL_TAKEOUT_CONFIG: JSON.stringify({ runId, accountNamespace: namespace, objects, ...extra }),
  })!;

async function drain(run: TakeoutConfig) {
  await startTakeoutRun(env.MAIL_CATALOG, run);
  for (let i = 0; i < 20; i++) {
    // oxlint-disable-next-line no-await-in-loop -- Chunks advance one checkpoint in order.
    const result = await runTakeoutChunk(env, run);
    if (result.status !== "advanced") return result;
  }
  throw new Error("run did not finish");
}

const outcomes = async (runId: string) =>
  (
    await env.MAIL_CATALOG.prepare(
      "SELECT outcome,COUNT(*) AS n FROM gmail_takeout_items WHERE run_id=? GROUP BY outcome",
    )
      .bind(runId)
      .all<{ outcome: string; n: number }>()
  ).results.reduce<Record<string, number>>((all, row) => ({ ...all, [row.outcome]: row.n }), {});

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.clearAllMocks();
  for (const table of [
    "gmail_takeout_items",
    "gmail_takeout_runs",
    "gmail_takeout_labels",
    "gmail_messages",
    "archive_sources",
    "archive_issues",
    "processing_jobs",
  ])
    // oxlint-disable-next-line no-await-in-loop -- Delete items before their parent runs.
    await env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`).run();
  await env.MAIL_CATALOG.prepare("UPDATE archive_scan SET cursor=NULL,revision=0,pass=0").run();
  for (const bucket of [env.MAIL_ARCHIVE, env.TAKEOUT_ARCHIVE]) {
    // oxlint-disable-next-line no-await-in-loop -- Two buckets, emptied in turn.
    const objects = await bucket.list();
    // oxlint-disable-next-line no-await-in-loop -- Two buckets, emptied in turn.
    if (objects.objects.length) await bucket.delete(objects.objects.map((item) => item.key));
  }
});
afterEach(() => vi.restoreAllMocks());

describe("Google Takeout import", () => {
  it("imports every entry across objects and chunks with exact bytes, labels and receipts", async () => {
    const count = TAKEOUT_CHUNK_ENTRIES + 20;
    const objects = await upload(mbox(count), [
      "acct/2026-11-22/part-1.mbox",
      "acct/2026-11-22/part-2.mbox",
    ]);
    const run = config("run-1", objects);
    await startTakeoutRun(env.MAIL_CATALOG, run);
    const firstChunk = await runTakeoutChunk(env, run);
    expect(firstChunk).toMatchObject({ status: "advanced", processed: TAKEOUT_CHUNK_ENTRIES });
    expect(await drain(run)).toMatchObject({ status: "complete" });
    expect(await outcomes("run-1")).toEqual({ imported: count });
    expect(workflow.createBatch).toHaveBeenCalledTimes(count);
    const state = await env.MAIL_CATALOG.prepare(
      "SELECT next_offset,total_bytes,status FROM gmail_takeout_runs WHERE run_id='run-1'",
    ).first<{ next_offset: number; total_bytes: number; status: string }>();
    expect(state).toEqual({
      next_offset: encoder.encode(mbox(count)).length,
      total_bytes: encoder.encode(mbox(count)).length,
      status: "complete",
    });

    const row = await env.MAIL_CATALOG.prepare(
      `SELECT g.raw_key,g.thread_id,g.internal_date,g.label_ids_json,l.labels
      FROM gmail_messages g JOIN gmail_takeout_labels l ON l.raw_key=g.raw_key
      WHERE g.account_namespace=? AND g.message_id=?`,
    )
      .bind(namespace, (1_000_003).toString(16))
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      thread_id: (1_000_002).toString(16),
      internal_date: String(Date.parse("2025-07-08T09:44:03Z")),
      label_ids_json: "[]",
      labels: "Inbox,Opened",
    });
    const raw = await env.MAIL_ARCHIVE.get(row!["raw_key"]!);
    expect(decoder.decode(await raw!.arrayBuffer())).toBe(message(3));
    const receipt = await env.MAIL_ARCHIVE.get(
      row!["raw_key"]!.replace(/raw\.eml$/, "receipt.json"),
    );
    expect(parseGmailProvenance(await receipt!.json())).toMatchObject({
      schemaVersion: "gmail-takeout-v1",
      labelIds: [],
      takeout: { runId: "run-1", objectKey: "acct/2026-11-22/part-1.mbox", labels: "Inbox,Opened" },
    });

    // The reconciler accepts the receipts and rebuilds labels from them.
    await env.MAIL_CATALOG.prepare("DELETE FROM gmail_takeout_labels").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM gmail_messages").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources").run();
    // Each sweep call reads one bounded page of the archive bucket.
    for (let page = 0; page < 100; page++)
      // oxlint-disable-next-line no-await-in-loop -- Sweep pages are sequential.
      if ((await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).status === "complete") break;
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM archive_sources WHERE raw_state='present' AND receipt_state='valid'",
      ).first("n"),
    ).toBe(count);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM gmail_takeout_labels").first("n"),
    ).toBe(count);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM archive_issues").first("n"),
    ).toBe(0);
  });

  it("verifies messages that already exist and keeps their originals", async () => {
    const objects = await upload(mbox(5), ["a/part-1.mbox"]);
    expect(await drain(config("first", objects))).toMatchObject({ status: "complete" });
    const before = await env.MAIL_ARCHIVE.list();
    expect(await drain(config("again", objects))).toMatchObject({ status: "complete" });
    expect(await outcomes("again")).toEqual({ verified: 5 });
    expect((await env.MAIL_ARCHIVE.list()).objects.map((o) => o.etag)).toEqual(
      before.objects.map((o) => o.etag),
    );
  });

  it("stops at a changed copy of an existing message, then records it when told to", async () => {
    const first = await upload(mbox(3), ["a/first.mbox"]);
    await drain(config("first", first));
    const changed = entry(0) + entry(1, "Changed body.") + entry(2);
    const objects = await upload(changed, ["a/second.mbox"]);
    const conflictOffset = encoder.encode(entry(0)).length;
    expect(await drain(config("second", objects))).toEqual({
      status: "stopped",
      processed: 1,
      code: "takeout_raw_conflict",
      offset: conflictOffset,
    });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT next_offset FROM gmail_takeout_runs WHERE run_id='second'",
      ).first("next_offset"),
    ).toBe(conflictOffset);
    // The same run resumes with the conflict recorded, not replaced.
    expect(await drain(config("second", objects, { onConflict: "record" }))).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("second")).toEqual({ verified: 2, conflict: 1 });
    const key = await env.MAIL_CATALOG.prepare(
      "SELECT raw_key FROM gmail_takeout_items WHERE run_id='second' AND outcome='conflict'",
    ).first<string>("raw_key");
    expect(decoder.decode(await (await env.MAIL_ARCHIVE.get(key!))!.arrayBuffer())).toBe(
      message(1),
    );
    // Any other change to a run's source is refused.
    await expect(
      startTakeoutRun(env.MAIL_CATALOG, config("second", first, { onConflict: "record" })),
    ).rejects.toThrow(GmailImportError);
  });

  it("stops with a fixed code when an object or the mbox is not what was configured", async () => {
    const objects = await upload(mbox(2), ["a/part.mbox"]);
    expect(
      await drain(config("short", [{ key: "a/part.mbox", size: objects[0]!.size + 1 }])),
    ).toMatchObject({ status: "stopped", code: "takeout_object_size_mismatch", offset: 0 });

    const broken = mbox(2) + entry(2).slice(0, -2);
    const parts = await upload(broken, ["b/part.mbox"]);
    expect(await drain(config("cut", parts))).toEqual({
      status: "stopped",
      processed: 2,
      code: "takeout_missing_separator",
      offset: encoder.encode(mbox(2)).length,
    });
    expect(await outcomes("cut")).toEqual({ imported: 2 });
  });

  it("starts one Workflow instance per configured run from the cron", async () => {
    const objects = await upload(mbox(1), ["a/part.mbox"]);
    const instances = new Map<string, string>();
    const takeout = {
      create: vi.fn(async ({ id }: { id: string }) => {
        instances.set(id, "running");
        return { id } as WorkflowInstance;
      }),
      get: vi.fn(
        async (id: string) =>
          ({ status: async () => ({ status: instances.get(id) }) }) as WorkflowInstance,
      ),
    };
    const cron = { ...env, GMAIL_TAKEOUT: takeout };
    expect(await ensureTakeoutWorkflow(cron)).toEqual({ status: "none" });
    const GMAIL_TAKEOUT_CONFIG = JSON.stringify({
      runId: "cron",
      accountNamespace: namespace,
      objects,
    });
    expect(await ensureTakeoutWorkflow({ ...cron, GMAIL_TAKEOUT_CONFIG }, 1)).toEqual({
      status: "created",
    });
    expect(await ensureTakeoutWorkflow({ ...cron, GMAIL_TAKEOUT_CONFIG }, 2)).toEqual({
      status: "active",
    });
    instances.set("takeout-cron-1", "errored");
    expect(await ensureTakeoutWorkflow({ ...cron, GMAIL_TAKEOUT_CONFIG }, 3)).toEqual({
      status: "created",
    });
    expect(takeout.create.mock.calls.map(([options]) => options)).toEqual([
      { id: "takeout-cron-1", params: { runId: "cron" } },
      { id: "takeout-cron-3", params: { runId: "cron" } },
    ]);
  });

  it("refuses configurations with unsafe keys, duplicates or unknown fields", () => {
    const parse = (value: unknown) => () =>
      takeoutConfig({ GMAIL_TAKEOUT_CONFIG: JSON.stringify(value) });
    const base = {
      runId: "r",
      accountNamespace: namespace,
      objects: [{ key: "a/b.mbox", size: 1 }],
    };
    expect(parse(base)()).toMatchObject({ onConflict: "stop" });
    for (const bad of [
      { ...base, objects: [{ key: "../b.mbox", size: 1 }] },
      { ...base, objects: [{ key: "a b.mbox", size: 1 }] },
      { ...base, objects: [base.objects[0], base.objects[0]] },
      { ...base, objects: [] },
      { ...base, bucket: "fumi-mail" },
      { ...base, onConflict: "replace" },
    ])
      expect(parse(bad), JSON.stringify(bad)).toThrow(GmailImportError);
  });
});
