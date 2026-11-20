import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { unlockPdf } from "../src/attachment-conversion-pdf.ts";
import { isEncryptedPdf } from "../src/attachment-conversion-backends.ts";
import {
  encryptedPdf,
  overPageLimitPdf,
  syntheticPdfPassword as password,
} from "./fixtures/encrypted-pdf.ts";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const latin1 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
// Unencrypted synthetic PDF whose content stream, XMP-like stream and Info strings mention the token.
const plainBody = [
  "%PDF-1.7",
  "%\xe2\xe3\xcf\xd3",
  "1 0 obj << /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >> endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >> endobj",
  "4 0 obj << /Length 54 >>",
  "stream",
  "BT /F1 12 Tf 20 100 Td (/Encrypt 6 0 R) Tj /Encrypt Do ET",
  "endstream",
  "endobj",
  "5 0 obj << /Type /Metadata /Subtype /XML /Length 40 >>",
  "stream",
  "<x:xmpmeta>/Encrypt <</Encrypt 6 0 R>></x:xmpmeta>",
  "endstream",
  "endobj",
  "6 0 obj << /Title (Synthetic \\(/Encrypt\\) <</Encrypt 1 0 R>> notes) /Subject <2F456E6372797074> >> endobj",
  "% /Encrypt 6 0 R inside a comment",
].join("\n");
const plainPdf = `${plainBody}\nxref\n0 7\ntrailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n9\n%%EOF\n`;
describe("encrypted PDF detection", () => {
  it("ignores the token in stream data, strings and comments of an unencrypted PDF", () => {
    expect(isEncryptedPdf(latin1(plainPdf), "application/pdf")).toBe(false);
  });
  it("detects classic, incremental, cross-reference stream and escaped trailer entries", () => {
    expect(isEncryptedPdf(bytes(encryptedPdf), "application/pdf")).toBe(true);
    const classic = plainPdf.replace("/Info 6 0 R >>", "/Info 6 0 R /Encrypt 7 0 R >>");
    expect(isEncryptedPdf(latin1(classic), "application/pdf")).toBe(true);
    const incremental = `${plainPdf}7 0 obj << /Filter /Standard /V 5 /R 6 >> endobj\nxref\n0 1\ntrailer\n<< /Size 8 /Prev 9 /Root 1 0 R /En#63rypt 7 0 R >>\nstartxref\n99\n%%EOF\n`;
    expect(isEncryptedPdf(latin1(incremental), "application/pdf")).toBe(true);
    const xrefStream = `${plainBody}\n8 0 obj << /Type /XRef /Size 9 /W [1 2 1] /Root 1 0 R /Encrypt << /Filter /Standard >> /Length 4 >>\nstream\n\x01\x00\x00\x00\nendstream\nendobj\nstartxref\n99\n%%EOF\n`;
    expect(isEncryptedPdf(latin1(xrefStream), "application/pdf")).toBe(true);
    expect(isEncryptedPdf(latin1(classic), "application/octet-stream")).toBe(false);
  });
  it("stays conservative when unterminated stream or string data hides the remainder", () => {
    const head = "%PDF-1.7\n1 0 obj << /Length 9 >>\nstream\nunfinished";
    expect(isEncryptedPdf(latin1(`${head} trailer << /Encrypt 7 0 R >>`), "application/pdf")).toBe(
      true,
    );
    expect(
      isEncryptedPdf(latin1(`${plainPdf}(unterminated /Encrypt 7 0 R`), "application/pdf"),
    ).toBe(true);
    expect(isEncryptedPdf(latin1(`${head} data`), "application/pdf")).toBe(false);
  });
});
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
