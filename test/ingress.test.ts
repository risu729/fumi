import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { CAPTURE_TIMEOUT_MS, MAX_RAW_BYTES } from "../src/limits.ts";
import type { Receipt } from "../src/index.ts";

const mime = new TextEncoder().encode(
  [
    "From: Sender <sender@example.invalid>",
    "To: public@example.invalid",
    "Message-ID: <duplicate@example.invalid>",
    "Subject: Synthetic attachment",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="synthetic"',
    "",
    "--synthetic",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Synthetic body \u65e5\u672c\u8a9e",
    "--synthetic",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="fixture.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAECA//+/Q==",
    "--synthetic--",
    "",
  ].join("\r\n"),
);

function message(bytes = mime, rawSize = bytes.byteLength, chunkSize = 37) {
  let offset = 0;
  const forward = vi
    .fn<ForwardableEmailMessage["forward"]>()
    .mockResolvedValue({ messageId: "synthetic-forward-id" });
  const raw = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset = Math.min(offset + chunkSize, bytes.byteLength);
    },
  });
  return {
    from: "envelope-sender@example.invalid",
    to: "private-bcc@example.invalid",
    raw,
    rawSize,
    headers: new Headers({ "X-Fumi-Ingest-ID": "untrusted-marker" }),
    forward,
    setReject: vi.fn(),
    async reply(_message: EmailMessage | EmailReplyMessageBuilder): Promise<EmailSendResult> {
      throw new Error("Reply must never be used by ingress");
    },
  } satisfies ForwardableEmailMessage;
}

async function run(incoming: ForwardableEmailMessage, bindings = env) {
  await worker.email(incoming, bindings);
}

async function objects() {
  return (await env.MAIL_ARCHIVE.list()).objects;
}

async function receipts(): Promise<Receipt[]> {
  const stored = (await objects()).filter((object) => object.key.endsWith("/receipt.json"));
  return Promise.all(
    stored.map(async ({ key }) => {
      const receipt = await env.MAIL_ARCHIVE.get(key);
      if (!receipt) throw new Error("Missing synthetic receipt");
      return receipt.json<Receipt>();
    }),
  );
}

