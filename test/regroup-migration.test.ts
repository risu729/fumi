import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { repairMailIdentity } from "../src/mail-identity.ts";

beforeAll(async () => {
  await applyD1Migrations(
    env.MAIL_CATALOG,
    env.TEST_MIGRATIONS.filter((m) => m.name < "0028"),
  );
});

const encoder = new TextEncoder();
const BH = "2jmj7l5rSw0yVb/vlWAYkK/YBwkAAAAAAAAAAAAAAAA=";
const BH_OTHER = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
let sequence = 0;
async function store(
  kind: "email_routing" | "gmail" | "mailbox_export",
  options: { messageId: string; signed?: boolean; bh?: string; date?: string },
) {
  sequence++;
  const id = `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  const key = `synthetic/${id}/raw.eml`;
  const bytes = encoder.encode(
    [
      ...(options.signed
        ? [
            `DKIM-Signature: v=1; a=rsa-sha256; d=example.invalid; s=s; bh=${options.bh ?? BH}; b=AAAA`,
          ]
        : []),
      "From: Synthetic Sender <sender@example.invalid>",
      "To: owner@example.invalid",
      "Subject: Synthetic",
      `Date: ${options.date ?? "Sat, 07 Nov 2026 06:01:24 +0000"}`,
      `Message-ID: <${options.messageId}@example.invalid>`,
      "",
      "Synthetic body",
    ].join("\r\n"),
  );
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await env.MAIL_ARCHIVE.put(key, bytes, { sha256: digest, customMetadata: { sha256: digest } });
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision) VALUES (?,?,?,?,?,'2026-11-07T06:01:30.000Z','present','missing',?,?,0,0)`,
  )
    .bind(
      kind,
      kind === "email_routing" ? "ingress-v1" : "synthetic-account",
      id,
      key,
      `${key}.receipt`,
      bytes.byteLength,
      digest,
    )
    .run();
  return key;
}
const groupOf = async (key: string) =>
  env.MAIL_CATALOG.prepare("SELECT group_id FROM mail_identity WHERE raw_key=?")
    .bind(key)
    .first<string>("group_id");

describe("regroup migration for unsigned Gmail copies", () => {
  it("deletes only unsigned Gmail rows the earlier rule left alone, and the backfill groups them", async () => {
    const signed = await store("gmail", { messageId: "a", signed: true });
    const sent = await store("gmail", { messageId: "a" });
    // Kept: another Date, a mailbox export, and an unsigned Gmail row already in a group.
    const otherDate = await store("gmail", {
      messageId: "a",
      date: "Sat, 07 Nov 2026 07:00:00 +0000",
    });
    const signedB = await store("gmail", { messageId: "b", signed: true });
    const exported = await store("mailbox_export", { messageId: "b" });
    const live = await store("email_routing", { messageId: "c" });
    const forwarded = await store("gmail", { messageId: "c" });
    await store("gmail", { messageId: "c", signed: true });
    // Kept: two signed groups of the Message-ID (a conflict), which the rule does not join.
    const conflicted = await store("gmail", { messageId: "d" });
    const signedD = await store("gmail", { messageId: "d", signed: true });
    await store("email_routing", { messageId: "d", signed: true, bh: BH_OTHER });
    const now = new Date("2026-11-28T13:00:00.000Z");
    // Scheduled runs until the scan is closed, so its next full pass is an hour away.
    expect(await repairMailIdentity(env, 200, now, true)).toMatchObject({
      indexed: 11,
      blocked: 0,
    });
    expect(await repairMailIdentity(env, 200, now, true)).toMatchObject({ indexed: 0 });
    // The state the earlier rule left: each unsigned non-export row in a group of its own.
    for (const key of [sent, exported, conflicted])
      // oxlint-disable-next-line no-await-in-loop -- Each row gets its own group.
      await env.MAIL_CATALOG.prepare("UPDATE mail_identity SET group_id=? WHERE raw_key=?")
        .bind(key.padEnd(64, "0").slice(0, 64), key)
        .run();
    expect(await groupOf(sent)).not.toBe(await groupOf(signed));
    const before = (
      await env.MAIL_CATALOG.prepare("SELECT * FROM mail_identity ORDER BY raw_key").all()
    ).results;

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0028_"));
    if (!migration) throw new Error("Regroup migration fixture missing");
    await applyD1Migrations(env.MAIL_CATALOG, [migration]);
    const after = (
      await env.MAIL_CATALOG.prepare("SELECT * FROM mail_identity ORDER BY raw_key").all()
    ).results;
    expect(after).toEqual(before.filter((row) => row["raw_key"] !== sent));

    // The migration requests a full pass, so the next scheduled run indexes the row again.
    expect(await repairMailIdentity(env, 200, now, true)).toMatchObject({
      indexed: 1,
      blocked: 0,
    });
    expect(await groupOf(sent)).toBe(await groupOf(signed));
    expect(await groupOf(conflicted)).not.toBe(await groupOf(signedD));
    expect(await groupOf(otherDate)).not.toBe(await groupOf(signed));
    expect(await groupOf(exported)).not.toBe(await groupOf(signedB));
    expect(await groupOf(forwarded)).toBe(await groupOf(live));
  });
});
