import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDENTITY_HEADER_BYTES,
  IDENTITY_VERSION,
  parseHeaderIdentity,
  repairMailIdentity,
} from "../src/mail-identity.ts";
import { getMailHealth } from "../src/mail-health.ts";
import { readMailThread, searchMail } from "../src/mail-read.ts";
import type { MailPrincipal } from "../src/principal.ts";

const principal: MailPrincipal = {
  id: "synthetic-reader",
  scopes: ["mail:read"],
  fromAddresses: [],
};
const encoder = new TextEncoder();
const BH_A = "2jmj7l5rSw0yVb/vlWAYkK/YBwkAAAAAAAAAAAAAAAA=";
const BH_B = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const BH_C = "frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=";

function mime(lines: string[], body = "Synthetic body\r\n") {
  return encoder.encode(`${lines.join("\r\n")}\r\n\r\n${body}`);
}
const signature = (bh: string) =>
  `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.invalid;\r\n\ts=synthetic; h=from:to:subject; bh=${bh.slice(0, 20)}\r\n\t${bh.slice(20)}; b=AAAA`;
function headers(options: {
  messageId?: string | null;
  bh?: string[];
  from?: string;
  date?: string;
  subject?: string;
  hop?: string;
}) {
  return [
    ...(options.hop ? [`Received: from ${options.hop} by mx.example.invalid`] : []),
    ...(options.bh ?? []).map(signature),
    `From: Synthetic Sender <${options.from ?? "Sender@Example.invalid"}>`,
    "To: owner@example.invalid, Other <other@example.invalid>",
    `Subject: ${options.subject ?? "Synthetic\r\n copy"}`,
    `Date: ${options.date ?? "Sat, 07 Nov 2026 06:01:24 +0000"}`,
    ...(options.messageId === null
      ? []
      : [`Message-ID: ${options.messageId ?? "<copy@example.invalid>"}`]),
  ];
}
async function sha256(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
let sequence = 0;
async function archive(
  kind: "email_routing" | "gmail",
  receivedAt: string,
  bytes: Uint8Array,
  options: { namespace?: string; subject?: string; messageId?: string; storedSha?: string } = {},
) {
  sequence++;
  const id = `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
  const key = `ingest/${receivedAt.slice(0, 10)}/${id}/raw.eml`;
  const digest = await sha256(bytes);
  await env.MAIL_ARCHIVE.put(key, bytes, {
    sha256: digest,
    customMetadata: { schemaVersion: "1", ingestId: id, receivedAt, sha256: digest },
  });
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision) VALUES (?,?,?,?,?,?,'present','missing',?,?,0,0)`,
  )
    .bind(
      kind,
      kind === "gmail" ? (options.namespace ?? "main") : "ingress-v1",
      id,
      key,
      `${key}.receipt`,
      receivedAt,
      bytes.byteLength,
      options.storedSha ?? digest,
    )
    .run();
  if (kind === "gmail")
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO gmail_messages (raw_key,account_namespace,message_id,thread_id,internal_date,label_ids_json,imported_at) VALUES (?,?,?,?,?,'["INBOX"]',?)`,
    )
      .bind(
        key,
        options.namespace ?? "main",
        `g${sequence}`,
        `t${sequence}`,
        receivedAt,
        receivedAt,
      )
      .run();
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at) VALUES (?,'mime-v1',?,?,?,'complete',?,'[]',?,?,0)`,
  )
    .bind(
      key,
      digest,
      bytes.byteLength,
      id,
      JSON.stringify({
        subject: options.subject ?? "Synthetic copy",
        messageId: options.messageId ?? "<copy@example.invalid>",
      }),
      `synthetic/body/${id}`,
      `synthetic/manifest/${id}`,
    )
    .run();
  await env.MAIL_ARCHIVE.put(`synthetic/body/${id}`, JSON.stringify({ text: "x", html: null }));
  return { id: `mail_${id}`, key };
}
async function identities() {
  return (
    await env.MAIL_CATALOG.prepare(
      "SELECT raw_key,status,failure_code,group_id,group_rule,message_id_conflict FROM mail_identity ORDER BY rowid",
    ).all<{
      raw_key: string;
      status: string;
      failure_code: string | null;
      group_id: string | null;
      group_rule: string | null;
      message_id_conflict: number;
    }>()
  ).results;
}
const groupOf = async (key: string) =>
  (await identities()).find((row) => row.raw_key === key)?.group_id;

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM mail_identity; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM archive_sources;",
  );
});

