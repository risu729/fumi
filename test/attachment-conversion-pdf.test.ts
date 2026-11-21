import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { unlockPdf } from "../src/attachment-conversion-pdf.ts";
import { isEncryptedPdf } from "../src/attachment-conversion-pdf-encryption.ts";
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
const plainPdf = `${plainBody}\nxref\n0 7\ntrailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${plainBody.length + 1}\n%%EOF\n`;
// The generated AES-256 fixture ends with its cross-reference stream object `6 0 obj`.
const original = atob(encryptedPdf);
const xrefAt = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(original)![1]);
const objects = original.slice(0, xrefAt);
const xrefObject = original.slice(xrefAt, original.indexOf("endobj", xrefAt) + "endobj".length);
const streamAt = xrefObject.indexOf("stream");
/** Wraps the unchanged cross-reference stream object; startxref still points at `6 0 obj`. */
const relocated = (before: string, after = "", object = xrefObject) =>
  `${objects}${before}${object}${after}\nstartxref\n${xrefAt + before.length}\n%%EOF\n`;
const objectOffsets = [...objects.matchAll(/\d+ 0 obj/g)].map((match) => match.index);
const xrefTable = `xref\n0 ${objectOffsets.length + 1}\n0000000000 65535 f \n${objectOffsets
  .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
  .join("")}`;
const trailer = `trailer\n<< /Size ${objectOffsets.length + 1} /Root 2 0 R /Info 3 0 R /Encrypt 5 0 R ${
  /\/ID ?\[[^\]]*\]/.exec(xrefObject)![0]
} >>\n`;
/** The same objects with a classic table and trailer instead; startxref points at `xref`. */
const classicSection = (before: string, after = "", tail = "") =>
  `${objects}${before}${xrefTable}${trailer}${after}startxref\n${objects.length + before.length}\n%%EOF\n${tail}`;
