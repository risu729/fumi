import { env } from "cloudflare:workers";
import {
  applyD1Migrations,
  introspectWorkflowInstance,
  createScheduledController,
} from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PIPELINE_VERSION,
  PROCESSING_CHECK_INTERVAL_MS,
  DISPATCH_WINDOW_MS,
  processingInstanceId,
  readProcessingJob,
  repairProcessing,
  requestProcessing,
  retryFailedProcessing,
  completeProcessing,
  failProcessing,
  parseProcessingParams,
} from "../src/processing-jobs.ts";
import { reconcileArchive, indexArchiveSource } from "../src/reconcile.ts";
import { commitPage, readCheckpoint } from "../src/catalog.ts";
import worker from "../src/index.ts";
import { repairContentSearch, searchMailContent } from "../src/content-search.ts";

const receivedAt = "2026-11-10T00:00:00.000Z";
const bytes = new TextEncoder().encode("Subject: Synthetic workflow\r\n\r\nBody\r\n");

async function putSource(notifyEvents = false) {
  const id = crypto.randomUUID();
  const prefix = `ingest/2026-11-10/${id}`;
  const key = `${prefix}/raw.eml`;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await env.MAIL_ARCHIVE.put(key, bytes, {
    sha256: digest,
    customMetadata: {
      schemaVersion: "1",
      ingestId: id,
      receivedAt,
      sha256,
      envelopeFrom: "sender@example.invalid",
      envelopeTo: "recipient@example.invalid",
      eventNotifications: notifyEvents ? "1" : "0",
    },
  });
  await env.MAIL_ARCHIVE.put(
    `${prefix}/receipt.json`,
    JSON.stringify({
      schemaVersion: 1,
      ingestId: id,
      receivedAt,
      envelope: { from: "sender@example.invalid", to: "recipient@example.invalid" },
      reportedRawSize: bytes.byteLength,
      archive: { status: "stored", key, size: bytes.byteLength, sha256 },
      forward: { status: "forwarded" },
    }),
  );
  return { id, key, sha256, instanceId: processingInstanceId(key) };
}

