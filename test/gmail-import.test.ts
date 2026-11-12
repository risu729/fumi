import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runGmailImportPage, startGmailImport } from "../src/gmail-import.ts";
import {
  createReadonlyGmailTransport,
  GMAIL_READONLY_SCOPE,
  GmailImportError,
} from "../src/gmail-transport.ts";
import { reconcileArchive } from "../src/reconcile.ts";
import {
  beginProcessing,
  completeProcessing,
  processingInstanceId,
  repairProcessing,
  PROCESSING_CHECK_INTERVAL_MS,
} from "../src/processing-jobs.ts";
import { extractArchiveMail } from "../src/mime-extraction.ts";
import { handleGmailImport } from "../src/gmail-import-http.ts";

// Archive/provenance fixtures control dispatch without launching background Workflows.
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

async function accountHash() {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("synthetic@example.invalid")),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

const scope = {
  accountNamespace: "synthetic-account",
  before: 1_800_000_000,
  includeSpamTrash: true,
};
const raw = new Uint8Array([
  ...new TextEncoder().encode(
    "Subject: Historical\r\nContent-Type: application/octet-stream\r\n\r\n",
  ),
  0,
  255,
  13,
  10,
]);
const encoded = btoa(String.fromCharCode(...raw))
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");
function message(id = "123") {
  return {
    id,
    threadId: "thread123",
    internalDate: "1700000000000",
    labelIds: ["SENT", "Label_2"],
    raw: encoded,
  };
}
const transport = () => ({
  list: vi.fn(async () => ({ messages: [{ id: "123" }] })),
  getRaw: vi.fn(async (id: string) => message(id)),
});

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.clearAllMocks();
  for (const table of [
    "gmail_import_items",
    "gmail_imports",
    "gmail_messages",
    "archive_sources",
    "archive_issues",
    "processing_jobs",
    "mail_extractions",
    "mail_events",
  ])
    // oxlint-disable-next-line no-await-in-loop -- Delete dependent import items before their parent runs.
    await env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`).run();
  await env.MAIL_CATALOG.prepare("UPDATE archive_scan SET cursor=NULL,revision=0,pass=0").run();
  const objects = await env.MAIL_ARCHIVE.list();
  if (objects.objects.length)
    await env.MAIL_ARCHIVE.delete(objects.objects.map((item) => item.key));
});
afterEach(() => vi.restoreAllMocks());

describe("bounded historical Gmail import", () => {
  it("counts duplicate provider IDs only once across pages and pauses deleted uncommitted mail", async () => {
    await startGmailImport(env, "history", scope);
    const client = {
      list: vi.fn(async () => ({
        messages: [{ id: "123" }],
        nextPageToken: undefined as string | undefined,
      })),
      getRaw: vi.fn(async (id: string) => message(id)),
    };
    client.list.mockResolvedValueOnce({ messages: [{ id: "123" }], nextPageToken: "page2" });
    expect(await runGmailImportPage(env, client, "history", scope)).toEqual({
      status: "advanced",
      imported: 1,
    });
    expect(await runGmailImportPage(env, client, "history", scope)).toEqual({
      status: "complete",
      imported: 0,
    });
    expect(client.getRaw).toHaveBeenCalledTimes(1);
    await startGmailImport(env, "deleted", scope);
    const deleted = {
      list: vi.fn(async () => ({ messages: [{ id: "456" }] })),
      getRaw: vi.fn(async () => {
        throw new GmailImportError("gmail_http_404");
      }),
    };
    await expect(runGmailImportPage(env, deleted, "deleted", scope)).rejects.toThrow(
      "gmail_http_404",
    );
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT pending_json,complete,imported_count FROM gmail_imports WHERE import_id='deleted'",
      ).first(),
    ).toEqual({ pending_json: '["456"]', complete: 0, imported_count: 0 });
  });
  it("preserves exact binary bytes, SENT provenance, replay identity, and emits no lifecycle events", async () => {
    await startGmailImport(env, "history", scope);
    const client = transport();
    expect(await runGmailImportPage(env, client, "history", scope)).toEqual({
      status: "complete",
      imported: 1,
    });
    expect(client.list).toHaveBeenCalledWith({
      q: `before:${scope.before}`,
      includeSpamTrash: true,
      maxResults: 10,
    });
    const source = await env.MAIL_CATALOG.prepare("SELECT * FROM archive_sources").first<{
      raw_key: string;
      external_id: string;
      source_kind: string;
      notify_events: number;
      forward_status: null;
    }>();
    expect(source?.source_kind).toBe("gmail");
    expect(source?.external_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(source?.notify_events).toBe(0);
    expect(source?.forward_status).toBeNull();
    const key = source!.raw_key;
    expect(new Uint8Array(await (await env.MAIL_ARCHIVE.get(key))!.arrayBuffer())).toEqual(raw);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT message_id,thread_id,internal_date,label_ids_json FROM gmail_messages",
      ).first(),
    ).toEqual({
      message_id: "123",
      thread_id: "thread123",
      internal_date: "1700000000000",
      label_ids_json: '["SENT","Label_2"]',
    });
    // A separate run replays the same provider identity without merging by MIME hash.
    await startGmailImport(env, "replay", scope);
    await runGmailImportPage(env, client, "replay", scope);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM archive_sources").first("n"),
    ).toBe(1);
    // The sweep repairs provider provenance as well as the generic catalog.
    await env.MAIL_CATALOG.prepare("DELETE FROM gmail_messages").run();
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources").run();
    await reconcileArchive(env.MAIL_ARCHIVE, env.MAIL_CATALOG);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT message_id FROM gmail_messages").first("message_id"),
    ).toBe("123");
    const instanceId = processingInstanceId(key);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM processing_jobs WHERE raw_key=?")
        .bind(key)
        .first("state"),
    ).toBe("pending");
    const params = { rawKey: key, pipelineVersion: "mime-v1" as const, attempt: 0 };
    await beginProcessing(env.MAIL_CATALOG.withSession("first-primary"), params);
    expect(
      (await extractArchiveMail(env.MAIL_ARCHIVE, env.MAIL_CATALOG, key, instanceId)).status,
    ).toBe("complete");
    await completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), params);
    expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM mail_events").first("n")).toBe(
      0,
    );
  });

  it("dispatches all ten committed sources immediately with stable identities across replay", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `message${index}`);
    const client = {
      list: vi.fn(async () => ({ messages: ids.map((id) => ({ id })) })),
      getRaw: vi.fn(async (id: string) => message(id)),
    };
    await startGmailImport(env, "dispatch", scope);
    expect(await runGmailImportPage(env, client, "dispatch", scope)).toMatchObject({
      imported: 10,
    });
    const keys = (
      await env.MAIL_CATALOG.prepare("SELECT raw_key FROM archive_sources").all<{
        raw_key: string;
      }>()
    ).results.map(({ raw_key }) => raw_key);
    expect(workflow.createBatch).toHaveBeenCalledTimes(10);
    expect(
      new Set(workflow.createBatch.mock.calls.map(([options]) => options.instances[0].id)),
    ).toEqual(new Set(keys.map((key) => processingInstanceId(key))));
    await startGmailImport(env, "replay-dispatch", scope);
    await runGmailImportPage(env, client, "replay-dispatch", scope);
    expect(workflow.createBatch).toHaveBeenCalledTimes(10);
    expect(client.getRaw).toHaveBeenCalledTimes(10);
    expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events").first("n")).toBe(0);
  });

  it("overlaps at most three durable-source dispatches while reading only one raw original", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `bounded${index}`);
    const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const original = workflow.createBatch.getMockImplementation()!;
    let dispatching = 0,
      maxDispatching = 0,
      reading = 0,
      maxReading = 0,
      cleanup = false;
    workflow.createBatch.mockImplementation(async (options) => {
      dispatching++;
      maxDispatching = Math.max(maxDispatching, dispatching);
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      if (!cleanup) await gate.promise;
      dispatching--;
      return original(options);
    });
    const client = {
      list: vi.fn(async () => ({ messages: ids.map((id) => ({ id })) })),
      getRaw: vi.fn(async (id: string) => {
        reading++;
        maxReading = Math.max(maxReading, reading);
        await Promise.resolve();
        reading--;
        return message(id);
      }),
    };
    await startGmailImport(env, "bounded-dispatch", scope);
    let settled = false;
    const running = runGmailImportPage(env, client, "bounded-dispatch", scope).finally(() => {
      settled = true;
    });
    try {
      for (const total of [3, 6, 9, 10]) {
        // oxlint-disable-next-line no-await-in-loop -- Release each real provider gate only after the bounded group reaches it.
        await vi.waitFor(() => expect(gates).toHaveLength(total));
        expect(client.getRaw).toHaveBeenCalledTimes(total);
        expect(settled).toBe(false);
        // oxlint-disable-next-line no-await-in-loop -- Observe the real checkpoint before releasing this provider group.
        const checkpoint = await env.MAIL_CATALOG.prepare(
          "SELECT revision,imported_count FROM gmail_imports WHERE import_id='bounded-dispatch'",
        ).first();
        expect(checkpoint).toEqual({ revision: 0, imported_count: 0 });
        for (const gate of gates) gate.resolve();
      }
      expect(await running).toEqual({ status: "complete", imported: 10 });
      expect(maxDispatching).toBe(3);
      expect(maxReading).toBe(1);
      await startGmailImport(env, "bounded-replay", scope);
      await runGmailImportPage(env, client, "bounded-replay", scope);
      expect(workflow.createBatch).toHaveBeenCalledTimes(10);
      expect(client.getRaw).toHaveBeenCalledTimes(10);
      expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events").first("n")).toBe(
        0,
      );
    } finally {
      cleanup = true;
      for (const gate of gates) gate.resolve();
      await running.catch(() => undefined);
      workflow.createBatch.mockImplementation(original);
    }
  });

  it("drains committed dispatches before releasing the lease after a later raw read fails", async () => {
    const gate = Promise.withResolvers<void>();
    workflow.createBatch.mockImplementationOnce(
      async ({ instances }: { instances: { id: string }[] }) => {
        await gate.promise;
        return { created: instances.map(({ id }) => ({ id })), errors: [] };
      },
    );
    let failRaw = true,
      settled = false;
    const client = {
      list: vi.fn(async () => ({ messages: [{ id: "drain0" }, { id: "drain1" }] })),
      getRaw: vi.fn(async (id: string) => {
        if (id === "drain1" && failRaw) throw new GmailImportError("gmail_http_404");
        return message(id);
      }),
    };
    await startGmailImport(env, "raw-failure-drain", scope);
    const running = runGmailImportPage(env, client, "raw-failure-drain", scope).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(client.getRaw).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT revision,imported_count,lease_token IS NOT NULL AS leased FROM gmail_imports",
        ).first(),
      ).toEqual({ revision: 0, imported_count: 0, leased: 1 });
      gate.resolve();
      expect(await running).toMatchObject({ code: "gmail_http_404" });
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT revision,imported_count,lease_token,complete FROM gmail_imports",
        ).first(),
      ).toEqual({ revision: 0, imported_count: 0, lease_token: null, complete: 0 });
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM gmail_import_items").first("n"),
      ).toBe(1);
      const key = await env.MAIL_CATALOG.prepare(
        "SELECT raw_key FROM archive_sources",
      ).first<string>("raw_key");
      expect(new Uint8Array(await (await env.MAIL_ARCHIVE.get(key!))!.arrayBuffer())).toEqual(raw);
      failRaw = false;
      expect(await runGmailImportPage(env, client, "raw-failure-drain", scope)).toEqual({
        status: "complete",
        imported: 2,
      });
      expect(workflow.createBatch).toHaveBeenCalledTimes(2);
      expect(client.list).toHaveBeenCalledTimes(1);
      expect(client.getRaw).toHaveBeenCalledTimes(3);
      expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events").first("n")).toBe(
        0,
      );
    } finally {
      gate.resolve();
      await running;
    }
  });

  it("settles other dispatches after one ledger failure and replays the same page without inflated counts", async () => {
    const session = env.MAIL_CATALOG.withSession.bind(env.MAIL_CATALOG);
    vi.spyOn(env.MAIL_CATALOG, "withSession")
      .mockImplementationOnce(session)
      .mockImplementationOnce(() => {
        throw new Error("Synthetic processing ledger unavailable");
      });
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    for (const gate of gates)
      workflow.createBatch.mockImplementationOnce(
        async ({ instances }: { instances: { id: string }[] }) => {
          await gate.promise;
          return { created: instances.map(({ id }) => ({ id })), errors: [] };
        },
      );
    const client = {
      list: vi.fn(async () => ({
        messages: [{ id: "ledger0" }, { id: "ledger1" }, { id: "ledger2" }],
      })),
      getRaw: vi.fn(async (id: string) => message(id)),
    };
    await startGmailImport(env, "ledger-failure-drain", scope);
    let settled = false;
    const running = runGmailImportPage(env, client, "ledger-failure-drain", scope).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await vi.waitFor(() => expect(workflow.createBatch).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM archive_sources").first("n"),
      ).toBe(3);
      gates[0]!.resolve();
      await vi.waitFor(async () =>
        expect(
          await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM gmail_import_items").first("n"),
        ).toBe(1),
      );
      expect(settled).toBe(false);
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT revision,lease_token IS NOT NULL AS leased FROM gmail_imports",
        ).first(),
      ).toEqual({ revision: 0, leased: 1 });
      gates[1]!.resolve();
      expect(await running).toMatchObject({ code: "gmail_import_failed" });
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT revision,imported_count,lease_token FROM gmail_imports",
        ).first(),
      ).toEqual({ revision: 0, imported_count: 0, lease_token: null });
      expect(await runGmailImportPage(env, client, "ledger-failure-drain", scope)).toEqual({
        status: "complete",
        imported: 3,
      });
      expect(client.list).toHaveBeenCalledTimes(1);
      expect(client.getRaw).toHaveBeenCalledTimes(3);
      expect(workflow.createBatch).toHaveBeenCalledTimes(3);
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM gmail_import_items").first("n"),
      ).toBe(3);
      expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events").first("n")).toBe(
        0,
      );
    } finally {
      for (const gate of gates) gate.resolve();
      await running;
    }
  });

  it("retains a committed original and pending page when the processing ledger is unavailable", async () => {
    await startGmailImport(env, "dispatch-recovery", scope);
    const session = env.MAIL_CATALOG.withSession.bind(env.MAIL_CATALOG);
    const spy = vi
      .spyOn(env.MAIL_CATALOG, "withSession")
      .mockImplementationOnce(session)
      .mockImplementationOnce(() => {
        throw new Error("Synthetic processing ledger unavailable");
      });
    const client = transport();
    await expect(runGmailImportPage(env, client, "dispatch-recovery", scope)).rejects.toThrow(
      "gmail_import_failed",
    );
    spy.mockRestore();
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT pending_json,page_token,imported_count FROM gmail_imports",
      ).first(),
    ).toEqual({ pending_json: '["123"]', page_token: null, imported_count: 0 });
    const key = await env.MAIL_CATALOG.prepare("SELECT raw_key FROM archive_sources").first<string>(
      "raw_key",
    );
    expect(new Uint8Array(await (await env.MAIL_ARCHIVE.get(key!))!.arrayBuffer())).toEqual(raw);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM processing_jobs").first("n"),
    ).toBe(0);
    expect(await runGmailImportPage(env, client, "dispatch-recovery", scope)).toEqual({
      status: "complete",
      imported: 1,
    });
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(client.getRaw).toHaveBeenCalledTimes(1);
    expect(workflow.createBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous dispatch durable and repairs the same identity without replaying raw mail", async () => {
    await startGmailImport(env, "dispatch-unknown", scope);
    workflow.createBatch.mockRejectedValueOnce(new Error("Synthetic lost creation response"));
    const client = transport();
    expect(await runGmailImportPage(env, client, "dispatch-unknown", scope)).toEqual({
      status: "complete",
      imported: 1,
    });
    const job = await env.MAIL_CATALOG.prepare(
      "SELECT raw_key,instance_id,state,created_at,failure_code FROM processing_jobs",
    ).first<{
      raw_key: string;
      instance_id: string;
      state: string;
      created_at: number;
      failure_code: string;
    }>();
    expect(job).toMatchObject({ state: "pending", failure_code: "dispatch_unavailable" });
    await startGmailImport(env, "dispatch-unknown-replay", scope);
    await runGmailImportPage(env, client, "dispatch-unknown-replay", scope);
    expect(workflow.createBatch).toHaveBeenCalledTimes(1);
    await repairProcessing(
      env.MAIL_CATALOG,
      workflow,
      job!.created_at + PROCESSING_CHECK_INTERVAL_MS + 1,
    );
    expect(workflow.createBatch).toHaveBeenCalledTimes(2);
    expect(workflow.createBatch.mock.calls[1]![0].instances[0].id).toBe(job!.instance_id);
    expect(client.getRaw).toHaveBeenCalledTimes(1);
    expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) n FROM mail_events").first("n")).toBe(0);
  });

  it("keeps a persisted page after partial failure and advances counts only once after replay", async () => {
    await startGmailImport(env, "history", scope);
    const client = {
      list: vi.fn(async () => ({
        messages: [{ id: "123" }, { id: "456" }],
        nextPageToken: "page2",
      })),
      getRaw: vi.fn(async (id: string) => {
        if (id === "456") throw new Error("private provider error");
        return message(id);
      }),
    };
    await expect(runGmailImportPage(env, client, "history", scope)).rejects.toThrow(
      "gmail_import_failed",
    );
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT page_token,pending_json,imported_count FROM gmail_imports",
      ).first(),
    ).toEqual({ page_token: null, pending_json: '["123","456"]', imported_count: 0 });
    client.getRaw.mockImplementation(async (id) => message(id));
    expect(await runGmailImportPage(env, client, "history", scope)).toEqual({
      status: "advanced",
      imported: 2,
    });
    expect(client.list).toHaveBeenCalledTimes(1);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM archive_sources").first("n"),
    ).toBe(2);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT page_token,imported_count FROM gmail_imports").first(),
    ).toEqual({ page_token: "page2", imported_count: 2 });
  });

  it("fences concurrent runners and scope changes, and does not checkpoint conflicting raw bytes", async () => {
    await startGmailImport(env, "history", scope);
    await expect(
      startGmailImport(env, "history", { ...scope, includeSpamTrash: false }),
    ).rejects.toThrow("import_scope_conflict");
    await env.MAIL_CATALOG.prepare("UPDATE gmail_imports SET lease_until=?")
      .bind(Date.now() + 60_000)
      .run();
    const client = transport();
    expect(await runGmailImportPage(env, client, "history", scope)).toEqual({
      status: "busy",
      imported: 0,
    });
    expect(client.list).not.toHaveBeenCalled();
    await env.MAIL_CATALOG.prepare("UPDATE gmail_imports SET lease_until=0").run();
    await runGmailImportPage(env, client, "history", scope);
    await startGmailImport(env, "changed", scope);
    const key = await env.MAIL_CATALOG.prepare("SELECT raw_key FROM archive_sources").first<string>(
      "raw_key",
    );
    await env.MAIL_ARCHIVE.put(key!, "Different raw");
    await expect(runGmailImportPage(env, client, "changed", scope)).rejects.toThrow(
      "gmail_source_conflict",
    );
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT imported_count FROM gmail_imports WHERE import_id='changed'",
      ).first("imported_count"),
    ).toBe(0);
  });
});

describe("trusted Gmail import operator handler", () => {
  it("accepts an empty network stream while rejecting streamed input or a stalled body", async () => {
    const runtime = { importId: "network-stream", scope, transport: transport() };
    const operator = { id: "synthetic-operator", scopes: ["mail:import"], fromAddresses: [] };
    const url = "https://mail.example.invalid/api/admin/gmail-import/start";
    const empty = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    expect(
      (
        await handleGmailImport(
          new Request(url, { method: "POST", body: empty }),
          env,
          operator,
          runtime,
        )
      ).status,
    ).toBe(200);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    expect(
      (
        await handleGmailImport(
          new Request(url, { method: "POST", body: input }),
          env,
          operator,
          runtime,
        )
      ).status,
    ).toBe(400);
    const stalled = new ReadableStream<Uint8Array>();
    expect(
      (
        await handleGmailImport(
          new Request(url, { method: "POST", body: stalled }),
          env,
          operator,
          runtime,
        )
      ).status,
    ).toBe(400);
    expect(runtime.transport.list).not.toHaveBeenCalled();
  });
  it("requires a separate grant and accepts only configured bodyless actions", async () => {
    const runtime = { importId: "operator", scope, transport: transport() };
    const reader = { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] };
    const operator = { ...reader, scopes: ["mail:import"] };
    const url = "https://mail.example.invalid/api/admin/gmail-import/";
    expect(
      (
        await handleGmailImport(
          new Request(`${url}start`, { method: "POST" }),
          env,
          reader,
          runtime,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleGmailImport(
          new Request(`${url}start`, { method: "POST", body: '{"scope":"untrusted"}' }),
          env,
          operator,
          runtime,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleGmailImport(new Request(`${url}page`), env, operator, runtime)).status,
    ).toBe(405);
    expect(
      (
        await handleGmailImport(
          new Request(`${url}start`, { method: "POST" }),
          env,
          operator,
          runtime,
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await handleGmailImport(
          new Request(`${url}page`, { method: "POST" }),
          env,
          operator,
          runtime,
        )
      ).json(),
    ).toEqual({ status: "complete", imported: 1 });
    const status = await handleGmailImport(new Request(`${url}status`), env, operator, runtime);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual({
      status: "complete",
      imported_count: 1,
      revision: 1,
      pending_count: 0,
      busy: false,
    });
    expect(runtime.transport.list).toHaveBeenCalledTimes(1);
  });
});

describe("read-only Gmail transport", () => {
  it("rejects a token for a different mailbox before listing mail, and rechecks rotated tokens", async () => {
    let token = "first-token";
    const request = vi.fn<typeof fetch>().mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/profile")
              ? {
                  emailAddress:
                    token === "first-token"
                      ? "synthetic@example.invalid"
                      : "different@example.invalid",
                }
              : { messages: [] },
          ),
        ),
    );
    const client = createReadonlyGmailTransport({
      scopes: [GMAIL_READONLY_SCOPE],
      expectedAccountHash: await accountHash(),
      accessToken: async () => token,
      fetch: request,
      sleep: async () => undefined,
    });
    await client.list({ q: "", maxResults: 10, includeSpamTrash: true });
    token = "rotated-token";
    await expect(client.list({ q: "", maxResults: 10, includeSpamTrash: true })).rejects.toThrow(
      "gmail_account_mismatch",
    );
    expect(request.mock.calls.map(([url]) => String(url).endsWith("/profile"))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("decodes raw JSON across key, quartet and padding boundaries, and rejects malformed or duplicate fields", async () => {
    const parts = [
      '{"id":"123","ra',
      'w" : "AP',
      "8",
      "B",
      "A",
      "g",
      "=",
      "=",
      '","threadId":"thread123","internalDate":"1700000000000","labelIds":["SENT"]}',
    ];
    let chunks = parts;
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith("/profile")
        ? new Response(JSON.stringify({ emailAddress: "synthetic@example.invalid" }))
        : new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const part of chunks) controller.enqueue(new TextEncoder().encode(part));
                controller.close();
              },
            }),
          ),
    );
    const client = createReadonlyGmailTransport({
      scopes: [GMAIL_READONLY_SCOPE],
      expectedAccountHash: await accountHash(),
      accessToken: async () => "synthetic-token",
      fetch: request,
      sleep: async () => undefined,
    });
    const value = (await client.getRaw("123")) as { rawBytes: Uint8Array; labelIds: string[] };
    expect(value.rawBytes).toEqual(new Uint8Array([0, 255, 1, 2]));
    expect(value.labelIds).toEqual(["SENT"]);
    chunks = ['{"raw":"AA",'];
    await expect(client.getRaw("123")).rejects.toThrow("gmail_invalid_response");
    chunks = ['{"raw":"AA","\\u0072aw":""}'];
    await expect(client.getRaw("123")).rejects.toThrow("gmail_invalid_response");
    chunks = ['{"payload":{"raw":"AA"}}'];
    await expect(client.getRaw("123")).rejects.toThrow("gmail_invalid_response");
  });

  it("archives a full 25 MiB raw stream without whole-message JSON/base64 buffering", async () => {
    const length = 25 * 1024 * 1024;
    const expected = new Uint8Array(length);
    for (let i = 0; i < length; i++) expected[i] = i % 3;
    let remaining = Math.floor(length / 3);
    let started = false;
    const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith("/profile")
        ? new Response(JSON.stringify({ emailAddress: "synthetic@example.invalid" }))
        : new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!started) {
                  started = true;
                  controller.enqueue(new TextEncoder().encode('{"raw":"'));
                  return;
                }
                if (remaining) {
                  const count = Math.min(remaining, 16384);
                  remaining -= count;
                  controller.enqueue(new TextEncoder().encode("AAEC".repeat(count)));
                  return;
                }
                controller.enqueue(
                  new TextEncoder().encode(
                    'AA","id":"123","threadId":"thread123","internalDate":"1700000000000","labelIds":["SENT"]}',
                  ),
                );
                controller.close();
              },
            }),
          ),
    );
    const client = createReadonlyGmailTransport({
      scopes: [GMAIL_READONLY_SCOPE],
      expectedAccountHash: await accountHash(),
      accessToken: async () => "synthetic-token",
      fetch: request,
      sleep: async () => undefined,
    });
    const value = (await client.getRaw("123")) as { rawBytes: Uint8Array };
    expect(value.rawBytes.byteLength).toBe(length);
    expect(await crypto.subtle.digest("SHA-256", value.rawBytes)).toEqual(
      await crypto.subtle.digest("SHA-256", expected),
    );
  }, 30_000);

  it("uses only fixed-host GET RAW/list calls with trusted credentials and bounded retry", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("private", { status: 429, headers: { "Retry-After": "1" } }),
      )
      .mockImplementation(
        async (url) =>
          new Response(
            JSON.stringify(
              String(url).endsWith("/profile")
                ? { emailAddress: "synthetic@example.invalid" }
                : String(url).includes("format=raw")
                  ? message()
                  : { messages: [] },
            ),
          ),
      );
    const sleep = vi.fn(async () => undefined);
    const client = createReadonlyGmailTransport({
      scopes: [GMAIL_READONLY_SCOPE],
      expectedAccountHash: await accountHash(),
      accessToken: async () => "synthetic-token",
      fetch: request,
      sleep,
    });
    await client.list({ q: "before:1800000000", includeSpamTrash: true, maxResults: 10 });
    await client.getRaw("123");
    expect(request).toHaveBeenCalledTimes(4);
    for (const [url, options] of request.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://gmail.googleapis.com");
      expect(options?.method).toBe("GET");
      expect(options?.redirect).toBe("error");
    }
    expect(String(request.mock.calls[3]?.[0])).toContain("/me/messages/123?format=raw");
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(() =>
      createReadonlyGmailTransport({
        scopes: ["https://mail.google.com/"],
        expectedAccountHash: "a".repeat(64),
        accessToken: async () => "unused",
      }),
    ).toThrow("readonly_scope_required");
  });
  it("fails closed on auth, redirects and overlarge responses without provider prose", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private credential details", { status: 401 }));
    const client = createReadonlyGmailTransport({
      scopes: [GMAIL_READONLY_SCOPE],
      expectedAccountHash: await accountHash(),
      accessToken: async () => "synthetic-token",
      fetch: request,
      sleep: async () => undefined,
    });
    await expect(client.getRaw("123")).rejects.toThrow("gmail_http_401");
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValue(new Response("x".repeat(33 * 1024)));
    await expect(client.list({ q: "", maxResults: 10, includeSpamTrash: true })).rejects.toThrow(
      "gmail_response_too_large",
    );
  });
});
