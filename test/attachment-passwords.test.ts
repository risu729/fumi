import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAttachmentPasswords } from "../src/attachment-passwords.ts";

const attachmentSha256 = "a".repeat(64);
const rawSha256 = "b".repeat(64);
const input = { rawKey: "synthetic/password/target", attachmentSha256, limit: 8 as const };
async function insert(
  id: string,
  body: string,
  options: {
    namespace?: string;
    sender?: string;
    to?: string;
    subject?: string;
    references?: string;
    date?: string;
    filename?: string;
  } = {},
) {
  const bytes = new TextEncoder().encode(body);
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const key = `synthetic/password/body/${digest}`;
  await env.MAIL_ARCHIVE.put(key, bytes);
  const rawKey = `synthetic/password/${id}`;
  const metadata = {
    from: { address: options.sender ?? "sender@example.invalid" },
    to: [{ address: options.to ?? "recipient@example.invalid" }],
    subject: options.subject ?? "Invoice",
    messageId: `<${id}@example.invalid>`,
    references: options.references ?? null,
  };
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES('gmail',?,?,?,?,?,'present','missing',?,0,0)`,
  )
    .bind(
      options.namespace ?? "synthetic-account",
      id,
      rawKey,
      `${rawKey}/receipt`,
      options.date ?? "2026-11-11T12:00:00.000Z",
      rawSha256,
    )
    .run();
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,attachment_count,body_json_key,body_text_key,manifest_key,updated_at) VALUES(?,'mime-v1',?,1,?,'complete',?,?,1,'synthetic/body-json',?,?,0)`,
  )
    .bind(
      rawKey,
      rawSha256,
      id,
      JSON.stringify(metadata),
      JSON.stringify([{ sha256: attachmentSha256, filename: options.filename ?? "invoice.pdf" }]),
      key,
      `synthetic/manifest/${id}`,
    )
    .run();
  return { rawKey, key };
}
beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.MAIL_CATALOG.exec("DELETE FROM mail_extractions; DELETE FROM archive_sources;");
});
describe("ephemeral related-mail password hints", () => {
  it("keeps exact punctuation and a bounded alternative from the same mail or subject", async () => {
    await insert("target", "Password: first.");
    await insert("related", "パスワード：second-secret", { subject: "Re: Invoice" });
    expect(await resolveAttachmentPasswords(env, input)).toEqual([
      "first.",
      "first",
      "second-secret",
    ]);
  });
  it("does not cross sender, recipient or account even when references match", async () => {
    await insert("target", "No hint here");
    const references = "<target@example.invalid>";
    await insert("sender", "Password: wrong-sender", {
      sender: "other@example.invalid",
      references,
    });
    await insert("recipient", "Password: wrong-recipient", {
      to: "other@example.invalid",
      references,
    });
    await insert("account", "Password: wrong-account", { namespace: "other-account", references });
    expect(await resolveAttachmentPasswords(env, input)).toEqual([]);
  });
  it("requires exact attachment filename for unrelated subjects and respects date range", async () => {
    await insert("target", "No hint here");
    await insert("unrelated", "Password: unrelated", { subject: "Other topic" });
    await insert("filename", "invoice.pdf Password: matching-file", { subject: "File password" });
    await insert("old", "Password: ancient", { date: "2026-08-01T00:00:00.000Z" });
    expect(await resolveAttachmentPasswords(env, input)).toEqual(["matching-file"]);
  });
  it("bounds candidates and verified body reads", async () => {
    await insert("target", Array.from({ length: 20 }, (_, i) => `Password: value${i}`).join("\n"));
    const get = vi.spyOn(env.MAIL_ARCHIVE, "get");
    expect(await resolveAttachmentPasswords(env, input)).toHaveLength(8);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("rejects tampered bodies and missing canonical attachment", async () => {
    const row = await insert("target", "Password: original");
    await env.MAIL_ARCHIVE.put(row.key, "Password: tampered");
    expect(await resolveAttachmentPasswords(env, input)).toEqual([]);
    expect(
      await resolveAttachmentPasswords(env, { ...input, attachmentSha256: "c".repeat(64) }),
    ).toEqual([]);
  });
  it("ignores malformed metadata and attachment JSON", async () => {
    await insert("target", "No hint here");
    const bad = await insert("bad", "Password: bad-json");
    await env.MAIL_CATALOG.prepare("UPDATE mail_extractions SET metadata_json='{' WHERE raw_key=?")
      .bind(bad.rawKey)
      .run();
    expect(await resolveAttachmentPasswords(env, input)).toEqual([]);
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET attachments_json='{' WHERE raw_key=?",
    )
      .bind(input.rawKey)
      .run();
    expect(await resolveAttachmentPasswords(env, input)).toEqual([]);
  });
  it("discards hints when the target extraction changes during lookup", async () => {
    await insert("target", "Password: stale");
    const original = env.MAIL_ARCHIVE.get.bind(env.MAIL_ARCHIVE);
    vi.spyOn(env.MAIL_ARCHIVE, "get").mockImplementation(async (key: string) => {
      await env.MAIL_CATALOG.prepare(
        "UPDATE mail_extractions SET manifest_key='replaced' WHERE raw_key=?",
      )
        .bind(input.rawKey)
        .run();
      return original(key);
    });
    expect(await resolveAttachmentPasswords(env, input)).toEqual([]);
  });
});
