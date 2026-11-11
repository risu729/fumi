import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { extractArchiveMail, MIME_LIMITS } from "../src/mime-extraction.ts";

const encoder = new TextEncoder();
const day = "2026-11-11";
const plain =
  "Subject: Synthetic MIME\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body\r\n";

interface ExtractionRow {
  status: string;
  failure_code: string | null;
  raw_sha256: string | null;
  raw_size: number | null;
  instance_id: string;
  metadata_json: string | null;
  attachments_json: string | null;
  body_json_key: string | null;
  body_text_key: string | null;
  body_html_key: string | null;
  manifest_key: string | null;
}

interface AttachmentRecord {
  index: number;
  filename: string | null;
  mimeType: string;
  contentId: string | null;
  key: string;
  sha256: string;
  size: number;
  sourceSha256: string;
  extractorVersion: string;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function source(content: string | Uint8Array = plain) {
  const id = crypto.randomUUID();
  const key = `ingest/${day}/${id}/raw.eml`;
  const instanceId = `mime-v1-${day}-${id}-0`;
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = hex(digest);
  await env.MAIL_ARCHIVE.put(key, bytes, {
    sha256: digest,
    customMetadata: {
      schemaVersion: "1",
      ingestId: id,
      receivedAt: `${day}T00:00:00.000Z`,
      sha256,
      envelopeFrom: "sender@example.invalid",
      envelopeTo: "recipient@example.invalid",
    },
  });
  await env.MAIL_CATALOG.prepare(`INSERT INTO processing_jobs (
    raw_key, pipeline_version, instance_id, state, created_at, updated_at, next_check_at
  ) VALUES (?, 'mime-v1', ?, 'running', 0, 0, 0)`)
    .bind(key, instanceId)
    .run();
  return { key, instanceId, bytes, sha256 };
}

async function row(key: string) {
  return env.MAIL_CATALOG.prepare("SELECT * FROM mail_extractions WHERE raw_key = ?")
    .bind(key)
    .first<ExtractionRow>();
}

async function process(input: { key: string; instanceId: string }) {
  return extractArchiveMail(env.MAIL_ARCHIVE, env.MAIL_CATALOG, input.key, input.instanceId);
}

function mixed(parts: string[]) {
  return `Subject: Synthetic parts\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="synthetic"\r\n\r\n${parts.map((part) => `--synthetic\r\n${part}\r\n`).join("")}--synthetic--\r\n`;
}

function base64(value: string) {
  return btoa(String.fromCharCode(...encoder.encode(value)));
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
  ]);
});

afterEach(() => vi.restoreAllMocks());