// Each places the section a parser reads by offset where the lexical scan skips bytes.
const hiddenSections = {
  "cross-reference stream behind a bare stream keyword": relocated("stream\n"),
  "cross-reference stream inside a literal string": relocated("(\n", "\n)"),
  "cross-reference stream inside a hex string": relocated("<\n"),
  "cross-reference stream dictionary on a comment line": relocated(
    "% ",
    "",
    xrefObject.slice(0, streamAt).replaceAll("\n", " ") + xrefObject.slice(streamAt),
  ),
  "classic trailer inside a literal string": classicSection("(\n", ")\n"),
  "classic trailer inside a hex string": classicSection("<\n"),
  "classic trailer behind a bare stream keyword": classicSection("stream\n", "", "%endstream\n"),
  // LibPDF decodes an escaped name as UTF-8, which drops a leading byte order mark.
  "cross-reference stream /Encrypt name behind an escaped byte order mark": relocated(
    "",
    "",
    xrefObject.replace("/Encrypt ", "/#EF#BB#BFEncrypt "),
  ),
  "classic trailer /Encrypt name behind a raw byte order mark and an escape": classicSection(
    "",
  ).replace("/Encrypt ", "/\xef\xbb\xbfEncryp#74 "),
  // An entry line ends with arbitrary bytes, so the first `trailer` after `xref` may be a decoy.
  "classic trailer more than 64 KiB after its keyword, behind a decoy in a table entry":
    classicSection("(\n", ")\n")
      .replace("trailer\n<<", `trailer\n${" ".repeat(65_536)}<<`)
      .replace(" 65535 f \n", " 65535 f trailer << >>\n"),
};
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
  it.each(Object.entries(hiddenSections))(
    "detects a %s that the isolated parser decrypts",
    async (_, text) => {
      expect(isEncryptedPdf(latin1(text), "application/pdf")).toBe(true);
      // The child rejects any PDF that LibPDF does not report as encrypted and authenticated.
      await expect(unlockPdf(env.PDF_LOADER!, latin1(text), [password])).resolves.toMatchObject({
        pages: 1,
      });
    },
  );
  it("follows /Prev to an older cross-reference section hidden inside a string", () => {
    // LibPDF reads /Encrypt from the newest section only; other parsers may merge older ones.
    const hidden = `${objects}(\n${xrefObject}\n)\n`;
    const entry = String.fromCharCode(1, hidden.length >> 8, hidden.length & 0xff, 0, 0);
    const newest = `7 0 obj\n<< /Type /XRef /Size 8 /Index [7 1] /W [1 2 2] /Root 2 0 R /Prev ${xrefAt + 2} /Length 5 >>\nstream\n${entry}\nendstream\nendobj\n`;
    const text = `${hidden}${newest}startxref\n${hidden.length}\n%%EOF\n`;
    expect(isEncryptedPdf(latin1(text), "application/pdf")).toBe(true);
    // LibPDF also follows a /Prev key spelled with a byte order mark.
    const bom = text.replace("/Prev ", "/#EF#BB#BFPrev ");
    expect(isEncryptedPdf(latin1(bom), "application/pdf")).toBe(true);
    // LibPDF reads `+N` and `--N` as the number N.
    for (const sign of ["+", "--"]) {
      const signed = text.replace("/Prev ", `/Prev ${sign}`);
      expect(isEncryptedPdf(latin1(signed), "application/pdf")).toBe(true);
    }
    // Without /Prev no offset reaches the string, so a parser never reads that section.
    const unreachable = text.replace(`/Prev ${xrefAt + 2} `, "");
    expect(isEncryptedPdf(latin1(unreachable), "application/pdf")).toBe(false);
  });
  it("ignores the token in strings of a parser-written unencrypted PDF", async () => {
    const { bytes: clear } = await unlockPdf(env.PDF_LOADER!, bytes(encryptedPdf), [password]);
    const text = new TextDecoder("latin1").decode(clear);
    // Same-length replacement keeps every cross-reference offset LibPDF wrote valid.
    const mentioned = text.replace(
      /\/Title <[\dA-F]+>/,
      (title) => `/Title (/Encrypt 5 0 R <</Encrypt 5 0 R>>`.padEnd(title.length - 1, " ") + ")",
    );
    expect(mentioned).not.toBe(text);
    expect(mentioned.length).toBe(text.length);
    expect(isEncryptedPdf(latin1(mentioned), "application/pdf")).toBe(false);
  });
  it("counts a mention as encrypted when the cross-reference offsets cannot be read", () => {
    const at = plainBody.length + 1;
    /** Appends objects and comments whose /Prev offsets each point at one of them. */
    const withObjects = (count: number) => {
      let text = plainPdf;
      const references: string[] = [];
      for (let index = 0; index < count; index++) {
        references.push(`% /Prev ${text.length}\n`);
        text += `${index + 7} 0 obj << /Producer (/Encrypt) >> endobj\n`;
      }
      return text + references.join("");
    };
    const conservative = [
      plainPdf.replace(`startxref\n${at}`, ""),
      plainPdf.replace(`startxref\n${at}`, `startxref\n${plainPdf.length}`),
      plainPdf.replace(`startxref\n${at}`, "startxref\n9"),
      plainPdf.replace(`startxref\n${at}`, `startxref % ${at}\n${at}`),
      plainPdf.replace("/Info 6 0 R", "/Info 6 0 R /Prev 4"),
      plainPdf.replace("trailer\n", ""),
      plainPdf.replace("/Info 6 0 R >>", "/Info 6 0 R"),
      ` ${plainPdf.replace(`startxref\n${at}`, `startxref\n${at + 1}`)}`,
      withObjects(32),
      `${plainPdf}${"% trailer\n".repeat(32)}`,
    ];
    for (const text of conservative)
      expect(isEncryptedPdf(latin1(text), "application/pdf"), text).toBe(true);
    // Offsets and `trailer` keywords count wherever they appear, up to 32 of each.
    expect(isEncryptedPdf(latin1(withObjects(31)), "application/pdf")).toBe(false);
    expect(
      isEncryptedPdf(latin1(`${plainPdf}${"% trailer\n".repeat(31)}`), "application/pdf"),
    ).toBe(false);
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