async function job(key: string) {
  return readProcessingJob(env.MAIL_CATALOG.withSession("first-primary"), key);
}

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions"),
    env.MAIL_CATALOG.prepare("DELETE FROM processing_jobs"),
    env.MAIL_CATALOG.prepare("DELETE FROM archive_sources"),
    env.MAIL_CATALOG.prepare("DELETE FROM archive_issues"),
    env.MAIL_CATALOG.prepare(
      "UPDATE archive_scan SET cursor = NULL, revision = 0, pass = 0 WHERE id = 1",
    ),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("mail processing Workflows in workerd", () => {
  it("bounds repair and moves unavailable jobs behind other due work", async () => {
    const now = Date.now();
    const keys = Array.from(
      { length: 11 },
      () => `ingest/2026-11-10/${crypto.randomUUID()}/raw.eml`,
    );
    await env.MAIL_CATALOG.batch(
      keys.map((key) =>
        env.MAIL_CATALOG.prepare(
          `INSERT INTO processing_jobs (raw_key, pipeline_version, instance_id, state, created_at, updated_at, next_check_at)
       VALUES (?, ?, ?, 'pending', ?, ?, 0)`,
        ).bind(key, PIPELINE_VERSION, processingInstanceId(key), now, now),
      ),
    );
    const binding = { createBatch: vi.fn().mockRejectedValue(new Error("offline")), get: vi.fn() };
    expect(await repairProcessing(env.MAIL_CATALOG, binding, now)).toMatchObject({ deferred: 10 });
    expect(await repairProcessing(env.MAIL_CATALOG, binding, now)).toMatchObject({ deferred: 1 });
    expect(binding.createBatch).toHaveBeenCalledTimes(11);
    expect(
      new Set(binding.createBatch.mock.calls.map(([options]) => options.instances[0].id)).size,
    ).toBe(11);
  });

  it("accepts a duplicate response without its optional id", async () => {
    const source = await putSource();
    const binding = {
      createBatch: vi
        .fn()
        .mockResolvedValue({ created: [], errors: [{ index: 0, code: 10405, message: "exists" }] }),
      get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
    };
    await requestProcessing(env.MAIL_CATALOG, binding, source.key);
    expect(await job(source.key)).toMatchObject({
      state: "pending",
      failure_code: null,
      dispatched_at: expect.any(Number),
    });
  });

  it("fences a superseded attempt inside the catalog transaction after R2 reads", async () => {
    const source = await putSource();
    const binding = { createBatch: vi.fn().mockRejectedValue(new Error("offline")), get: vi.fn() };
    await requestProcessing(env.MAIL_CATALOG, binding, source.key);
    await env.MAIL_CATALOG.prepare("UPDATE processing_jobs SET state = 'running' WHERE raw_key = ?")
      .bind(source.key)
      .run();
    const head = env.MAIL_ARCHIVE.head.bind(env.MAIL_ARCHIVE);
    vi.spyOn(env.MAIL_ARCHIVE, "head").mockImplementationOnce(async (key) => {
      await env.MAIL_CATALOG.prepare(
        "UPDATE processing_jobs SET attempt = 1, instance_id = ?, state = 'pending' WHERE raw_key = ?",
      )
        .bind(processingInstanceId(source.key, 1), source.key)
        .run();
      return head(key);
    });
    await expect(
      indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, source.key, source.instanceId),
    ).rejects.toThrow();
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_sources").first(),
    ).toEqual({ count: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_issues").first(),
    ).toEqual({ count: 0 });
    expect(await readCheckpoint(env.MAIL_CATALOG.withSession("first-primary"))).toEqual({
      cursor: null,
      revision: 0,
      pass: 0,
    });
  });

  it("prevents an older scan from overwriting an immediate observation", async () => {
    const source = await putSource();
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const stale = await readCheckpoint(session);
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, source.key);
    expect(
      await commitPage(
        session,
        stale,
        [],
        [{ key: source.key, code: "missing_raw" }],
        "stale-cursor",
      ),
    ).toEqual({ committed: false, indexed: 0, issues: 0 });
    expect(await readCheckpoint(session)).toEqual({ cursor: null, revision: 1, pass: 0 });
  });

  it("repairs pending jobs even when the archive scan fails", async () => {
    const source = await putSource();
    const now = Date.now();
    const binding = {
      createBatch: vi.fn().mockResolvedValue({ created: [{ id: source.instanceId }], errors: [] }),
      get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
    };
    await requestProcessing(
      env.MAIL_CATALOG,
      binding,
      source.key,
      now - PROCESSING_CHECK_INTERVAL_MS,
    );
    binding.get.mockClear();
    vi.spyOn(env.MAIL_ARCHIVE, "list").mockRejectedValueOnce(new Error("Synthetic list failure"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      worker.scheduled(createScheduledController(), {
        ...env,
        MAIL_PROCESSING: binding,
      } as unknown as Env),
    ).rejects.toThrow("Archive reconciliation did not complete");
    expect(binding.get).toHaveBeenCalledOnce();
  });

  it("does not expire work acknowledged after the dispatcher read", async () => {
    const source = await putSource();
    const now = Date.now();
    const binding = { createBatch: vi.fn().mockRejectedValue(new Error("offline")), get: vi.fn() };
    await requestProcessing(env.MAIL_CATALOG, binding, source.key, now);
    await env.MAIL_CATALOG.prepare(`CREATE TRIGGER acknowledge_dispatch AFTER UPDATE OF next_check_at ON processing_jobs
      BEGIN UPDATE processing_jobs SET state = 'running', dispatched_at = 1 WHERE raw_key = NEW.raw_key; END`).run();
    try {
      await repairProcessing(env.MAIL_CATALOG, binding, now + DISPATCH_WINDOW_MS);
      expect(await job(source.key)).toMatchObject({ state: "running", dispatched_at: 1 });
    } finally {
      await env.MAIL_CATALOG.exec("DROP TRIGGER acknowledge_dispatch");
    }
  });
  it("indexes immediately and keeps completed jobs terminal without touching the sweep cursor", async () => {
    const source = await putSource();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      status: "extracted",
      attachmentCount: 0,
      indexed: 1,
      issues: 0,
      rawState: "present",
      receiptState: "valid",
    });
    expect(await job(source.key)).toMatchObject({
      state: "complete",
      pipeline_version: PIPELINE_VERSION,
    });
    expect(
      (
        await searchMailContent(
          env,
          { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] },
          { query: "Body" },
          "https://mail.example.invalid",
        )
      ).matches,
    ).toHaveLength(1);
    expect(await env.MAIL_CATALOG.prepare("SELECT * FROM archive_scan").first()).toEqual({
      id: 1,
      revision: 1,
      pass: 0,
      cursor: null,
    });
    const create = vi.spyOn(env.MAIL_PROCESSING, "createBatch");
    const get = vi.spyOn(env.MAIL_PROCESSING, "get");
    // Even beyond Workflow retention, D1 terminal state prevents another call.
    expect(
      await requestProcessing(
        env.MAIL_CATALOG,
        env.MAIL_PROCESSING,
        source.key,
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      ),
    ).toBe("terminal");
    await repairProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING);
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps MIME completion and its single ready event after exhausted lexical indexing retries", async () => {
    const source = await putSource(true);
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError(
        { name: "index-content-search-v1" },
        new Error("Synthetic lexical outage"),
      );
    });
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toMatchObject({ status: "extracted" });
    expect(await job(source.key)).toMatchObject({ state: "complete", failure_code: null });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT status FROM mail_extractions WHERE raw_key=?")
        .bind(source.key)
        .first("status"),
    ).toBe("complete");
    expect(
      await env.MAIL_CATALOG.prepare("SELECT status FROM mail_search_documents WHERE raw_key=?")
        .bind(source.key)
        .first(),
    ).toBeNull();
    expect(await repairContentSearch(env)).toEqual({ indexed: 1, deferred: 0 });
    expect(await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key)).toBe(
      "terminal",
    );
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events WHERE event_id=?")
        .bind(`ready:${source.instanceId}`)
        .first("n"),
    ).toBe(1);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events WHERE event_id=?")
        .bind(`failed:${source.instanceId}`)
        .first("n"),
    ).toBe(0);
  });

  it("retries a transient step", async () => {
    const source = await putSource();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError({ name: "index-mime-v1" }, new Error("Synthetic failure"), 2);
    });
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await instance.waitForStatus("complete");
    expect(await job(source.key)).toMatchObject({ state: "complete", failure_code: null });
  });

  it("records exhausted failures, retries with a new identity, and fences the old attempt", async () => {
    const source = await putSource();
    await using first = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await first.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError({ name: "index-mime-v1" }, new Error("Synthetic failure"));
    });
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await first.waitForStatus("errored");
    expect(await job(source.key)).toMatchObject({
      state: "failed",
      failure_code: "workflow_failed",
    });
    await using second = await introspectWorkflowInstance(
      env.MAIL_PROCESSING,
      processingInstanceId(source.key, 1),
    );
    expect(await retryFailedProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key, 0)).toBe(
      true,
    );
    expect(await retryFailedProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key, 0)).toBe(
      false,
    );
    const old = { rawKey: source.key, pipelineVersion: PIPELINE_VERSION, attempt: 0 } as const;
    await failProcessing(env.MAIL_CATALOG.withSession("first-primary"), old);
    await expect(
      completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), old),
    ).rejects.toThrow("fenced");
    await second.waitForStatus("complete");
    expect(await job(source.key)).toMatchObject({ state: "complete", attempt: 1 });
  });

  it("recovers a lost creation response without a second instance or regressing completion", async () => {
    const source = await putSource();
    const now = Date.now();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    const create = env.MAIL_PROCESSING.createBatch.bind(env.MAIL_PROCESSING);
    const spy = vi
      .spyOn(env.MAIL_PROCESSING, "createBatch")
      .mockImplementationOnce(async (options) => {
        await create(options);
        throw new Error("Synthetic lost response");
      });
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key, now);
    await instance.waitForStatus("complete");
    await repairProcessing(
      env.MAIL_CATALOG,
      env.MAIL_PROCESSING,
      now + PROCESSING_CHECK_INTERVAL_MS,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await job(source.key)).toMatchObject({ state: "complete", failure_code: null });
  });

  it("defers creation failures, then repairs the same pending identity", async () => {
    const source = await putSource();
    const now = Date.now();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    vi.spyOn(env.MAIL_PROCESSING, "createBatch").mockRejectedValueOnce(
      new Error("Synthetic offline"),
    );
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key, now);
    expect(await job(source.key)).toMatchObject({
      state: "pending",
      dispatched_at: null,
      failure_code: "dispatch_unavailable",
    });
    await repairProcessing(
      env.MAIL_CATALOG,
      env.MAIL_PROCESSING,
      now + PROCESSING_CHECK_INTERVAL_MS,
    );
    await instance.waitForStatus("complete");
    expect(await job(source.key)).toMatchObject({ state: "complete", attempt: 0 });
  });

  it("never recreates an acknowledged instance when status is unavailable", async () => {
    const source = await putSource();
    const now = Date.now();
    const binding = {
      createBatch: vi.fn().mockResolvedValue({ created: [{ id: source.instanceId }], errors: [] }),
      get: vi.fn().mockRejectedValue(new Error("Synthetic unavailable status")),
    };
    await requestProcessing(env.MAIL_CATALOG, binding, source.key, now);
    await repairProcessing(env.MAIL_CATALOG, binding, now + DISPATCH_WINDOW_MS * 10);
    expect(binding.createBatch).toHaveBeenCalledTimes(1);
    expect(await job(source.key)).toMatchObject({
      state: "pending",
      failure_code: "status_unavailable",
    });
  });

  it("expires uncertain dispatch before retained Workflow history can disappear", async () => {
    const source = await putSource();
    const now = Date.now();
    const binding = {
      createBatch: vi.fn().mockRejectedValue(new Error("Synthetic offline")),
      get: vi.fn(),
    };
    await requestProcessing(env.MAIL_CATALOG, binding, source.key, now);
    await repairProcessing(env.MAIL_CATALOG, binding, now + DISPATCH_WINDOW_MS);
    expect(binding.createBatch).toHaveBeenCalledTimes(1);
    expect(binding.get).not.toHaveBeenCalled();
    expect(await job(source.key)).toMatchObject({
      state: "failed",
      failure_code: "dispatch_expired",
    });
  });

  it("retries completion persistence after cataloging without duplicating the source", async () => {
    const source = await putSource();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError({ name: "complete-mime-v1" }, new Error("Synthetic failure"), 2);
    });
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await instance.waitForStatus("complete");
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_sources").first(),
    ).toEqual({ count: 1 });
    expect(await job(source.key)).toMatchObject({ state: "complete" });
  });

  it("discovers R2-only mail after dispatch failed before a ledger write", async () => {
    const source = await putSource();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    const database = vi.spyOn(env.MAIL_CATALOG, "withSession").mockImplementationOnce(() => {
      throw new Error("Synthetic unavailable database");
    });
    await expect(
      requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key),
    ).rejects.toThrow();
    database.mockRestore();
    expect(await job(source.key)).toBeNull();
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(await repairProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING)).toMatchObject({
      discovered: 1,
    });
    await instance.waitForStatus("complete");
    expect(await job(source.key)).toMatchObject({ state: "complete" });
  });

  it("preserves catalog-only jobs and discovers a separate MIME job on upgrade", async () => {
    const source = await putSource();
    const legacyId = processingInstanceId(source.key, 0, "catalog-v1");
    await using legacy = await introspectWorkflowInstance(env.MAIL_PROCESSING, legacyId);
    await requestProcessing(
      env.MAIL_CATALOG,
      env.MAIL_PROCESSING,
      source.key,
      Date.now(),
      "catalog-v1",
    );
    await legacy.waitForStatus("complete");
    expect(await legacy.getOutput()).toMatchObject({ status: "cataloged" });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_extractions").first(),
    ).toEqual({ count: 0 });
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const before = await readProcessingJob(session, source.key, "catalog-v1");
    await using current = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    expect(await repairProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING)).toMatchObject({
      discovered: 1,
    });
    await current.waitForStatus("complete");
    expect(await current.getOutput()).toMatchObject({ status: "extracted", attachmentCount: 0 });
    expect(await readProcessingJob(session, source.key, "catalog-v1")).toEqual(before);
    expect(await job(source.key)).toMatchObject({ state: "complete", pipeline_version: "mime-v1" });
  });

  it("repairs pending legacy dispatches using the original pipeline identity", async () => {
    const source = await putSource();
    const now = Date.now();
    const binding = { createBatch: vi.fn().mockRejectedValue(new Error("offline")), get: vi.fn() };
    await requestProcessing(env.MAIL_CATALOG, binding, source.key, now, "catalog-v1");
    binding.createBatch.mockClear();
    await repairProcessing(env.MAIL_CATALOG, binding, now + PROCESSING_CHECK_INTERVAL_MS);
    expect(binding.createBatch).toHaveBeenCalledWith({
      instances: [
        {
          id: processingInstanceId(source.key, 0, "catalog-v1"),
          params: { rawKey: source.key, pipelineVersion: "catalog-v1", attempt: 0 },
        },
      ],
    });
    expect(
      parseProcessingParams({ rawKey: source.key, pipelineVersion: "unknown", attempt: 0 }),
    ).toBeNull();
  });

  it("leaves missing originals blocked instead of claiming extraction completion", async () => {
    const source = await putSource();
    await env.MAIL_ARCHIVE.delete(source.key);
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await instance.waitForStatus("errored");
    expect(await job(source.key)).toMatchObject({ state: "failed", completed_at: null });
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT status, failure_code FROM mail_extractions WHERE raw_key = ?",
      )
        .bind(source.key)
        .first(),
    ).toEqual({ status: "blocked", failure_code: "source_missing" });
  });

  it("retries the extraction step without creating another processing job", async () => {
    const source = await putSource();
    await using instance = await introspectWorkflowInstance(env.MAIL_PROCESSING, source.instanceId);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError({ name: "extract-mime-v1" }, new Error("Synthetic outage"), 2);
    });
    await requestProcessing(env.MAIL_CATALOG, env.MAIL_PROCESSING, source.key);
    await instance.waitForStatus("complete");
    expect(await job(source.key)).toMatchObject({ state: "complete", attempt: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_extractions").first(),
    ).toEqual({ count: 1 });
  });
});