describe("bounded MIME extraction in workerd", () => {
  it("stores Japanese bodies, binary and inline attachments, bounded headers and provenance", async () => {
    const input = await source(
      [
        "From: Synthetic Sender <sender@example.invalid>",
        "To: Synthetic Recipient <recipient@example.invalid>",
        `Subject: =?UTF-8?B?${base64("合成メール")}?=`,
        "Date: Wed, 11 Nov 2026 12:00:00 +0900",
        "Message-ID: <synthetic@example.invalid>",
        "In-Reply-To: <parent@example.invalid>",
        "References: <root@example.invalid> <parent@example.invalid>",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="outer"',
        "",
        "--outer",
        'Content-Type: multipart/alternative; boundary="alternative"',
        "",
        "--alternative",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        base64("合成本文 123"),
        "--alternative",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        base64('<p>合成本文</p><img src="https://tracker.example.invalid/pixel">'),
        "--alternative--",
        "--outer",
        "Content-Type: application/octet-stream",
        'Content-Disposition: attachment; filename="../../synthetic.bin"',
        "Content-Transfer-Encoding: base64",
        "",
        "AAEC/w==",
        "--outer",
        "Content-Type: image/png",
        'Content-Disposition: inline; filename="synthetic.png"',
        "Content-ID: <inline-synthetic>",
        "Content-Transfer-Encoding: base64",
        "",
        "AQID",
        "--outer--",
        "",
      ].join("\r\n"),
    );
    const rawBefore = await env.MAIL_ARCHIVE.head(input.key);
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 2 });
    expect(fetch).not.toHaveBeenCalled();
    const stored = await row(input.key);
    expect(stored).toMatchObject({
      status: "complete",
      failure_code: null,
      raw_sha256: input.sha256,
    });
    expect(JSON.parse(stored?.metadata_json ?? "null")).toMatchObject({
      subject: "合成メール",
      from: { address: "sender@example.invalid" },
      to: [{ address: "recipient@example.invalid" }],
      date: "2026-11-11T03:00:00.000Z",
      messageId: "<synthetic@example.invalid>",
      inReplyTo: "<parent@example.invalid>",
      references: "<root@example.invalid> <parent@example.invalid>",
    });
    const attachments: AttachmentRecord[] = JSON.parse(stored?.attachments_json ?? "[]");
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      index: 0,
      filename: "../../synthetic.bin",
      size: 4,
      sourceSha256: input.sha256,
      extractorVersion: "mime-v1",
    });
    expect(attachments[1]).toMatchObject({ index: 1, contentId: "<inline-synthetic>" });
    for (const attachment of attachments) {
      expect(attachment.key).toMatch(
        new RegExp(`^derived/mime-v1/${input.sha256}/attachment/[a-f0-9]{64}$`),
      );
      expect(attachment.key).not.toContain("synthetic");
    }
    const attachment = await env.MAIL_ARCHIVE.get(attachments[0]?.key ?? "");
    expect(new Uint8Array(await attachment!.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(await (await env.MAIL_ARCHIVE.get(stored!.body_text_key!))!.text()).toContain(
      "合成本文 123",
    );
    const html = await env.MAIL_ARCHIVE.get(stored!.body_html_key!);
    expect(html?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(html?.httpMetadata?.contentDisposition).toBe("attachment");
    expect(await html!.text()).toContain("https://tracker.example.invalid/pixel");
    const manifest = await (await env.MAIL_ARCHIVE.get(stored!.manifest_key!))!.json();
    expect(manifest).toMatchObject({
      rawSha256: input.sha256,
      parser: "postal-mime@4.2.1",
      attachments,
    });
    const rawAfter = await env.MAIL_ARCHIVE.get(input.key);
    expect(rawAfter?.version).toBe(rawBefore?.version);
    expect(new Uint8Array(await rawAfter!.arrayBuffer())).toEqual(input.bytes);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM processing_jobs WHERE raw_key = ?")
        .bind(input.key)
        .first("state"),
    ).toBe("running");
  });

  it("keeps attached message/rfc822 separate from the parent body even when marked inline", async () => {
    const nested =
      "From: nested@example.invalid\r\nSubject: Nested synthetic\r\n\r\nNESTED PRIVATE BODY\r\n";
    const input = await source(
      mixed([
        "Content-Type: text/plain\r\n\r\nPARENT SYNTHETIC BODY",
        `Content-Type: message/rfc822\r\nContent-Disposition: inline\r\n\r\n${nested}`,
      ]),
    );
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 1 });
    const stored = await row(input.key);
    const body = await (await env.MAIL_ARCHIVE.get(stored!.body_json_key!))!.text();
    expect(body).toContain("PARENT SYNTHETIC BODY");
    expect(body).not.toContain("NESTED PRIVATE BODY");
    const attachments: AttachmentRecord[] = JSON.parse(stored!.attachments_json!);
    expect(attachments[0]?.mimeType).toBe("message/rfc822");
    expect(await (await env.MAIL_ARCHIVE.get(attachments[0]!.key))!.text()).toContain(
      "NESTED PRIVATE BODY",
    );
  });

  it("decodes quoted-printable and non-UTF8 bodies without HTML conversion", async () => {
    const input = await source(
      "Subject: Synthetic legacy charset\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nSynthetic =63=61=66=E9\r\n",
    );
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 0 });
    const stored = await row(input.key);
    expect(await (await env.MAIL_ARCHIVE.get(stored!.body_text_key!))!.text()).toContain(
      "Synthetic café",
    );
    expect(stored?.body_html_key).toBeNull();
  });

  it("keeps a body larger than the D1 row limit exclusively in R2", async () => {
    const input = await source(`Subject: Synthetic large body\r\n\r\n${"a".repeat(1_100_000)}`);
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 0 });
    const stored = await row(input.key);
    expect(stored!.metadata_json!.length + stored!.attachments_json!.length).toBeLessThan(2000);
    expect((await env.MAIL_ARCHIVE.head(stored!.body_text_key!))?.size).toBeGreaterThan(1_000_000);
  });

  it("replays a completed extraction without changing derivative versions", async () => {
    const input = await source();
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 0 });
    const before = (await env.MAIL_ARCHIVE.list()).objects.map(({ key, version }) => ({
      key,
      version,
    }));
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 0 });
    expect(
      (await env.MAIL_ARCHIVE.list()).objects.map(({ key, version }) => ({ key, version })),
    ).toEqual(before);
  });

  it("records missing, oversized and invalid inputs as opaque coverage blocks", async () => {
    const missing = await source();
    await env.MAIL_ARCHIVE.delete(missing.key);
    expect(await process(missing)).toEqual({
      status: "blocked",
      attachmentCount: 0,
      code: "source_missing",
    });
    expect(await row(missing.key)).toMatchObject({
      status: "blocked",
      failure_code: "source_missing",
    });
    const oversized = await source(new Uint8Array(MIME_LIMITS.rawBytes + 1));
    expect(await process(oversized)).toMatchObject({ status: "blocked", code: "input_too_large" });
    const malformed = await source("NOT A MIME MESSAGE with synthetic secret");
    expect(await process(malformed)).toEqual({
      status: "blocked",
      attachmentCount: 0,
      code: "invalid_mime",
    });
    expect(await row(malformed.key)).toMatchObject({
      raw_sha256: malformed.sha256,
      status: "blocked",
    });
    const rawOnly = (await env.MAIL_ARCHIVE.list()).objects;
    expect(rawOnly.every((object) => object.key.endsWith("raw.eml"))).toBe(true);
  });

  it("rejects an invalid raw key without R2 or D1 writes", async () => {
    const put = vi.spyOn(env.MAIL_ARCHIVE, "put");
    const get = vi.spyOn(env.MAIL_ARCHIVE, "get");
    const result = await extractArchiveMail(
      env.MAIL_ARCHIVE,
      env.MAIL_CATALOG,
      "../../synthetic.eml",
      "anything",
    );
    expect(result).toEqual({ status: "blocked", attachmentCount: 0, code: "invalid_key" });
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_extractions").first(
        "count",
      ),
    ).toBe(0);
  });

  it("rejects invalid source metadata and verifies actual bytes against a forged metadata digest", async () => {
    const input = await source();
    const original = await env.MAIL_ARCHIVE.get(input.key);
    expect(original).not.toBeNull();
    const wrong = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode("different synthetic bytes"),
    );
    const get = env.MAIL_ARCHIVE.get.bind(env.MAIL_ARCHIVE);
    vi.spyOn(env.MAIL_ARCHIVE, "get").mockImplementationOnce(async (key) => {
      const object = await get(key);
      if (!object) return null;
      return new Proxy(object, {
        get(target, property) {
          if (property === "customMetadata")
            return { ...object.customMetadata, sha256: hex(wrong) };
          if (property === "checksums") return { ...object.checksums, sha256: wrong };
          return Reflect.get(target, property, target);
        },
      });
    });
    expect(await process(input)).toMatchObject({ status: "blocked", code: "source_changed" });
    const invalid = await source();
    await env.MAIL_ARCHIVE.put(invalid.key, invalid.bytes);
    expect(await process(invalid)).toMatchObject({
      status: "blocked",
      code: "invalid_source_metadata",
    });
    await original!.body.cancel();
  });

  it("never replaces the recorded original digest after the source changes", async () => {
    const input = await source();
    await process(input);
    const before = await row(input.key);
    const content = encoder.encode("Subject: Changed synthetic\r\n\r\nChanged body");
    const digest = await crypto.subtle.digest("SHA-256", content);
    const previous = await env.MAIL_ARCHIVE.head(input.key);
    await env.MAIL_ARCHIVE.put(input.key, content, {
      sha256: digest,
      customMetadata: { ...previous!.customMetadata, sha256: hex(digest) },
    });
    expect(await process(input)).toMatchObject({ status: "blocked", code: "source_changed" });
    expect(await row(input.key)).toMatchObject({
      status: "blocked",
      raw_sha256: input.sha256,
      manifest_key: before?.manifest_key,
    });
  });

  it("fences both inactive startup and superseded completion attempts", async () => {
    const input = await source();
    expect(await process({ ...input, instanceId: "old-synthetic-attempt" })).toMatchObject({
      status: "blocked",
      code: "attempt_inactive",
    });
    expect(await row(input.key)).toBeNull();
    const head = env.MAIL_ARCHIVE.head.bind(env.MAIL_ARCHIVE);
    vi.spyOn(env.MAIL_ARCHIVE, "head").mockImplementation(async (key) => {
      if (key === input.key) {
        await env.MAIL_CATALOG.prepare(
          "UPDATE processing_jobs SET instance_id = ?, state = 'pending' WHERE raw_key = ?",
        )
          .bind("next-synthetic-attempt", input.key)
          .run();
      }
      return head(key);
    });
    expect(await process(input)).toMatchObject({ status: "blocked", code: "attempt_inactive" });
    expect(await row(input.key)).toBeNull();
  });

  it("writes the manifest last and recovers after a partial R2 failure", async () => {
    const input = await source(
      mixed([
        "Content-Type: text/plain\r\n\r\nBody",
        "Content-Type: application/zip\r\nContent-Disposition: attachment; filename=synthetic.zip\r\n\r\nOpaque synthetic ZIP bytes",
      ]),
    );
    const put = env.MAIL_ARCHIVE.put.bind(env.MAIL_ARCHIVE);
    const writes: string[] = [];
    const spy = vi
      .spyOn(env.MAIL_ARCHIVE, "put")
      .mockImplementation(async (key, value, options) => {
        writes.push(key);
        if (key.includes("/attachment/")) throw new Error("synthetic secret in service error");
        return put(key, value, options);
      });
    await expect(process(input)).rejects.toThrow(/^MIME extraction unavailable$/);
    expect(await row(input.key)).toBeNull();
    expect(writes.some((key) => key.includes("/manifest/"))).toBe(false);
    spy.mockImplementation(async (key, value, options) => {
      writes.push(key);
      return put(key, value, options);
    });
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 1 });
    expect(writes.at(-1)).toContain("/manifest/");
  });

  it("retries safely when D1 fails after the manifest was saved", async () => {
    const input = await source();
    const prepare = env.MAIL_CATALOG.prepare.bind(env.MAIL_CATALOG);
    // Sessions use the same binding, but intercepting withSession preserves native D1 execution.
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const sessionPrepare = session.prepare.bind(session);
    vi.spyOn(env.MAIL_CATALOG, "withSession").mockReturnValue(session);
    const failure = vi.spyOn(session, "prepare").mockImplementation((sql) => {
      if (sql.includes("INSERT INTO mail_extractions"))
        throw new Error("synthetic service details");
      return sessionPrepare(sql);
    });
    await expect(process(input)).rejects.toThrow(/^MIME extraction unavailable$/);
    expect(await prepare("SELECT COUNT(*) AS count FROM mail_extractions").first("count")).toBe(0);
    expect(
      (await env.MAIL_ARCHIVE.list()).objects.some((object) => object.key.includes("/manifest/")),
    ).toBe(true);
    failure.mockRestore();
    expect(await process(input)).toEqual({ status: "complete", attachmentCount: 0 });
  });

  it.each([
    ["header size", () => `Subject: ${"s".repeat(MIME_LIMITS.headersBytes)}\r\n\r\nBody`],
    ["header allocation", () => `${"X: y\r\n".repeat(1100)}\r\nBody`],
    [
      "part count",
      () =>
        mixed(
          Array.from(
            { length: MIME_LIMITS.partCount },
            () => "Content-Type: text/plain\r\n\r\nBody",
          ),
        ),
    ],
    [
      "nesting",
      () => {
        let body = "Content-Type: text/plain\r\n\r\nBody";
        for (let index = 0; index < MIME_LIMITS.nestingDepth + 2; index++)
          body = `Content-Type: multipart/mixed; boundary=n${index}\r\n\r\n--n${index}\r\n${body}\r\n--n${index}--\r\n`;
        return body;
      },
    ],
  ])("enforces the parser %s limit", async (_, fixture) => {
    const input = await source(fixture());
    expect(await process(input)).toEqual({
      status: "blocked",
      attachmentCount: 0,
      code: "parser_limit",
    });
    expect(await row(input.key)).toMatchObject({ failure_code: "parser_limit" });
  });

  it("bounds attachment count and decoded charset expansion", async () => {
    const many = await source(
      mixed(
        Array.from(
          { length: MIME_LIMITS.attachmentCount + 1 },
          () => "Content-Type: application/octet-stream\r\n\r\nSynthetic",
        ),
      ),
    );
    expect(await process(many)).toMatchObject({ status: "blocked", code: "decoded_limit" });
    const header = encoder.encode(
      "Subject: Synthetic expansion\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n",
    );
    const bytes = new Uint8Array(3 * 1024 * 1024);
    bytes.fill(255);
    bytes.set(header);
    const expansion = await source(bytes);
    expect(await process(expansion)).toMatchObject({ status: "blocked", code: "decoded_limit" });
  });

  it("bounds JSON escape expansion before allocating or saving derivatives", async () => {
    const input = await source(
      `Subject: Synthetic JSON expansion\r\n\r\n${"\u0001".repeat(1_500_000)}`,
    );
    expect(await process(input)).toMatchObject({ status: "blocked", code: "decoded_limit" });
    expect((await env.MAIL_ARCHIVE.list()).objects).toHaveLength(1);
  });

  it("rejects oversized selected metadata without saving body derivatives", async () => {
    const input = await source(`Subject: ${"s".repeat(MIME_LIMITS.fieldBytes + 1)}\r\n\r\nBody`);
    expect(await process(input)).toMatchObject({ status: "blocked", code: "metadata_limit" });
    expect((await env.MAIL_ARCHIVE.list()).objects).toHaveLength(1);
  });

  it("blocks a conflicting derivative instead of overwriting its bytes", async () => {
    const input = await source();
    await process(input);
    const stored = await row(input.key);
    await env.MAIL_ARCHIVE.put(stored!.body_json_key!, "Different synthetic derivative");
    expect(await process(input)).toMatchObject({ status: "blocked", code: "derivative_conflict" });
    expect(await (await env.MAIL_ARCHIVE.get(stored!.body_json_key!))!.text()).toBe(
      "Different synthetic derivative",
    );
  });
});
