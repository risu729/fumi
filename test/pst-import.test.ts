import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import {
  ensurePstWorkflow,
  pstConfig,
  PstImportError,
  PST_CHUNK_ITEMS,
  runPstChunk,
  startPstRun,
  stopPstRun,
  type PstConfig,
} from "../src/pst-import.ts";
import { parsePstProvenance, pstIngestId } from "../src/pst-provenance.ts";
import { pstStepError } from "../src/pst-import-workflow.ts";
import { reconcileArchive } from "../src/reconcile.ts";

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
const namespace = `outlook-${"0a".repeat(12)}`;
const prefix = `${namespace}/2026-11-28`;
const manifestKey = `${prefix}/manifest.jsonl`;
const exportSha256 = "e".repeat(64);
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

// Synthetic items only.
const message = (n: number, body = `Body ${n}.`) =>
  `Message-ID: <pst${n}@example.invalid>\r\nSubject: Synthetic ${n}\r\nDate: Tue, 08 Jul 2025 09:44:00 +0000\r\n\r\n${body}\r\n`;
interface Item {
  n: number;
  body?: string;
  folder?: string[];
  headers?: "transport" | "synthesized";
  itemKind?: "note" | "schedule" | "report";
  deliveredAt?: string;
}
const deliveredAt = (n: number) =>
  new Date(Date.parse("2025-07-08T09:44:00.000Z") + n * 1000 + 123).toISOString();

/** Uploads the items and their manifest as the converter lays them out. */
async function upload(
  items: Item[],
  options: { exportSha?: string; edit?: (lines: Record<string, unknown>[]) => void } = {},
) {
  const lines: Record<string, unknown>[] = [];
  for (const [index, item] of items.entries()) {
    const line = index + 1;
    const key = `${prefix}/items/${String(line).padStart(6, "0")}.eml`;
    const bytes = encoder.encode(message(item.n, item.body));
    // oxlint-disable-next-line no-await-in-loop -- Items are uploaded in order.
    await env.TAKEOUT_ARCHIVE.put(key, bytes);
    lines.push({
      line,
      key,
      size: bytes.byteLength,
      // oxlint-disable-next-line no-await-in-loop -- See above.
      sha256: hex(await crypto.subtle.digest("SHA-256", bytes)),
      pstNodeId: 2_097_152 + item.n * 32,
      folder: item.folder ?? ["Inbox"],
      itemKind: item.itemKind ?? "note",
      deliveredAt: item.deliveredAt ?? deliveredAt(item.n),
      headers: item.headers ?? "transport",
      exportSha256: options.exportSha ?? exportSha256,
      converter: "readpst 0.6.76 -j 0 -e -D; pypff 20180714",
    });
  }
  options.edit?.(lines);
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  await env.TAKEOUT_ARCHIVE.put(manifestKey, text);
  return encoder.encode(text).byteLength;
}
const items = (count: number, from = 0): Item[] =>
  Array.from({ length: count }, (_, index) => ({ n: from + index }));

const config = (runId: string, size: number, extra = {}): PstConfig =>
  pstConfig({
    PST_IMPORT_CONFIG: JSON.stringify({
      runId,
      accountNamespace: namespace,
      manifest: { key: manifestKey, size },
      ...extra,
    }),
  })!;

async function drain(run: PstConfig, limits?: { bufferBytes?: number; readBytes?: number }) {
  await startPstRun(env.MAIL_CATALOG, run);
  for (let i = 0; i < 20; i++) {
    // oxlint-disable-next-line no-await-in-loop -- Chunks advance one checkpoint in order.
    const result = await runPstChunk(env, run, limits);
    if (result.status !== "advanced") return result;
  }
  throw new Error("run did not finish");
}

const outcomes = async (runId: string) =>
  (
    await env.MAIL_CATALOG.prepare(
      "SELECT outcome,COUNT(*) AS n FROM pst_import_items WHERE run_id=? GROUP BY outcome",
    )
      .bind(runId)
      .all<{ outcome: string; n: number }>()
  ).results.reduce<Record<string, number>>((all, row) => ({ ...all, [row.outcome]: row.n }), {});
