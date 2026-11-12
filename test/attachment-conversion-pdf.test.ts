import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { unlockPdf } from "../src/attachment-conversion-pdf.ts";
import {
  encryptedPdf,
  overPageLimitPdf,
  syntheticPdfPassword as password,
} from "./fixtures/encrypted-pdf.ts";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
describe("isolated encrypted PDF parsing", () => {
  it("decrypts a compressed AES256 PDF in a fresh actual workerd child with no capabilities", async () => {
    const load = vi.fn((code: WorkerLoaderWorkerCode) => env.PDF_LOADER!.load(code));
    const loader = { load, get: vi.fn() } as WorkerLoader;
    const result = await unlockPdf(loader, bytes(encryptedPdf), [
      "wrong-synthetic-password",
      password,
    ]);
    expect(result).toMatchObject({ pages: 1 });
    expect(result.bytes.length).toBeGreaterThan(100);
    expect(new TextDecoder().decode(result.bytes)).toContain("%PDF-");
    expect(new TextDecoder().decode(result.bytes)).not.toContain("/Encrypt");
    expect(load).toHaveBeenCalledTimes(2);
    for (const [code] of load.mock.calls)
      expect(code).toMatchObject({
        env: {},
        globalOutbound: null,
        limits: { cpuMs: 2000, subRequests: 0 },
        mainModule: "parser.js",
      });
  });
  it("requires cryptographic authentication, not successful PDF.load alone", async () => {
    await expect(
      unlockPdf(env.PDF_LOADER!, bytes(encryptedPdf), ["wrong-synthetic-password"]),
    ).rejects.toMatchObject({ code: "password_rejected" });
  });
  it("enforces the parsed page/object bound on compressed input", async () => {
    await expect(
      unlockPdf(env.PDF_LOADER!, bytes(overPageLimitPdf), [password]),
    ).rejects.toMatchObject({ code: "pdf_structure_limit" });
  });
  it("handles malformed compressed PDF without exposing parser details", async () => {
    const malformed = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj << /Type /XRef /Filter /FlatDecode /Length 7 /W [1 2 1] /Size 99999 >> stream\ninvalid\nendstream\nendobj\nstartxref\n9\n%%EOF",
    );
    await expect(unlockPdf(env.PDF_LOADER!, malformed, [password])).rejects.toMatchObject({
      code: "invalid_pdf",
    });
  });
  it("bounds bytes returned by a failed child and reduces resource exceptions to a fixed result", async () => {
    const oversized = {
      load: () => ({
        getEntrypoint: () => ({
          decrypt: async () => ({
            status: "complete",
            pages: 1,
            objects: 4,
            bytes: new Uint8Array(2 * 1024 * 1024 + 1),
          }),
        }),
      }),
    } as unknown as WorkerLoader;
    await expect(unlockPdf(oversized, bytes(encryptedPdf), [password])).rejects.toMatchObject({
      code: "invalid_parser_response",
    });
    const unavailable = {
      load: () => ({
        getEntrypoint: () => ({
          decrypt: async () => {
            throw new Error("private-parser-exception");
          },
        }),
      }),
    } as unknown as WorkerLoader;
    await expect(unlockPdf(unavailable, bytes(encryptedPdf), [password])).rejects.toMatchObject({
      code: "pdf_resource_limit_or_unavailable",
    });
  });
  it("returns a fixed failure when a child never answers before the parent deadline", async () => {
    vi.useFakeTimers();
    try {
      const stalled = {
        load: () => ({ getEntrypoint: () => ({ decrypt: () => new Promise(() => undefined) }) }),
      } as unknown as WorkerLoader;
      const rejected = expect(
        unlockPdf(stalled, bytes(encryptedPdf), [password]),
      ).rejects.toMatchObject({ code: "pdf_resource_limit_or_unavailable" });
      await vi.advanceTimersByTimeAsync(5001);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
