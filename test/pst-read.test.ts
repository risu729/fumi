import { env as runtimeEnv } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pstConfig, runPstChunk, startPstRun } from "../src/pst-import.ts";
import { repairMailIdentity } from "../src/mail-identity.ts";
import { readMail, readMailThread, searchMail } from "../src/mail-read.ts";
import type { MailPrincipal } from "../src/principal.ts";

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
const principal: MailPrincipal = {
  id: "synthetic-reader",
  scopes: ["mail:read"],
  fromAddresses: [],
};
const encoder = new TextEncoder();
const namespace = `outlook-${"0c".repeat(12)}`;
const prefix = `${namespace}/2026-11-28`;
const BH = "2jmj7l5rSw0yVb/vlWAYkK/YBwkAAAAAAAAAAAAAAAA=";
const hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

// Synthetic mail only. The signed message has one Gmail copy and one PST copy.
const mail = (id: string, signed: boolean, extra = "") =>
  encoder.encode(
    [
      ...(signed
        ? [`DKIM-Signature: v=1; a=rsa-sha256; d=example.invalid; s=x; bh=${BH}; b=AAAA`]
        : []),
      "From: Sender <sender@example.invalid>",
      "To: owner@example.invalid",
      `Subject: Synthetic ${id}`,
      "Date: Sat, 07 Nov 2026 06:01:24 +0000",
      `Message-ID: <${id}@example.invalid>`,
      extra,
      "",
      "Body",
    ].join("\r\n"),
  );

async function importPst(
  items: { bytes: Uint8Array; folder: string[]; deliveredAt: string; headers: string }[],
) {
  const lines: string[] = [];
  for (const [index, item] of items.entries()) {
    const key = `${prefix}/items/${String(index + 1).padStart(6, "0")}.eml`;
    // oxlint-disable-next-line no-await-in-loop -- Items are uploaded in order.
    await env.TAKEOUT_ARCHIVE.put(key, item.bytes);
    lines.push(
      `${JSON.stringify({
        line: index + 1,
        key,
        size: item.bytes.byteLength,
        // oxlint-disable-next-line no-await-in-loop -- See above.
        sha256: await hex(item.bytes),
        pstNodeId: 100 + index,
        folder: item.folder,
        itemKind: "note",
        deliveredAt: item.deliveredAt,
        headers: item.headers,
        exportSha256: "e".repeat(64),
        converter: "readpst 0.6.76 -j 0 -e -D; pypff 20180714",
      })}\n`,
    );
  }
  const text = lines.join("");
  await env.TAKEOUT_ARCHIVE.put(`${prefix}/manifest.jsonl`, text);
  const run = pstConfig({
    PST_IMPORT_CONFIG: JSON.stringify({
      runId: "read",
      accountNamespace: namespace,
      manifest: { key: `${prefix}/manifest.jsonl`, size: encoder.encode(text).byteLength },
    }),
  })!;
  await startPstRun(env.MAIL_CATALOG, run);
  expect(await runPstChunk(env, run)).toMatchObject({ status: "complete" });
}

async function gmailCopy(bytes: Uint8Array, receivedAt: string) {
  const id = "00000000-0000-4000-8000-0000000000aa";
  const key = `ingest/${receivedAt.slice(0, 10)}/${id}/raw.eml`;
  const digest = await hex(bytes);
  await env.MAIL_ARCHIVE.put(key, bytes, {
    sha256: digest,
    customMetadata: { schemaVersion: "1", ingestId: id, receivedAt, sha256: digest },
  });
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision) VALUES ('gmail','main',?,?,?,?,'present','valid',?,?,0,0)`,
  )
    .bind(id, key, `${key}.receipt`, receivedAt, bytes.byteLength, digest)
    .run();
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO gmail_messages (raw_key,account_namespace,message_id,thread_id,internal_date,label_ids_json,imported_at) VALUES (?,'main','g1','t1',?,'["INBOX"]',?)`,
  )
    .bind(key, receivedAt, receivedAt)
    .run();
  return `mail_${id}`;
}

/** Only archived results have provenance; these searches name an archive source. */
const archived = (emails: unknown[]) =>
  emails as {
    id: string;
    copies?: number;
    provenance: { source_kind: string } & Record<string, unknown>;
  }[];

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});

describe("reading PST originals", () => {
  it("ranks them after Gmail copies, keeps their folder in provenance and filters by kind", async () => {
    await importPst([
      {
        bytes: mail("shared", true, "Received: from university"),
        folder: ["受信トレイ"],
        deliveredAt: "2026-11-07T06:01:25.000Z",
        headers: "transport",
      },
      {
        bytes: mail("sent-only", false),
        folder: ["Sent Items"],
        deliveredAt: "2026-11-07T07:00:00.000Z",
        headers: "synthesized",
      },
    ]);
    // The Gmail copy was received after the PST delivery time, yet it represents the group.
    const gmail = await gmailCopy(
      mail("shared", true, "Received: from gmail"),
      "2026-11-07T06:01:40.000Z",
    );
    expect(await repairMailIdentity(env)).toMatchObject({ indexed: 3, blocked: 0 });

    const all = await searchMail(env, principal, { archive_source: "all" });
    expect(
      archived(all.emails).map((email) => [email.provenance.source_kind, email.copies]),
    ).toEqual([
      ["mailbox_export", 1],
      ["gmail", 2],
    ]);
    expect(all.emails[1]!.id).toBe(gmail);
    const sentOnly = archived(all.emails)[0]!;
    expect(sentOnly).toMatchObject({
      label_ids: [],
      received_at: "2026-11-07T07:00:00.000Z",
      provenance: {
        source_kind: "mailbox_export",
        source_namespace: namespace,
        folder: ["Sent Items"],
        item_kind: "note",
        headers: "synthesized",
        mime_rebuilt: true,
        smtp_envelope_available: false,
      },
    });

    const exported = await searchMail(env, principal, {
      archive_source: "mailbox_export",
      expand_copies: true,
    });
    expect(archived(exported.emails).map((email) => email.provenance.source_kind)).toEqual([
      "mailbox_export",
      "mailbox_export",
    ]);
    expect(archived(exported.emails)[1]!.provenance).toMatchObject({ folder: ["受信トレイ"] });
    // No labels: neither in:inbox nor in:sent nor a label filter selects them.
    for (const args of [{ query: "in:inbox" }, { query: "in:sent" }, { label_ids: ["INBOX"] }])
      expect(
        // oxlint-disable-next-line no-await-in-loop -- Three small searches in turn.
        archived((await searchMail(env, principal, { ...args, archive_source: "all" })).emails).map(
          (email) => email.provenance.source_kind,
        ),
      ).not.toContain("mailbox_export");

    // A thread read of a PST original stays within its mailbox export.
    const thread = await readMailThread(
      env,
      principal,
      { message_id: sentOnly.id },
      "https://fumi.invalid",
    );
    expect(thread.messages.map((message) => message.id)).toEqual([sentOnly.id]);
    expect(thread.threading).toBe("direct_message_id_header_links_only");
    expect((await readMail(env, principal, sentOnly.id, "metadata")).provenance).toMatchObject({
      folder: ["Sent Items"],
    });
  });
});