const count = async (sql: string) => env.MAIL_CATALOG.prepare(sql).first<number>("n");

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.clearAllMocks();
  for (const table of [
    "pst_import_items",
    "pst_import_runs",
    "pst_messages",
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

describe("Outlook PST import", () => {
  it("imports every item across chunks with exact bytes, folders and receipts", async () => {
    const total = PST_CHUNK_ITEMS + 10;
    const list = items(total);
    list[3] = { n: 3, folder: ["受信トレイ", "Sub"], headers: "synthesized", itemKind: "schedule" };
    const size = await upload(list);
    const run = config("run-1", size);
    await startPstRun(env.MAIL_CATALOG, run);
    expect(await runPstChunk(env, run)).toMatchObject({
      status: "advanced",
      processed: PST_CHUNK_ITEMS,
    });
    expect(await drain(run)).toMatchObject({ status: "complete", nextLine: total + 1 });
    expect(await outcomes("run-1")).toEqual({ imported: total });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT next_offset,next_line,export_sha256,status FROM pst_import_runs WHERE run_id='run-1'",
      ).first(),
    ).toEqual({
      next_offset: size,
      next_line: total + 1,
      export_sha256: exportSha256,
      status: "complete",
    });
    const dispatched = workflow.createBatch.mock.calls.flatMap((call) =>
      (call[0] as { instances: { id: string }[] }).instances.map(({ id }) => id),
    );
    expect(new Set(dispatched).size).toBe(total);

    const nodeId = 2_097_152 + 3 * 32;
    const ingestId = await pstIngestId(namespace, nodeId);
    const rawKey = `ingest/2025-07-08/${ingestId}/raw.eml`;
    expect(
      await env.MAIL_CATALOG.prepare(
        `SELECT s.source_kind,s.source_namespace,s.received_at,s.notify_events,s.forward_status,
        p.folder_json,p.item_kind,p.headers,p.manifest_line FROM archive_sources s
        JOIN pst_messages p ON p.raw_key=s.raw_key WHERE s.raw_key=?`,
      )
        .bind(rawKey)
        .first(),
    ).toEqual({
      source_kind: "mailbox_export",
      source_namespace: namespace,
      received_at: deliveredAt(3),
      notify_events: 0,
      forward_status: null,
      folder_json: JSON.stringify(["受信トレイ", "Sub"]),
      item_kind: "schedule",
      headers: "synthesized",
      manifest_line: 4,
    });
    const raw = await env.MAIL_ARCHIVE.get(rawKey);
    expect(decoder.decode(await raw!.arrayBuffer())).toBe(message(3));
    expect(raw!.customMetadata).toMatchObject({ sourceKind: "mailbox_export", ingestId });
    const receipt = await env.MAIL_ARCHIVE.get(rawKey.replace(/raw\.eml$/, "receipt.json"));
    expect(parsePstProvenance(await receipt!.json())).toMatchObject({
      schemaVersion: "outlook-pst-v1",
      pstNodeId: nodeId,
      runId: "run-1",
      objectKey: `${prefix}/items/000004.eml`,
      manifestLine: 4,
      exportSha256,
      headers: "synthesized",
    });

    // The reconciler accepts the receipts and rebuilds the PST provenance from them.
    await env.MAIL_CATALOG.prepare("DELETE FROM pst_messages").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources").run();
    for (let page = 0; page < 100; page++)
      if ((await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).status === "complete") break;
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM archive_sources WHERE source_kind='mailbox_export' AND raw_state='present' AND receipt_state='valid'",
      ),
    ).toBe(total);
    expect(await count("SELECT COUNT(*) AS n FROM pst_messages")).toBe(total);
    expect(await count("SELECT COUNT(*) AS n FROM archive_issues")).toBe(0);
  }, 30_000);

  it("verifies a reconverted export by its manifest entry and records a changed one", async () => {
    const size = await upload(items(3));
    expect(await drain(config("first", size))).toMatchObject({ status: "complete" });
    const before = (await env.MAIL_ARCHIVE.list()).objects.map((o) => [o.key, o.etag]);
    // readpst picks new MIME boundaries: other bytes, the same items.
    const again = await upload([{ n: 0, body: "Other boundary." }, { n: 1 }, { n: 2 }]);
    expect(await drain(config("again", again))).toMatchObject({ status: "complete" });
    expect(await outcomes("again")).toEqual({ verified: 3 });
    expect((await env.MAIL_ARCHIVE.list()).objects.map((o) => [o.key, o.etag])).toEqual(before);

    // An item moved to another folder (or from another export) differs from the original.
    const moved = await upload([{ n: 0, folder: ["Archive"] }, { n: 1 }, { n: 2 }]);
    expect(await drain(config("moved", moved))).toMatchObject({
      status: "stopped",
      code: "pst_source_conflict",
      line: 1,
    });
    expect(await outcomes("moved")).toEqual({ conflict: 1 });
    expect(await drain(config("moved", moved, { onConflict: "record" }))).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("moved")).toEqual({ conflict: 1, verified: 2 });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT folder_json FROM pst_messages WHERE manifest_line=1",
      ).first("folder_json"),
    ).toBe('["Inbox"]');
  });

  it("stops with fixed codes when the manifest or an item is not what was configured", async () => {
    const size = await upload(items(2));
    expect(await drain(config("short", size - 1))).toMatchObject({
      status: "stopped",
      code: "pst_manifest_size_mismatch",
      line: 1,
    });
    await env.TAKEOUT_ARCHIVE.put(`${prefix}/items/000002.eml`, "changed");
    expect(await drain(config("changed", size))).toMatchObject({
      status: "stopped",
      code: "pst_object_size_mismatch",
      line: 2,
    });
    expect(await outcomes("changed")).toEqual({ imported: 1 });
    const same = encoder.encode(message(1).replace("Body", "Bodx"));
    await env.TAKEOUT_ARCHIVE.put(`${prefix}/items/000002.eml`, same);
    expect(await drain(config("changed", size, { attempt: 1 }))).toMatchObject({
      status: "stopped",
      code: "pst_object_sha256_mismatch",
      line: 2,
    });
    await env.TAKEOUT_ARCHIVE.delete(`${prefix}/items/000002.eml`);
    expect(await drain(config("changed", size, { attempt: 2 }))).toMatchObject({
      status: "stopped",
      code: "pst_object_missing",
    });
    // An operator who reviewed the item skips it; the run then completes.
    expect(await drain(config("changed", size, { attempt: 3, skip: [2] }))).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("changed")).toEqual({ imported: 1, skipped: 1 });

    // A reviewed line is skipped by its position, even one that does not parse.
    const broken = await upload(items(3, 10), {
      edit: (lines) => (lines[1] = { line: 2, note: "x".repeat(10) }),
    });
    expect(await drain(config("broken", broken))).toMatchObject({
      status: "stopped",
      code: "pst_manifest_invalid",
      line: 2,
    });
    expect(await drain(config("broken", broken, { attempt: 1, skip: [2] }))).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("broken")).toEqual({ imported: 2, skipped: 1 });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT pst_node_id,raw_key FROM pst_import_items WHERE run_id='broken' AND manifest_line=2",
      ).first(),
    ).toEqual({ pst_node_id: null, raw_key: null });
  });

  it("refuses manifest lines that are malformed, out of order, misplaced or from another export", async () => {
    const cases: [string, (lines: Record<string, unknown>[]) => void][] = [
      ["pst_manifest_invalid", (lines) => (lines[1]!["extra"] = true)],
      ["pst_manifest_invalid", (lines) => (lines[1]!["deliveredAt"] = "2025-07-08T09:44:00Z")],
      ["pst_manifest_invalid", (lines) => (lines[1]!["folder"] = ["x".repeat(4096)])],
      ["pst_manifest_line_mismatch", (lines) => (lines[1]!["line"] = 3)],
      ["pst_manifest_key_mismatch", (lines) => (lines[1]!["key"] = `${prefix}/items/000001.eml`)],
      ["pst_export_mismatch", (lines) => (lines[1]!["exportSha256"] = "f".repeat(64))],
    ];
    for (const [index, [code, edit]] of cases.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Each case replaces the same manifest.
      const size = await upload(items(3), { edit });
      // oxlint-disable-next-line no-await-in-loop -- See above.
      expect(await drain(config(`bad-${index}`, size))).toMatchObject({
        status: "stopped",
        code,
        line: 2,
      });
    }
    // A manifest whose last line has no LF.
    const size = await upload(items(1));
    const text = await (await env.TAKEOUT_ARCHIVE.get(manifestKey))!.text();
    await env.TAKEOUT_ARCHIVE.put(manifestKey, text.slice(0, -1));
    expect(await drain(config("no-lf", size - 1))).toMatchObject({
      status: "stopped",
      code: "pst_manifest_invalid",
      line: 1,
    });
  });

  it("streams an item over the buffer limit into the archive with exact bytes", async () => {
    const body = "x".repeat(20_000);
    const size = await upload([{ n: 0, body }, { n: 1 }]);
    expect(await drain(config("large", size), { bufferBytes: 1024 })).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("large")).toEqual({ imported: 2 });
    const rawKey = await env.MAIL_CATALOG.prepare(
      "SELECT raw_key FROM pst_messages WHERE manifest_line=1",
    ).first<string>("raw_key");
    const raw = await env.MAIL_ARCHIVE.get(rawKey!);
    expect(decoder.decode(await raw!.arrayBuffer())).toBe(message(0, body));
  });

  it("records an item stored just before a lost commit as imported", async () => {
    const size = await upload(items(2));
    const run = config("lost", size);
    expect(await drain(run)).toMatchObject({ status: "complete" });
    // As if the step had stored line 2 and timed out before its outcome committed.
    await env.MAIL_CATALOG.prepare("DELETE FROM pst_import_items WHERE manifest_line=2").run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE pst_import_runs SET status='running',next_line=2,next_offset=? WHERE run_id='lost'",
    )
      .bind(
        encoder.encode((await (await env.TAKEOUT_ARCHIVE.get(manifestKey))!.text()).split("\n")[0]!)
          .length + 1,
      )
      .run();
    expect(await drain(run)).toMatchObject({ status: "complete" });
    expect(await outcomes("lost")).toEqual({ imported: 2 });
  });

  it("stops at an existing source whose raw object is missing", async () => {
    const size = await upload(items(1));
    expect(await drain(config("first", size))).toMatchObject({ status: "complete" });
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_state='missing'").run();
    expect(await drain(config("again", size))).toMatchObject({
      status: "stopped",
      code: "pst_existing_source_invalid",
    });
  });

  it("resumes only an unchanged manifest and stops failed runs with fixed codes", async () => {
    const size = await upload(items(2));
    const run = config("resume", size);
    await startPstRun(env.MAIL_CATALOG, run);
    await expect(
      startPstRun(env.MAIL_CATALOG, config("resume", size, { attempt: 1 })),
    ).rejects.toThrow("pst_config_conflict");
    await env.MAIL_CATALOG.prepare(
      "UPDATE pst_import_runs SET workflow_instance='pst-resume-1' WHERE run_id='resume'",
    ).run();
    await stopPstRun(env.MAIL_CATALOG, "resume", "pst-resume-1", "secret detail");
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT status,stop_code,stop_line FROM pst_import_runs WHERE run_id='resume'",
      ).first(),
    ).toEqual({ status: "stopped", stop_code: "pst_import_failed", stop_line: 1 });
    expect(await runPstChunk(env, run)).toMatchObject({
      status: "stopped",
      code: "pst_import_failed",
    });
    await expect(startPstRun(env.MAIL_CATALOG, config("resume", size - 1))).rejects.toThrow(
      "pst_config_conflict",
    );
    expect(await drain(config("resume", size, { attempt: 1 }))).toMatchObject({
      status: "complete",
    });
  });

  it("reads lines across manifest windows and stops at a line longer than a window", async () => {
    const size = await upload(items(5));
    expect(await drain(config("windows", size), { readBytes: 600 })).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("windows")).toEqual({ imported: 5 });
    expect(await drain(config("narrow", size), { readBytes: 100 })).toMatchObject({
      status: "stopped",
      code: "pst_manifest_line_too_long",
      line: 1,
    });
  });

  it("stops when the manifest is replaced during a run, even by one of the same size", async () => {
    const size = await upload(items(PST_CHUNK_ITEMS + 2));
    const run = config("replaced", size);
    await startPstRun(env.MAIL_CATALOG, run);
    expect(await runPstChunk(env, run)).toMatchObject({ status: "advanced" });
    expect(await upload(items(PST_CHUNK_ITEMS + 2), { exportSha: "f".repeat(64) })).toBe(size);
    expect(await runPstChunk(env, run)).toMatchObject({
      status: "stopped",
      code: "pst_manifest_changed",
      line: PST_CHUNK_ITEMS + 1,
    });
  });

  it("waits while another runner holds the lease", async () => {
    const size = await upload(items(1));
    const run = config("leased", size);
    await startPstRun(env.MAIL_CATALOG, run);
    await env.MAIL_CATALOG.prepare(
      "UPDATE pst_import_runs SET lease_token='other',lease_until=? WHERE run_id='leased'",
    )
      .bind(Date.now() + 60_000)
      .run();
    expect(await runPstChunk(env, run)).toEqual({ status: "busy", processed: 0, nextLine: 1 });
    expect(await outcomes("leased")).toEqual({});
  });

  it("decides an item whose catalog rows were lost by the receipt an earlier run wrote", async () => {
    const size = await upload(items(2));
    expect(await drain(config("first", size))).toMatchObject({ status: "complete" });
    // The archive keeps raw objects and receipts; the catalog has not been reconciled yet.
    await env.MAIL_CATALOG.prepare("DELETE FROM pst_messages").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources").run();
    expect(await drain(config("again", size))).toMatchObject({ status: "complete" });
    expect(await outcomes("again")).toEqual({ verified: 2 });
    expect(
      (
        await env.MAIL_CATALOG.prepare("SELECT DISTINCT run_id FROM pst_messages").all<{
          run_id: string;
        }>()
      ).results,
    ).toEqual([{ run_id: "first" }]);

    // A reconverted item has other bytes; the stored raw object differs, so the run stops
    // until the reconciler restores the catalog row it can then be compared with.
    await env.MAIL_CATALOG.prepare("DELETE FROM pst_messages").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources").run();
    const other = await upload([{ n: 0, body: "Other boundary." }, { n: 1 }]);
    expect(await drain(config("reconverted", other))).toMatchObject({
      status: "stopped",
      code: "pst_source_conflict",
      line: 1,
    });
    for (let page = 0; page < 100; page++)
      if ((await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).status === "complete") break;
    expect(await drain(config("reconverted", other, { attempt: 1 }))).toMatchObject({
      status: "complete",
    });
    expect(await outcomes("reconverted")).toEqual({ verified: 2 });
  });

  it("reports a PST original with a missing raw object or receipt as a coverage issue", async () => {
    const size = await upload(items(2));
    expect(await drain(config("partial", size))).toMatchObject({ status: "complete" });
    const keys = (
      await env.MAIL_CATALOG.prepare(
        "SELECT raw_key FROM pst_messages ORDER BY manifest_line",
      ).all<{ raw_key: string }>()
    ).results.map((row) => row.raw_key);
    await env.MAIL_ARCHIVE.delete(keys[0]!);
    await env.MAIL_ARCHIVE.delete(keys[1]!.replace(/raw\.eml$/, "receipt.json"));
    await env.MAIL_CATALOG.prepare("DELETE FROM pst_messages").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources").run();
    for (let page = 0; page < 100; page++)
      if ((await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG)).status === "complete") break;
    expect(
      (
        await env.MAIL_CATALOG.prepare(
          `SELECT s.raw_key,s.source_kind,s.source_namespace,s.raw_state,s.receipt_state,
          p.raw_key IS NOT NULL AS has_provenance FROM archive_sources s
          LEFT JOIN pst_messages p ON p.raw_key=s.raw_key ORDER BY s.raw_key=?`,
        )
          .bind(keys[1])
          .all()
      ).results,
    ).toEqual([
      {
        raw_key: keys[0],
        source_kind: "mailbox_export",
        source_namespace: namespace,
        raw_state: "missing",
        receipt_state: "valid",
        has_provenance: 1,
      },
      {
        raw_key: keys[1],
        source_kind: "mailbox_export",
        source_namespace: namespace,
        raw_state: "invalid",
        receipt_state: "missing",
        has_provenance: 0,
      },
    ]);
    expect(
      (
        await env.MAIL_CATALOG.prepare("SELECT code FROM archive_issues ORDER BY code").all<{
          code: string;
        }>()
      ).results.map((row) => row.code),
    ).toEqual(["missing_raw", "missing_receipt"]);
  });

  it("records a skipped line that an earlier step of the run already stored", async () => {
    const size = await upload(items(2));
    const run = config("stored", size);
    expect(await drain(run)).toMatchObject({ status: "complete" });
    // As if line 2 was stored by a step that timed out, and the run then stopped there.
    await env.MAIL_CATALOG.prepare("DELETE FROM pst_import_items WHERE manifest_line=2").run();
    const first = (await (await env.TAKEOUT_ARCHIVE.get(manifestKey))!.text()).split("\n")[0]!;
    await env.MAIL_CATALOG.prepare(
      "UPDATE pst_import_runs SET status='stopped',stop_code='pst_import_failed',stop_line=2,next_line=2,next_offset=? WHERE run_id='stored'",
    )
      .bind(encoder.encode(first).length + 1)
      .run();
    expect(await drain(config("stored", size, { attempt: 1, skip: [2] }))).toMatchObject({
      status: "complete",
    });
    const row = await env.MAIL_CATALOG.prepare(
      `SELECT i.outcome,i.raw_key=s.raw_key AS same_key,i.raw_size=s.raw_size AS same_size,
      i.raw_sha256=s.raw_sha256 AS same_sha FROM pst_import_items i
      JOIN archive_sources s ON s.raw_key=i.raw_key WHERE i.run_id='stored' AND i.manifest_line=2`,
    ).first();
    expect(row).toEqual({ outcome: "imported", same_key: 1, same_size: 1, same_sha: 1 });
  });

  it("lets only fixed codes out of a Workflow step", () => {
    expect(pstStepError(new PstImportError("pst_lease_lost")).message).toBe("pst_lease_lost");
    expect(pstStepError(new Error("SELECT secret")).message).toBe("pst_import_failed");
    expect(pstStepError(new PstImportError("pst_config_conflict"))).toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("starts one Workflow instance per configured run from the cron", async () => {
    const size = await upload(items(1));
    const create = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({ status: async () => ({ status: "running" }) });
    const cron = {
      ...env,
      PST_IMPORT: { create, get },
      PST_IMPORT_CONFIG: JSON.stringify({
        runId: "cron",
        accountNamespace: namespace,
        manifest: { key: manifestKey, size },
      }),
    };
    const { PST_IMPORT_CONFIG: _unset, ...unconfigured } = cron;
    expect(await ensurePstWorkflow(unconfigured)).toEqual({
      status: "none",
    });
    expect(await ensurePstWorkflow(cron, 1000)).toEqual({ status: "created" });
    expect(create).toHaveBeenCalledWith({
      id: "pst-cron-1000",
      params: { runId: "cron" },
      locationHint: "apac",
    });
    expect(await ensurePstWorkflow(cron, 2000)).toEqual({ status: "active" });
    expect(create).toHaveBeenCalledTimes(1);
    get.mockResolvedValue({ status: async () => ({ status: "errored" }) });
    expect(await ensurePstWorkflow(cron, 3000)).toEqual({ status: "created" });
    // The instance runs the chunks; here they run directly.
    expect(await drain(pstConfig(cron)!)).toMatchObject({ status: "complete" });
    expect(await ensurePstWorkflow(cron, 4000)).toEqual({ status: "complete" });
  });

  it("refuses configurations with unsafe keys, other namespaces or unknown fields", () => {
    const base = {
      runId: "r",
      accountNamespace: namespace,
      manifest: { key: manifestKey, size: 1 },
    };
    for (const value of [
      { ...base, extra: 1 },
      { ...base, accountNamespace: "gmail-abc" },
      {
        ...base,
        manifest: { key: `outlook-${"1b".repeat(12)}/2026-11-28/manifest.jsonl`, size: 1 },
      },
      { ...base, manifest: { key: `${namespace}/2026-02-30/manifest.jsonl`, size: 1 } },
      { ...base, manifest: { key: `${namespace}/../manifest.jsonl`, size: 1 } },
      { ...base, manifest: { key: manifestKey, size: 0 } },
      { ...base, skip: [1, 1] },
      { ...base, skip: [0] },
    ])
      expect(() => pstConfig({ PST_IMPORT_CONFIG: JSON.stringify(value) })).toThrow(
        "invalid_pst_configuration",
      );
    expect(() => pstConfig({ PST_IMPORT_CONFIG: "{" })).toThrow("invalid_pst_configuration");
    expect(pstConfig({ PST_IMPORT_CONFIG: JSON.stringify(base) })).toMatchObject({
      onConflict: "stop",
      attempt: 0,
      skip: [],
    });
  });
});
