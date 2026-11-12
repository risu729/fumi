import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleArchiveRepair } from "../src/archive-repair-http.ts";
import type { MailPrincipal } from "../src/principal.ts";

const repair = vi.hoisted(() => ({
  processing: vi.fn(),
  attachments: vi.fn(),
  content: vi.fn(),
  managed: vi.fn(),
  passwords: vi.fn(),
}));
vi.mock("../src/processing-jobs.ts", () => ({ repairProcessing: repair.processing }));
vi.mock("../src/attachment-conversion.ts", () => ({
  repairAttachmentConversions: repair.attachments,
}));
vi.mock("../src/attachment-passwords.ts", () => ({ resolveAttachmentPasswords: repair.passwords }));
vi.mock("../src/content-search.ts", () => ({ repairContentSearch: repair.content }));
vi.mock("../src/managed-mail-corpus.ts", () => ({ repairManagedMailCorpus: repair.managed }));

const url = "https://mail.example.invalid/api/admin/archive/repair";
const operator: MailPrincipal = {
  id: "synthetic-operator",
  scopes: ["mail:import"],
  fromAddresses: [],
};
const post = () => new Request(url, { method: "POST" });
const stages = () => [repair.processing, repair.attachments, repair.content, repair.managed];
beforeEach(() => {
  vi.resetAllMocks();
  repair.processing.mockResolvedValue({ discovered: 2, checked: 1, deferred: 1 });
  repair.attachments.mockResolvedValue({ enabled: true, processed: 2 });
  repair.content.mockResolvedValue({ indexed: 3, deferred: 0 });
  repair.managed.mockResolvedValue({ enabled: true, processed: 2 });
  repair.passwords.mockResolvedValue(["synthetic-password-candidate"]);
});
describe("bounded authenticated archive repair", () => {
  it("requires the separate import grant and accepts only the exact POST route without input", async () => {
    expect(
      (await handleArchiveRepair(post(), env, { ...operator, scopes: ["mail:read"] })).status,
    ).toBe(403);
    expect((await handleArchiveRepair(new Request(url), env, operator)).status).toBe(405);
    expect(
      (await handleArchiveRepair(new Request(`${url}/extra`, { method: "POST" }), env, operator))
        .status,
    ).toBe(404);
    expect(
      (
        await handleArchiveRepair(
          new Request(`${url}?limit=1000`, { method: "POST" }),
          env,
          operator,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleArchiveRepair(new Request(url, { method: "POST", body: "{}" }), env, operator))
        .status,
    ).toBe(400);
    for (const run of stages()) expect(run).not.toHaveBeenCalled();
  });
  it("accepts a network-style empty stream and reports only bounded stage counts", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const response = await handleArchiveRepair(
      new Request(url, { method: "POST", body: stream }),
      env,
      operator,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "complete",
      stages: {
        processing: { status: "complete", counts: { discovered: 2, checked: 1, deferred: 1 } },
        attachments: { status: "complete", counts: { processed: 2 } },
        content_search: { status: "complete", counts: { indexed: 3, deferred: 0 } },
        managed_corpus: { status: "complete", counts: { processed: 2 } },
      },
    });
    for (const run of stages()) expect(run).toHaveBeenCalledTimes(1);
    expect(repair.processing).toHaveBeenCalledWith(env.MAIL_CATALOG, env.MAIL_PROCESSING);
  });
  it("awaits each stage in order and supplies only the canonical authorized password resolver", async () => {
    const order: string[] = [];
    let finishProcessing:
      | ((value: { discovered: number; checked: number; deferred: number }) => void)
      | undefined;
    repair.processing.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("processing");
          finishProcessing = resolve;
        }),
    );
    const hint = { rawKey: "synthetic/raw", attachmentSha256: "a".repeat(64), limit: 8 as const };
    repair.attachments.mockImplementation(async (context) => {
      order.push("attachments");
      expect(await context.resolveAttachmentPasswords(hint)).toEqual([
        "synthetic-password-candidate",
      ]);
      return { enabled: true, processed: 1, secret: "must-not-escape" };
    });
    repair.content.mockImplementation(async () => {
      order.push("content");
      return { indexed: 1, deferred: 0 };
    });
    repair.managed.mockImplementation(async () => {
      order.push("managed");
      return { enabled: true, processed: 1 };
    });
    const response = handleArchiveRepair(post(), env, operator);
    await vi.waitFor(() => expect(repair.processing).toHaveBeenCalledTimes(1));
    expect(repair.attachments).not.toHaveBeenCalled();
    finishProcessing!({ discovered: 1, checked: 1, deferred: 0 });
    const result = await response;
    expect(order).toEqual(["processing", "attachments", "content", "managed"]);
    expect(repair.passwords).toHaveBeenCalledWith(env, hint);
    expect(await result.text()).not.toMatch(/must-not-escape|synthetic-password-candidate/);
  });
  it("continues independent stages after failures and discards private exception text", async () => {
    repair.processing.mockRejectedValue(new Error("private-processing-key"));
    repair.managed.mockRejectedValue(new Error("private-provider-detail"));
    const response = await handleArchiveRepair(post(), env, operator);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/private-processing-key|private-provider-detail/);
    expect(JSON.parse(text)).toEqual({
      status: "partial",
      stages: {
        processing: {
          status: "failed",
          counts: {},
          error: { code: "archive_processing_repair_failed" },
        },
        attachments: { status: "complete", counts: { processed: 2 } },
        content_search: { status: "complete", counts: { indexed: 3, deferred: 0 } },
        managed_corpus: {
          status: "failed",
          counts: {},
          error: { code: "archive_managed_corpus_repair_failed" },
        },
      },
    });
    for (const run of stages()) expect(run).toHaveBeenCalledTimes(1);
  });
  it("reports disabled optional backends while processing and local indexing still run", async () => {
    repair.attachments.mockResolvedValue({ enabled: false, processed: 0 });
    repair.managed.mockResolvedValue({ enabled: false, processed: 0 });
    const result = (await (await handleArchiveRepair(post(), env, operator)).json()) as {
      status: string;
      stages: Record<string, { status: string; counts: unknown }>;
    };
    expect(result.status).toBe("complete");
    expect(result.stages["attachments"]).toEqual({ status: "disabled", counts: { processed: 0 } });
    expect(result.stages["managed_corpus"]).toEqual({
      status: "disabled",
      counts: { processed: 0 },
    });
    expect(repair.processing).toHaveBeenCalledTimes(1);
    expect(repair.content).toHaveBeenCalledTimes(1);
  });
  it("rejects excessive empty chunks before starting any repair", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 9; chunk++) controller.enqueue(new Uint8Array());
        controller.close();
      },
    });
    expect(
      (await handleArchiveRepair(new Request(url, { method: "POST", body: stream }), env, operator))
        .status,
    ).toBe(400);
    for (const run of stages()) expect(run).not.toHaveBeenCalled();
  });
  it("rejects consumed or errored input without starting any repair", async () => {
    const consumed = new Request(url, { method: "POST", body: "" });
    await consumed.text();
    expect((await handleArchiveRepair(consumed, env, operator)).status).toBe(400);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private-input-detail"));
      },
    });
    const response = await handleArchiveRepair(
      new Request(url, { method: "POST", body: stream }),
      env,
      operator,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-input-detail");
    for (const run of stages()) expect(run).not.toHaveBeenCalled();
  });
  it("bounds stalled empty input and never waits for a stalled cancellation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const response = handleArchiveRepair(
        new Request(url, { method: "POST", body: stream }),
        env,
        operator,
      );
      await vi.advanceTimersByTimeAsync(1001);
      expect((await response).status).toBe(400);
      expect(cancel).toHaveBeenCalledTimes(1);
      for (const run of stages()) expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