describe("header-only mail identity", () => {
  it("normalizes Message-ID, DKIM body hashes, addresses, subject and date", () => {
    expect(
      parseHeaderIdentity(
        mime([
          ...headers({ bh: [BH_B, BH_A, BH_A] }),
          "To: Third <THIRD@example.invalid>",
          "Received: (folded\r\n continuation)",
        ]),
      ),
    ).toEqual({
      messageId: "copy@example.invalid",
      bodyHashes: [BH_A, BH_B].sort(),
      from: "sender@example.invalid",
      to: ["other@example.invalid", "owner@example.invalid", "third@example.invalid"],
      subject: "Synthetic copy",
      date: "2026-11-07T06:01:24.000Z",
    });
    expect(
      parseHeaderIdentity(
        mime(headers({ messageId: "<CABC.1.SMTPIN_ADDED_MISSING@mx.google.com>", date: "soon" })),
      ),
    ).toMatchObject({ messageId: null, date: "soon" });
    expect(
      parseHeaderIdentity(mime(headers({ messageId: "<x.SMTPIN_ADDED_BROKEN@mx.google.com>" }))),
    ).toMatchObject({ messageId: null });
    // Headers only, without a blank line, is a whole message only when it is the whole read.
    const headersOnly = encoder.encode("Subject: headers only\r\nFrom: a@example.invalid");
    expect(parseHeaderIdentity(headersOnly)).toBe("invalid_header");
    expect(parseHeaderIdentity(headersOnly, true)).toMatchObject({
      subject: "headers only",
      from: "a@example.invalid",
    });
    expect(parseHeaderIdentity(encoder.encode("not a header\r\n\r\nbody"))).toBe("invalid_header");
    expect(parseHeaderIdentity(encoder.encode("Subject: no end\r\n"))).toBe("invalid_header");
    expect(
      parseHeaderIdentity(
        encoder
          .encode(`X-Long: ${"a".repeat(IDENTITY_HEADER_BYTES)}`)
          .subarray(0, IDENTITY_HEADER_BYTES),
      ),
    ).toBe("header_limit");
  });

  it("groups live capture with forwarded Gmail copies and keeps unrelated mail apart", async () => {
    const live = await archive(
      "email_routing",
      "2026-11-07T06:01:25.000Z",
      mime(headers({ bh: [BH_A], hop: "cloudflare" })),
    );
    // A forwarding hop that signs again adds a second body hash; one shared hash suffices.
    const gmail = await archive(
      "gmail",
      "2026-11-07T06:01:30.000Z",
      mime(headers({ bh: [BH_A, BH_B], hop: "gmail" })),
    );
    const conflict = await archive(
      "gmail",
      "2026-11-07T06:02:00.000Z",
      mime(headers({ bh: [BH_C], hop: "other" })),
    );
    const unsignedA = await archive(
      "gmail",
      "2026-11-07T07:00:00.000Z",
      mime(headers({ messageId: "<unsigned@example.invalid>" })),
    );
    const unsignedB = await archive(
      "email_routing",
      "2026-11-07T07:00:01.000Z",
      mime(headers({ messageId: "<unsigned@example.invalid>", hop: "relay" })),
    );
    const unsignedOtherDate = await archive(
      "gmail",
      "2026-11-07T07:00:02.000Z",
      mime(
        headers({
          messageId: "<unsigned@example.invalid>",
          date: "Sat, 07 Nov 2026 07:00:00 +0000",
        }),
      ),
    );
    const noIdA = await archive(
      "email_routing",
      "2026-11-07T08:00:00.000Z",
      mime(headers({ messageId: null, bh: [BH_B] })),
    );
    const noIdB = await archive(
      "gmail",
      "2026-11-07T08:00:01.000Z",
      mime(headers({ messageId: null, bh: [BH_B], hop: "gmail" })),
    );
    const noIdOtherSubject = await archive(
      "gmail",
      "2026-11-07T08:00:02.000Z",
      mime(headers({ messageId: null, bh: [BH_B], subject: "Another" })),
    );
    // A copied Message-ID and body hash under another sender does not join the group.
    const otherSender = await archive(
      "email_routing",
      "2026-11-07T06:03:00.000Z",
      mime(headers({ bh: [BH_A], from: "intruder@example.invalid" })),
    );
    const bare = await archive("gmail", "2026-11-07T09:00:00.000Z", mime(["Subject: bare"]));
    const bareTwin = await archive("gmail", "2026-11-07T09:00:01.000Z", mime(["Subject: bare"]));

    expect(await repairMailIdentity(env, 4)).toEqual({
      indexed: 4,
      blocked: 0,
      deferred: 0,
      more: true,
    });
    expect(await repairMailIdentity(env)).toEqual({
      indexed: 8,
      blocked: 0,
      deferred: 0,
      more: false,
    });
    expect(await repairMailIdentity(env)).toEqual({
      indexed: 0,
      blocked: 0,
      deferred: 0,
      more: false,
    });

    expect(await groupOf(gmail.key)).toBe(await groupOf(live.key));
    expect(await groupOf(conflict.key)).not.toBe(await groupOf(live.key));
    expect(await groupOf(otherSender.key)).not.toBe(await groupOf(live.key));
    const rows = await identities();
    // Newest originals are indexed first; a row records a conflict with any earlier signed
    // row of its Message-ID that shares no body hash.
    expect(rows.find((row) => row.raw_key === otherSender.key)).toMatchObject({
      message_id_conflict: 0,
    });
    expect(rows.find((row) => row.raw_key === conflict.key)).toMatchObject({
      group_rule: "message_id_dkim",
      message_id_conflict: 1,
    });
    expect(rows.find((row) => row.raw_key === gmail.key)).toMatchObject({ message_id_conflict: 1 });
    expect(rows.find((row) => row.raw_key === unsignedA.key)).toMatchObject({
      group_rule: "message_id_from_date",
      message_id_conflict: 0,
    });
    expect(await groupOf(unsignedB.key)).toBe(await groupOf(unsignedA.key));
    expect(await groupOf(unsignedOtherDate.key)).not.toBe(await groupOf(unsignedA.key));
    expect(await groupOf(noIdB.key)).toBe(await groupOf(noIdA.key));
    expect(await groupOf(noIdOtherSubject.key)).not.toBe(await groupOf(noIdA.key));
    expect(await groupOf(bareTwin.key)).not.toBe(await groupOf(bare.key));
    expect(rows.find((row) => row.raw_key === bare.key)).toMatchObject({ group_rule: "single" });
    expect(new Set(rows.map((row) => row.group_id)).size).toBe(9);
    const health = await getMailHealth(env, principal);
    expect(health.sections.copy_grouping).toMatchObject({
      status: "observed",
      counts: {
        indexed: 12,
        blocked: 0,
        pending: 0,
        unknown: 0,
        message_id_conflicts: 3,
        in_multi_copy_groups: 6,
      },
    });
  });

  it("ignores signatures the forwarding route added after capture", async () => {
    // An unsigned original: the live capture has no DKIM. fumi forwards it with
    // X-Fumi-Ingest-ID, and the forwarding route signs it before Gmail receives it.
    const unsigned = headers({ messageId: "<unsigned-forwarded@example.invalid>" });
    const live = await archive("email_routing", "2026-11-10T06:08:05.000Z", mime(unsigned));
    const gmail = await archive(
      "gmail",
      "2026-11-10T06:08:06.000Z",
      mime([
        "Received: from forwarder.example.invalid by gmail.example.invalid",
        signature(BH_A),
        signature(BH_B),
        "X-Forwarded-To: owner@example.invalid",
        "X-Fumi-Ingest-ID: 00000000-0000-4000-8000-00000000ffff",
        ...unsigned,
      ]),
    );
    // A signature below the ingest header belongs to the original and still counts.
    expect(
      parseHeaderIdentity(mime(["X-Fumi-Ingest-ID: x", ...headers({ bh: [BH_C] })])),
    ).toMatchObject({ bodyHashes: [BH_C] });
    // An original that already carried X-Fumi-Ingest-ID (a loop through fumi, or a
    // forged header): every copy counts only signatures below the bottom-most one.
    const original = [signature(BH_A), "X-Fumi-Ingest-ID: one", ...headers({ bh: [BH_C] })];
    expect(parseHeaderIdentity(mime(original))).toMatchObject({ bodyHashes: [BH_C] });
    expect(
      parseHeaderIdentity(mime([signature(BH_B), "X-Fumi-Ingest-ID: two", ...original])),
    ).toMatchObject({ bodyHashes: [BH_C] });
    // A row of the previous identity version is replaced by the backfill.
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO mail_identity(raw_key,identity_version,raw_sha256,status,group_id,group_rule,indexed_at)
      SELECT raw_key,'identity-v1',raw_sha256,'complete',?,'single','2026-11-11T00:00:00.000Z' FROM archive_sources WHERE raw_key=?`,
    )
      .bind("f".repeat(64), gmail.key)
      .run();
    expect(await repairMailIdentity(env)).toMatchObject({ indexed: 2, blocked: 0 });
    const rows = await identities();
    expect(rows).toHaveLength(2);
    expect(await groupOf(gmail.key)).toBe(await groupOf(live.key));
    expect(rows.find((row) => row.raw_key === gmail.key)).toMatchObject({
      group_rule: "message_id_from_date",
    });
    expect(
      (await searchMail(env, principal, {})).emails.map((mail) => [mail.id, mail.copies]),
    ).toEqual([[live.id, 2]]);
  });

  it("records originals it cannot read as blocked and never rewrites a row", async () => {
    const changed = await archive("email_routing", "2026-11-07T06:00:00.000Z", mime(headers({})), {
      storedSha: "0".repeat(64),
    });
    const missing = await archive("email_routing", "2026-11-07T06:00:01.000Z", mime(headers({})));
    await env.MAIL_ARCHIVE.delete(missing.key);
    const headerless = await archive(
      "email_routing",
      "2026-11-07T06:00:02.000Z",
      encoder.encode("no header"),
    );
    const headersOnly = await archive(
      "email_routing",
      "2026-11-07T06:00:03.000Z",
      encoder.encode("Subject: headers only\r\nFrom: a@example.invalid"),
    );
    const unreadable = await archive(
      "email_routing",
      "2026-11-07T06:00:04.000Z",
      mime(headers({})),
    );
    const get = env.MAIL_ARCHIVE.get.bind(env.MAIL_ARCHIVE);
    const spy = vi.spyOn(env.MAIL_ARCHIVE, "get").mockImplementation(async (key, options) => {
      if (key === unreadable.key) throw new Error("Synthetic R2 outage");
      return get(key, options as R2GetOptions);
    });
    try {
      // A failed read stays pending and does not hold back the other originals.
      expect(await repairMailIdentity(env)).toEqual({
        indexed: 1,
        blocked: 3,
        deferred: 1,
        more: false,
      });
    } finally {
      spy.mockRestore();
    }
    expect(await repairMailIdentity(env)).toEqual({
      indexed: 1,
      blocked: 0,
      deferred: 0,
      more: false,
    });
    expect((await identities()).find((row) => row.raw_key === headersOnly.key)).toMatchObject({
      status: "complete",
      group_rule: "single",
    });
    expect(
      (await identities()).map((row) => [row.raw_key, row.status, row.failure_code, row.group_id]),
    ).toEqual([
      [headersOnly.key, "complete", null, expect.any(String)],
      [headerless.key, "blocked", "invalid_header", null],
      [missing.key, "blocked", "source_missing", null],
      [changed.key, "blocked", "source_changed", null],
      [unreadable.key, "complete", null, expect.any(String)],
    ]);
  });

  it("reports in health only the identity rows that collapsed reads group", async () => {
    const copies = async (messageId: string, count: number) => {
      const originals = [];
      for (let index = 0; index < count; index++) {
        // oxlint-disable-next-line no-await-in-loop -- Archive order decides catalog rowids.
        const original = await archive(
          "gmail",
          `2026-11-07T06:02:0${index}.000Z`,
          mime(headers({ messageId, bh: [BH_A], hop: `hop-${index}` })),
          { namespace: `account-${index}` },
        );
        originals.push(original);
      }
      return originals;
    };
    await copies("<both-present@example.invalid>", 2);
    const absent = await copies("<one-present@example.invalid>", 3);
    const [replaced] = await copies("<replaced@example.invalid>", 2);
    const [leftover] = await copies("<leftover@example.invalid>", 2);
    expect(await repairMailIdentity(env)).toMatchObject({ indexed: 9, blocked: 0 });
    await archive("email_routing", "2026-11-07T06:03:00.000Z", mime(headers({})));
    // A scan that finds the object replaced records its new SHA-256; the row keeps the old
    // one, and the backfill selects only originals without a current-version row.
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_sha256=? WHERE raw_key=?")
      .bind("1".repeat(64), replaced!.key)
      .run();
    // A row an older identity version wrote. The counts must not rely on its group ID
    // differing from the current version's.
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_identity SET identity_version='identity-v1' WHERE raw_key=?",
    )
      .bind(leftover!.key)
      .run();
    const grouping = async () => (await getMailHealth(env, principal)).sections.copy_grouping;
    // Every original matches an unfiltered read, so the window and the read agree.
    const read = (await searchMail(env, principal, { expand_copies: true })).emails;
    expect(read).toHaveLength(10);
    expect(await grouping()).toMatchObject({
      status: "observed",
      window: { records: 10, truncated: false },
      counts: {
        indexed: read.filter((mail) => mail.group_id !== null).length,
        blocked: 0,
        pending: 2,
        unknown: 1,
        message_id_conflicts: 0,
        in_multi_copy_groups: read.filter((mail) => (mail.copies ?? 0) > 1).length,
      },
    });
    expect(await grouping()).toMatchObject({ counts: { indexed: 7, in_multi_copy_groups: 5 } });
    // Reads group only present originals, as for current extractions; health already does.
    await env.MAIL_CATALOG.prepare(
      "UPDATE archive_sources SET raw_state=CASE raw_key WHEN ? THEN 'missing' ELSE 'invalid' END WHERE raw_key IN (?,?)",
    )
      .bind(absent[0]!.key, absent[0]!.key, absent[1]!.key)
      .run();
    expect(await grouping()).toMatchObject({
      counts: { indexed: 5, pending: 2, unknown: 3, in_multi_copy_groups: 2 },
    });
  });

  it("reads each copy group in the health window at most once", async () => {
    // One group of 1,300 originals. Its 300 oldest rows lead the group index but no longer
    // describe a present original, so finding another member that counts passes them.
    const statements = [];
    for (let index = 0; index < 1300; index++) {
      const key = `ingest/2026-11-07/bulk-${index}/raw.eml`;
      const digest = index.toString(16).padStart(64, "0");
      statements.push(
        env.MAIL_CATALOG.prepare(
          `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_size,raw_sha256,observed_pass,observed_revision) VALUES ('gmail',?,?,?,?,'2026-11-07T06:02:00.000Z',?,'missing',1,?,0,0)`,
        ).bind(
          `account-${index}`,
          `bulk-${index}`,
          key,
          `${key}.receipt`,
          index < 300 ? "missing" : "present",
          digest,
        ),
        env.MAIL_CATALOG.prepare(
          `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,group_id,group_rule,indexed_at) VALUES (?,?,?,'complete','synthetic-group','message_id_dkim','2026-11-07T06:03:00.000Z')`,
        ).bind(key, IDENTITY_VERSION, digest),
      );
    }
    for (let start = 0; start < statements.length; start += 500)
      // oxlint-disable-next-line no-await-in-loop -- Bounded synthetic setup batches.
      await env.MAIL_CATALOG.batch(statements.slice(start, start + 500));
    const prepare = env.MAIL_CATALOG.prepare.bind(env.MAIL_CATALOG);
    let sql = "";
    const spy = vi.spyOn(env.MAIL_CATALOG, "prepare").mockImplementation((query) => {
      if (query.includes("in_multi_copy_groups")) sql = query;
      return prepare(query);
    });
    try {
      expect((await getMailHealth(env, principal)).sections.copy_grouping).toMatchObject({
        window: { records: 1000, truncated: true },
        counts: { indexed: 1000, pending: 0, unknown: 0, in_multi_copy_groups: 1000 },
      });
    } finally {
      spy.mockRestore();
    }
    const { meta } = await env.MAIL_CATALOG.prepare(sql).all();
    // Searching from each of the 1,000 originals passes the 300 rows every time (about
    // 600,000 rows); searching once for the group reads them once (about 10,000 rows with
    // the window itself).
    expect(meta.rows_read).toBeLessThan(20_000);
  });
});

describe("collapsed reads", () => {
  it("returns one representative per copy group and expands every original", async () => {
    const own = await archive(
      "gmail",
      "2026-11-07T06:01:20.000Z",
      mime(headers({ bh: [BH_A], hop: "own" })),
      { namespace: "forwarding-account" },
    );
    const live = await archive(
      "email_routing",
      "2026-11-07T06:01:25.000Z",
      mime(headers({ bh: [BH_A], hop: "cloudflare" })),
    );
    const main = await archive(
      "gmail",
      "2026-11-07T06:01:30.000Z",
      mime(headers({ bh: [BH_A], hop: "gmail" })),
    );
    const other = await archive(
      "gmail",
      "2026-11-08T00:00:00.000Z",
      mime(headers({ messageId: "<other@example.invalid>", bh: [BH_B] })),
      { messageId: "<other@example.invalid>" },
    );
    const before = await searchMail(env, principal, {});
    expect(before.emails.map((mail) => [mail.id, mail.copies])).toEqual([
      [other.id, 1],
      [main.id, 1],
      [live.id, 1],
      [own.id, 1],
    ]);
    await repairMailIdentity(env);

    const collapsed = await searchMail(env, principal, {});
    expect(collapsed.coverage).toMatchObject({ copies: "one_representative_per_copy_group" });
    expect(collapsed.emails.map((mail) => [mail.id, mail.copies])).toEqual([
      [other.id, 1],
      [live.id, 3],
    ]);
    const group = collapsed.emails[1]!.group_id;
    expect(group).toMatch(/^[a-f0-9]{64}$/);
    // Gmail copies only: the account that received it first represents the group.
    expect(
      (await searchMail(env, principal, { archive_source: "gmail" })).emails.map((mail) => [
        mail.id,
        mail.copies,
      ]),
    ).toEqual([
      [other.id, 1],
      [own.id, 2],
    ]);
    const expanded = await searchMail(env, principal, { expand_copies: true });
    expect(expanded.emails.map((mail) => [mail.id, mail.group_id, mail.copies])).toEqual([
      [other.id, expect.any(String), 1],
      [main.id, group, 3],
      [live.id, group, 3],
      [own.id, group, 3],
    ]);
    expect(expanded.coverage).toMatchObject({ copies: "every_original" });
  });

  it("paginates by representative over fixed archive and identity snapshots", async () => {
    const pairs = [];
    for (let index = 0; index < 3; index++) {
      const messageId = `<pair-${index}@example.invalid>`;
      // oxlint-disable-next-line no-await-in-loop -- Ordered synthetic rows.
      const live = await archive(
        "email_routing",
        `2026-11-0${7 + index}T00:00:00.000Z`,
        mime(headers({ messageId, bh: [BH_A] })),
        { messageId },
      );
      // oxlint-disable-next-line no-await-in-loop -- Ordered synthetic rows.
      const gmail = await archive(
        "gmail",
        `2026-11-0${7 + index}T00:00:05.000Z`,
        mime(headers({ messageId, bh: [BH_A], hop: "gmail" })),
        { messageId },
      );
      pairs.push({ live, gmail });
    }
    await repairMailIdentity(env);
    const first = await searchMail(env, principal, { max_results: 2 });
    expect(first.emails.map((mail) => mail.id)).toEqual([pairs[2]!.live.id, pairs[1]!.live.id]);
    // A later copy and its identity row stay outside this traversal.
    const late = await archive(
      "email_routing",
      "2026-11-07T00:00:01.000Z",
      mime(headers({ messageId: "<pair-0@example.invalid>", bh: [BH_A], hop: "late" })),
      { messageId: "<pair-0@example.invalid>" },
    );
    await repairMailIdentity(env);
    const second = await searchMail(env, principal, {
      max_results: 2,
      next_page_token: first.next_page_token!,
    });
    expect(second.emails.map((mail) => [mail.id, mail.copies])).toEqual([[pairs[0]!.live.id, 2]]);
    expect(second.next_page_token).toBeNull();
    await expect(
      searchMail(env, principal, {
        max_results: 2,
        expand_copies: true,
        next_page_token: first.next_page_token!,
      }),
    ).rejects.toMatchObject({ code: "page_query_mismatch" });
    expect(
      (await searchMail(env, principal, {})).emails.map((mail) => [mail.id, mail.copies]),
    ).toEqual([
      [pairs[2]!.live.id, 2],
      [pairs[1]!.live.id, 2],
      [pairs[0]!.live.id, 3],
    ]);
    expect(late.id).toMatch(/^mail_/);
  });

  it("keeps the copy groups of the first page for the whole traversal", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const messageId = `<snapshot-${index}@example.invalid>`;
      for (const [kind, second] of [
        ["email_routing", "00"],
        ["gmail", "05"],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- Ordered synthetic rows.
        const copy = await archive(
          kind,
          `2026-11-0${7 + index}T00:00:${second}.000Z`,
          mime(headers({ messageId, bh: [BH_A], hop: kind })),
          { messageId },
        );
        ids.push(copy.id);
      }
    }
    const pages = [await searchMail(env, principal, { max_results: 2 })];
    // Grouping completes during the traversal; its pages still list every original once.
    await repairMailIdentity(env);
    while (pages.at(-1)!.next_page_token)
      pages.push(
        // oxlint-disable-next-line no-await-in-loop -- Pages follow one another.
        await searchMail(env, principal, {
          max_results: 2,
          next_page_token: pages.at(-1)!.next_page_token!,
        }),
      );
    expect(pages.flatMap((page) => page.emails.map((mail) => [mail.id, mail.copies]))).toEqual(
      ids.toReversed().map((id) => [id, 1]),
    );
    expect(
      (await searchMail(env, principal, {})).emails.map((mail) => [mail.id, mail.copies]),
    ).toEqual([
      [ids[4], 2],
      [ids[2], 2],
      [ids[0], 2],
    ]);
  });

  it("collapses repeated live deliveries in a thread read", async () => {
    const first = await archive(
      "email_routing",
      "2026-11-07T00:00:00.000Z",
      mime(headers({ bh: [BH_A], hop: "alias-a" })),
    );
    const second = await archive(
      "email_routing",
      "2026-11-07T00:00:01.000Z",
      mime(headers({ bh: [BH_A], hop: "alias-b" })),
    );
    await repairMailIdentity(env);
    const thread = await readMailThread(
      env,
      principal,
      { message_id: second.id },
      "https://fumi.invalid",
    );
    // The message asked for represents its own group, even though another copy is earlier.
    expect(thread.messages.map((mail) => [mail.id, mail.copies])).toEqual([[second.id, 2]]);
    expect(thread.copies).toBe("one_representative_per_copy_group");
    expect(
      (
        await readMailThread(env, principal, { message_id: first.id }, "https://fumi.invalid")
      ).messages.map((mail) => mail.id),
    ).toEqual([first.id]);
    const expanded = await readMailThread(
      env,
      principal,
      { message_id: second.id, expand_copies: true },
      "https://fumi.invalid",
    );
    expect(expanded.messages.map((mail) => mail.id)).toEqual([first.id, second.id]);
  });
});