beforeEach(async () => {
  await Promise.all((await objects()).map(({ key }) => env.MAIL_ARCHIVE.delete(key)));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("archive and forward ingress in workerd", () => {
  it("keeps catalog failures out of delivery and redacts scheduled failure diagnostics", async () => {
    const database = vi.spyOn(env.MAIL_CATALOG, "withSession").mockImplementation(() => {
      throw new Error("private database diagnostic with recipient and key");
    });
    const incoming = message();
    await run(incoming);
    expect(incoming.forward).toHaveBeenCalledOnce();
    expect(database).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(worker.scheduled(createScheduledController(), env)).rejects.toThrow(
      "Archive reconciliation did not complete",
    );
    expect(error).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: "archive_reconcile", status: "failed" }),
    );
  });

  it("preserves exact multipart bytes, checksum, private envelope and forwarding provenance", async () => {
    const incoming = message();
    await run(incoming);
    const receipt = (await receipts())[0];
    expect(receipt?.envelope).toEqual({ from: incoming.from, to: incoming.to });
    expect(receipt?.forward.status).toBe("forwarded");
    if (receipt?.archive.status !== "stored") throw new Error("Expected stored fixture");
    const raw = await env.MAIL_ARCHIVE.get(receipt.archive.key);
    expect(new Uint8Array(await raw!.arrayBuffer())).toEqual(mime);
    const digest = await crypto.subtle.digest("SHA-256", mime);
    expect(raw!.checksums.sha256).toEqual(digest);
    expect(raw!.customMetadata).toMatchObject({
      envelopeFrom: incoming.from,
      envelopeTo: incoming.to,
      ingestId: receipt.ingestId,
      sha256: receipt.archive.sha256,
    });
    expect(incoming.forward).toHaveBeenCalledExactlyOnceWith(env.FORWARD_TO, expect.any(Headers));
    expect(incoming.forward.mock.calls[0]?.[1]?.get("X-Fumi-Ingest-ID")).toBe(receipt.ingestId);
  });

  it("keeps repeated identical deliveries as separate evidence and forwards each", async () => {
    const first = message();
    const second = message();
    await run(first);
    await run(second);
    const stored = await receipts();
    expect(stored).toHaveLength(2);
    expect(stored[0]?.ingestId).not.toBe(stored[1]?.ingestId);
    expect(await objects()).toHaveLength(4);
    expect(first.forward).toHaveBeenCalledOnce();
    expect(second.forward).toHaveBeenCalledOnce();
  });

  it("forwards despite raw R2 failure and persists an independent failure receipt", async () => {
    vi.spyOn(env.MAIL_ARCHIVE, "put").mockRejectedValueOnce(new Error("private raw diagnostic"));
    const incoming = message();
    await run(incoming);
    expect(incoming.forward).toHaveBeenCalledOnce();
    expect((await receipts())[0]?.archive).toEqual({ status: "failed", code: "raw_write_failed" });
  });

  it("forwards despite receipt R2 failure and preserves envelope metadata on the raw object", async () => {
    const original = env.MAIL_ARCHIVE.put.bind(env.MAIL_ARCHIVE);
    vi.spyOn(env.MAIL_ARCHIVE, "put").mockImplementation((key, value, options) => {
      if (key.endsWith("/receipt.json"))
        return Promise.reject(new Error("private receipt diagnostic"));
      return original(key, value, options);
    });
    const incoming = message();
    await run(incoming);
    const stored = await objects();
    expect(stored).toHaveLength(1);
    const raw = await env.MAIL_ARCHIVE.head(stored[0]!.key);
    expect(raw?.customMetadata?.["envelopeTo"]).toBe(incoming.to);
    expect(incoming.forward).toHaveBeenCalledOnce();
  });

  it("surfaces forwarding failure after preserving the raw mail and failed outcome", async () => {
    const incoming = message();
    incoming.forward.mockRejectedValue(new Error("private SMTP diagnostic"));
    await expect(run(incoming)).rejects.toThrow("Forwarding did not complete");
    const receipt = (await receipts())[0];
    expect(receipt?.archive.status).toBe("stored");
    expect(receipt?.forward).toEqual({ status: "failed", code: "forward_failed" });
  });

  it("surfaces combined failures without payload or exception data in logs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env.MAIL_ARCHIVE, "put").mockRejectedValue(new Error("private R2 diagnostic"));
    const incoming = message();
    incoming.forward.mockRejectedValue(new Error("private SMTP diagnostic"));
    await expect(run(incoming)).rejects.toThrow("Forwarding did not complete");
    const entry: Record<string, string> = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(Object.keys(entry).sort()).toEqual([
      "archive",
      "event",
      "forward",
      "ingestId",
      "receipt",
    ]);
    expect(entry).toMatchObject({ archive: "failed", forward: "failed", receipt: "failed" });
  });

  it.each([Number.NaN, -1, 1.5, MAX_RAW_BYTES + 1])(
    "bounds invalid advertised size %s without blocking forwarding",
    async (size) => {
      const incoming = message(mime, size);
      await run(incoming);
      expect(incoming.forward).toHaveBeenCalledOnce();
      expect((await receipts())[0]?.archive.status).toBe("failed");
      expect((await objects()).some((object) => object.key.endsWith("/raw.eml"))).toBe(false);
    },
  );

  it.each([-1, 1])(
    "rejects actual stream length mismatch %s while forwarding",
    async (difference) => {
      const incoming = message(mime, mime.byteLength + difference);
      await run(incoming);
      expect((await receipts())[0]?.archive).toEqual({ status: "failed", code: "size_mismatch" });
      expect(incoming.forward).toHaveBeenCalledOnce();
    },
  );

  it("forwards despite a broken raw stream", async () => {
    const incoming = message();
    incoming.raw = new ReadableStream({
      start(controller) {
        controller.error(new Error("private reader diagnostic"));
      },
    });
    await run(incoming);
    expect((await receipts())[0]?.archive).toEqual({ status: "failed", code: "read_failed" });
    expect(incoming.forward).toHaveBeenCalledOnce();
  });

  it("times out a stalled raw reader while forwarding independently", async () => {
    vi.useFakeTimers();
    const incoming = message();
    incoming.raw = new ReadableStream();
    const completed = run(incoming);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS + 1);
    await completed;
    expect((await receipts())[0]?.archive).toEqual({ status: "failed", code: "capture_timeout" });
    expect(incoming.forward).toHaveBeenCalledOnce();
  });

  it("stores an exact 25 MiB fixture with bounded chunk reads", async () => {
    const bytes = new Uint8Array(MAX_RAW_BYTES);
    bytes[0] = 1;
    bytes[MAX_RAW_BYTES - 1] = 255;
    const incoming = message(bytes, bytes.byteLength, 64 * 1024);
    await run(incoming);
    expect((await receipts())[0]?.archive).toMatchObject({ status: "stored", size: MAX_RAW_BYTES });
  }, 30_000);

  it("does not let stalled cancellation extend the capture deadline", async () => {
    vi.useFakeTimers();
    const incoming = message();
    incoming.raw = new ReadableStream({
      cancel() {
        return new Promise(() => undefined);
      },
    });
    const completed = run(incoming);
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS + 1);
    await completed;
    expect((await receipts())[0]?.archive).toEqual({ status: "failed", code: "capture_timeout" });
    expect(incoming.forward).toHaveBeenCalledOnce();
  });

  it.each([
    "",
    "mail@example.invalid",
    "a@gmail.com,b@gmail.com",
    "a@gmail.com\r\nBcc: x@gmail.com",
  ])("rejects unsafe private forwarding configuration %s and still archives", async (target) => {
    const incoming = message();
    await expect(run(incoming, { ...env, FORWARD_TO: target })).rejects.toThrow(
      "Forwarding did not complete",
    );
    expect(incoming.forward).not.toHaveBeenCalled();
    expect((await receipts())[0]?.archive.status).toBe("stored");
  });

  it("rejects forwarding directly to the envelope recipient", async () => {
    const incoming = message();
    incoming.to = env.FORWARD_TO.toUpperCase();
    await expect(run(incoming)).rejects.toThrow("Forwarding did not complete");
    expect(incoming.forward).not.toHaveBeenCalled();
  });
});
