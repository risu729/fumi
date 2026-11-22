import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { isGmailRelay, RELAY_LOOKUP_TIMEOUT_MS, relayedCopyOf } from "../src/gmail-relay.ts";
import { getMailHealth } from "../src/mail-health.ts";
import { readMail, searchMail } from "../src/mail-read.ts";
import { indexArchiveSource } from "../src/reconcile.ts";
import { canonicalReceipt, parseReceipt } from "../src/receipt-schema.ts";
import type { MailPrincipal } from "../src/principal.ts";
import type { Receipt } from "../src/index.ts";

// FORWARD_TO is synthetic-forward@gmail.com in vitest.config.ts.
const RELAY_FROM = "synthetic-forward+caf_=relay=example.invalid@gmail.com";
const reader: MailPrincipal = { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] };

function mime(messageId: string, extraHeaders: string[] = []) {
  return new TextEncoder().encode(
    [
      ...extraHeaders,
      "From: Sender <sender@example.invalid>",
      "To: owner@gmail.example.invalid",
      `Message-ID: <${messageId}>`,
      "Subject: Synthetic relay",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Synthetic body",
      "",
    ].join("\r\n"),
  );
}

/** What Gmail forwards back: its own and Cloudflare's headers on top of the original. */
function relayed(original: Uint8Array, ingestIds: string[]) {
  const prefix = new TextEncoder().encode(
    [
      "Received: from mail.example.invalid by mx.example.invalid",
      ...ingestIds.map((id) => `X-Fumi-Ingest-ID: ${id}`),
      "",
    ].join("\r\n"),
  );
  const bytes = new Uint8Array(prefix.byteLength + original.byteLength);
  bytes.set(prefix);
  bytes.set(original, prefix.byteLength);
  return bytes;
}

function message(bytes: Uint8Array, from = RELAY_FROM, to = "relay@example.invalid") {
  const forward = vi
    .fn<ForwardableEmailMessage["forward"]>()
    .mockResolvedValue({ messageId: "synthetic-forward-id" });
  return {
    from,
    to,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice());
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
    headers: new Headers(),
    canBeForwarded: true,
    forward,
    setReject: vi.fn(),
    async reply(): Promise<EmailSendResult> {
      throw new Error("Reply must never be used by ingress");
    },
  } satisfies ForwardableEmailMessage;
}

const bindings: Env = {
  ...env,
  // Indexing is checked explicitly; no background Workflow races these assertions.
  MAIL_PROCESSING: {
    create: async () => ({ id: "synthetic" }),
    get: async () => {
      throw new Error("synthetic");
    },
  } as unknown as Env["MAIL_PROCESSING"],
};

async function run(incoming: ForwardableEmailMessage, environment = bindings) {
  const ctx = createExecutionContext();
  try {
    await worker.email(incoming, environment, ctx);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

async function receipts(): Promise<Receipt[]> {
  const listed = (await env.MAIL_ARCHIVE.list({ prefix: "ingest/" })).objects;
  return Promise.all(
    listed
      .filter((object) => object.key.endsWith("/receipt.json"))
      .map(async ({ key }) => (await env.MAIL_ARCHIVE.get(key))!.json<Receipt>()),
  );
}

async function relayRows() {
  return (
    await env.MAIL_CATALOG.prepare(
      "SELECT ingest_id,outcome,original_raw_key FROM gmail_relay_deliveries ORDER BY rowid",
    ).all<{ ingest_id: string; outcome: string; original_raw_key: string | null }>()
  ).results;
}

const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** A live original as ingress writes it, without going through the email handler. */
async function putOriginal(ingestId: string, bytes: Uint8Array, day = today(), extra = {}) {
  const key = `ingest/${day}/${ingestId}/raw.eml`;
  await env.MAIL_ARCHIVE.put(key, bytes, {
    customMetadata: { schemaVersion: "1", ingestId, eventNotifications: "1", ...extra },
  });
  return key;
}

async function catalogOriginal(ingestId: string, rawKey: string, messageId?: string | null) {
  await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,
    receipt_key,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision)
    VALUES ('email_routing','ingress-v1',?,?,?,'present','missing',?,0,0)`)
    .bind(ingestId, rawKey, rawKey.replace("raw.eml", "receipt.json"), "c".repeat(64))
    .run();
  if (messageId !== undefined)
    await env.MAIL_CATALOG.prepare(`INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,message_id,
      group_id,group_rule,indexed_at) VALUES (?,'identity-v1',?,'complete',?,?,'single','2026-11-23T00:00:00.000Z')`)
      .bind(rawKey, "c".repeat(64), messageId, `group-${ingestId}`)
      .run();
}

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
  await env.MAIL_CATALOG.batch(
    ["gmail_relay_deliveries", "mail_identity", "processing_jobs", "archive_sources"].map((table) =>
      env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`),
    ),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Gmail relay recognition", () => {
  it.each([
    [RELAY_FROM, "synthetic-forward@gmail.com", true],
    // The exact form Gmail uses, written out in full against the pattern's literal.
    ["owner+caf_=fumi-relay=mail.example.invalid@gmail.com", "owner@gmail.com", true],
    // Gmail ignores dots and plus tags in its own addresses.
    ["syntheticforward+caf_=relay=example.invalid@gmail.com", "synthetic.forward@gmail.com", true],
    [RELAY_FROM, "Synthetic-Forward+fumi@googlemail.com", true],
    ["SYNTHETIC-FORWARD+caf_=relay=example.invalid@GMAIL.COM", "synthetic-forward@gmail.com", true],
    // Another account's forwarding, a plain sender and malformed forms are live mail.
    ["someone-else+caf_=relay=example.invalid@gmail.com", "synthetic-forward@gmail.com", false],
    ["synthetic-forward@gmail.com", "synthetic-forward@gmail.com", false],
    ["synthetic-forward+caf_=relay@gmail.com", "synthetic-forward@gmail.com", false],
    [
      "synthetic-forward+caf_=relay=example.invalid@example.invalid",
      "synthetic-forward@gmail.com",
      false,
    ],
    [RELAY_FROM, "synthetic-forward@example.invalid", false],
    [RELAY_FROM, undefined, false],
  ])("treats %s for FORWARD_TO %s as a relay: %s", (from, forwardTo, expected) => {
    expect(isGmailRelay(from, forwardTo)).toBe(expected);
  });

  it("keeps the gmail_relay reason in receipt v4 and its canonical snapshot", () => {
    const receipt = {
      schemaVersion: 4,
      ingestId: "00000000-0000-4000-8000-000000000001",
      receivedAt: "2026-11-23T00:00:00.000Z",
      envelope: { from: RELAY_FROM, to: "relay@example.invalid" },
      reportedRawSize: 1,
      archive: { status: "stored", key: "ingest/x/raw.eml", size: 1, sha256: "a".repeat(64) },
      forward: { status: "skipped", reason: "gmail_relay" },
    } as const;
    expect(parseReceipt(receipt)).toEqual(receipt);
    expect(JSON.parse(canonicalReceipt(parseReceipt(receipt)!))).toEqual(receipt);
    expect(
      parseReceipt({ ...receipt, forward: { status: "skipped", reason: "archive_only" } }),
    ).toBe(null);
    expect(parseReceipt({ ...receipt, schemaVersion: 2, forward: receipt.forward })).toBe(null);
  });
});

describe("Gmail relay ingress in workerd", () => {
  it("archives mail sent straight to Gmail as live mail without forwarding it back", async () => {
    const incoming = message(mime("direct@example.invalid"));
    await run(incoming);
    expect(incoming.forward).not.toHaveBeenCalled();
    expect(incoming.setReject).not.toHaveBeenCalled();
    const [receipt] = await receipts();
    expect(receipt).toMatchObject({
      schemaVersion: 4,
      envelope: { from: RELAY_FROM, to: "relay@example.invalid" },
      archive: { status: "stored" },
      forward: { status: "skipped", reason: "gmail_relay" },
    });
    expect(parseReceipt(receipt)).toEqual(receipt);
    if (receipt?.archive.status !== "stored") throw new Error("Missing synthetic raw");
    const raw = await env.MAIL_ARCHIVE.head(receipt.archive.key);
    expect(raw?.customMetadata).toMatchObject({
      via: "gmail_forwarding",
      eventNotifications: "1",
      ingestId: receipt.ingestId,
    });
    expect(await relayRows()).toEqual([
      { ingest_id: receipt.ingestId, outcome: "archived", original_raw_key: null },
    ]);

    const rawKey = receipt.archive.key;
    await vi.waitFor(() => indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, rawKey));
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT source_kind,forward_status,notify_events,raw_state FROM archive_sources WHERE external_id=?",
      )
        .bind(receipt.ingestId)
        .first(),
    ).toEqual({
      source_kind: "email_routing",
      forward_status: "skipped",
      notify_events: 1,
      raw_state: "present",
    });
    const read = await readMail(env, reader, `mail_${receipt.ingestId}`, "minimal");
    expect(read.provenance).toEqual({
      source_kind: "email_routing",
      source_namespace: "ingress-v1",
      via: "gmail_forwarding",
    });
    const search = await searchMail(env, reader, {});
    expect(search.emails.map((email) => email.provenance)).toEqual([read.provenance]);

    const health = await getMailHealth(env, reader);
    expect(health.sections.gmail_relay).toMatchObject({
      status: "observed",
      counts: { received: 1, archived: 1, archive_failed: 0, duplicate_of_live: 0 },
    });
    expect(health.sections.catalog).toMatchObject({
      counts: { receipt_gmail_relay: 1, receipt_forward_skipped: 1, ingress_snapshot_unknown: 0 },
    });
  });

  it("releases events for a stored relay in archive-only mode too", async () => {
    const incoming = message(mime("standalone@example.invalid"));
    await run(incoming, { ...bindings, INGRESS_MODE: "archive-only" });
    expect(incoming.setReject).not.toHaveBeenCalled();
    const [receipt] = await receipts();
    expect(receipt).toMatchObject({ schemaVersion: 4, archive: { status: "stored" } });
    if (receipt?.archive.status !== "stored") throw new Error("Missing synthetic raw");
    const rawKey = receipt.archive.key;
    expect((await env.MAIL_ARCHIVE.head(rawKey))?.customMetadata).toMatchObject({
      ingressMode: "archive-only",
      eventNotifications: "0",
      via: "gmail_forwarding",
    });
    await vi.waitFor(() => indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, rawKey));
    expect(
      await env.MAIL_CATALOG.prepare("SELECT notify_events FROM archive_sources WHERE raw_key=?")
        .bind(rawKey)
        .first(),
    ).toEqual({ notify_events: 1 });
  });

  it("drops the relayed copy of mail fumi forwarded to Gmail: a full round trip", async () => {
    const original = mime("round-trip@example.invalid");
    const live = message(original, "sender@example.invalid", "owner@example.invalid");
    await run(live);
    expect(live.forward).toHaveBeenCalledOnce();
    const ingestId = live.forward.mock.calls[0]![1]!.get("X-Fumi-Ingest-ID")!;
    const before = (await env.MAIL_ARCHIVE.list()).objects.map((object) => object.key).sort();

    const copy = message(relayed(original, [ingestId]));
    await run(copy);
    expect(copy.forward).not.toHaveBeenCalled();
    expect(copy.setReject).not.toHaveBeenCalled();
    expect((await env.MAIL_ARCHIVE.list()).objects.map((object) => object.key).sort()).toEqual(
      before,
    );
    const rows = await relayRows();
    expect(rows).toEqual([
      {
        ingest_id: expect.not.stringMatching(ingestId),
        outcome: "duplicate_of_live",
        original_raw_key: expect.stringMatching(new RegExp(`/${ingestId}/raw\\.eml$`)),
      },
    ]);
    const health = await getMailHealth(env, reader);
    expect(health.sections.gmail_relay).toMatchObject({
      counts: { received: 1, archived: 0, duplicate_of_live: 1 },
    });
  });

  it("checks a cataloged original by its identity row without reading R2", async () => {
    const ingestId = crypto.randomUUID();
    const rawKey = `ingest/2026-11-01/${ingestId}/raw.eml`;
    await catalogOriginal(ingestId, rawKey, "cataloged@example.invalid");
    const get = vi.spyOn(env.MAIL_ARCHIVE, "get");
    await run(message(relayed(mime("cataloged@example.invalid"), [ingestId])));
    expect(get).not.toHaveBeenCalled();
    expect(await relayRows()).toEqual([
      expect.objectContaining({ outcome: "duplicate_of_live", original_raw_key: rawKey }),
    ]);
  });

  it("reads a cataloged original's header when it has no identity row yet", async () => {
    const ingestId = crypto.randomUUID();
    const original = mime("pending@example.invalid");
    const rawKey = await putOriginal(ingestId, original, "2026-11-01");
    await catalogOriginal(ingestId, rawKey);
    await run(message(relayed(original, [ingestId])));
    expect(await relayRows()).toEqual([
      expect.objectContaining({ outcome: "duplicate_of_live", original_raw_key: rawKey }),
    ]);
  });

  it("finds an uncataloged original under the previous UTC date", async () => {
    const ingestId = crypto.randomUUID();
    const original = mime("midnight@example.invalid");
    const rawKey = await putOriginal(ingestId, original, yesterday());
    await run(message(relayed(original, [ingestId])));
    expect(await relayRows()).toEqual([
      expect.objectContaining({ outcome: "duplicate_of_live", original_raw_key: rawKey }),
    ]);
  });

  it("matches any X-Fumi-Ingest-ID value, ignoring malformed and unknown ones", async () => {
    const ingestId = crypto.randomUUID();
    const original = mime("several@example.invalid", ["X-Fumi-Ingest-ID: planted-by-sender"]);
    const rawKey = await putOriginal(ingestId, original);
    await run(message(relayed(original, [crypto.randomUUID(), ingestId.toUpperCase()])));
    expect(await relayRows()).toEqual([
      expect.objectContaining({ outcome: "duplicate_of_live", original_raw_key: rawKey }),
    ]);
  });

  it.each([
    ["another Message-ID", "other@example.invalid", {}],
    ["a Gmail import at the key", "same@example.invalid", { sourceKind: "gmail" }],
    ["another ingest ID in the metadata", "same@example.invalid", { ingestId: "other" }],
  ])("archives a copy whose named original has %s", async (_case, storedId, extra) => {
    const ingestId = crypto.randomUUID();
    await putOriginal(ingestId, mime(storedId), today(), extra);
    const copy = message(relayed(mime("same@example.invalid"), [ingestId]));
    await run(copy);
    expect(copy.forward).not.toHaveBeenCalled();
    expect((await receipts()).map((receipt) => receipt.schemaVersion)).toEqual([4]);
    expect(await relayRows()).toEqual([expect.objectContaining({ outcome: "archived" })]);
  });

  it("archives a copy whose cataloged original was recorded without that Message-ID", async () => {
    const ingestId = crypto.randomUUID();
    await catalogOriginal(ingestId, `ingest/2026-11-01/${ingestId}/raw.eml`, null);
    await run(message(relayed(mime("unsigned@example.invalid"), [ingestId])));
    expect(await relayRows()).toEqual([expect.objectContaining({ outcome: "archived" })]);
  });

  it("archives a copy naming an ingest fumi does not hold", async () => {
    await run(message(relayed(mime("unknown@example.invalid"), [crypto.randomUUID()])));
    expect(await relayRows()).toEqual([expect.objectContaining({ outcome: "archived" })]);
    expect(await receipts()).toHaveLength(1);
  });

  it("archives the copy when the duplicate check fails", async () => {
    const ingestId = crypto.randomUUID();
    const original = mime("outage@example.invalid");
    await putOriginal(ingestId, original);
    vi.spyOn(env.MAIL_ARCHIVE, "get").mockRejectedValueOnce(new Error("synthetic outage"));
    await run(message(relayed(original, [ingestId])));
    expect(await relayRows()).toEqual([expect.objectContaining({ outcome: "archived" })]);
    expect((await receipts())[0]?.archive.status).toBe("stored");
  });

  it("archives the copy when its duplicate record cannot be written", async () => {
    const ingestId = crypto.randomUUID();
    const original = mime("unrecorded@example.invalid");
    await putOriginal(ingestId, original);
    const prepare = env.MAIL_CATALOG.prepare.bind(env.MAIL_CATALOG);
    vi.spyOn(env.MAIL_CATALOG, "prepare").mockImplementation((sql) =>
      sql.includes("gmail_relay_deliveries")
        ? prepare("SELECT * FROM missing_table")
        : prepare(sql),
    );
    const copy = message(relayed(original, [ingestId]));
    await run(copy);
    expect(copy.forward).not.toHaveBeenCalled();
    expect((await receipts()).map((receipt) => receipt.forward)).toEqual([
      { status: "skipped", reason: "gmail_relay" },
    ]);
  });

  it("still forwards and archives live mail that carries an X-Fumi-Ingest-ID", async () => {
    const ingestId = crypto.randomUUID();
    const original = mime("live@example.invalid");
    await putOriginal(ingestId, original);
    const incoming = message(relayed(original, [ingestId]), "sender@example.invalid");
    await run(incoming);
    expect(incoming.forward).toHaveBeenCalledOnce();
    expect((await receipts()).map((receipt) => receipt.schemaVersion)).toEqual([1]);
    expect(await relayRows()).toEqual([]);
  });

  it("records a relayed delivery whose capture failed", async () => {
    const incoming = message(mime("short@example.invalid"));
    const short = { ...incoming, rawSize: incoming.rawSize + 1 };
    await expect(run(short)).rejects.toThrow("Relayed mail was not stored");
    expect(incoming.forward).not.toHaveBeenCalled();
    expect((await receipts())[0]).toMatchObject({
      schemaVersion: 4,
      archive: { status: "failed", code: "size_mismatch" },
    });
    expect(await relayRows()).toEqual([expect.objectContaining({ outcome: "archive_failed" })]);
  });

  it("archives the copy when the duplicate check outlasts its deadline", async () => {
    vi.useFakeTimers();
    const stalled = {
      prepare: () => ({ bind: () => ({ all: () => new Promise(() => undefined) }) }),
    };
    vi.spyOn(env.MAIL_CATALOG, "withSession").mockReturnValue(
      stalled as unknown as D1DatabaseSession,
    );
    const original = mime("stalled@example.invalid");
    const copy = message(relayed(original, [crypto.randomUUID()]));
    const completed = run(copy);
    await vi.advanceTimersByTimeAsync(RELAY_LOOKUP_TIMEOUT_MS + 1);
    await completed;
    vi.useRealTimers();
    expect(copy.forward).not.toHaveBeenCalled();
    expect((await receipts()).map((receipt) => receipt.forward)).toEqual([
      { status: "skipped", reason: "gmail_relay" },
    ]);
    expect(await relayRows()).toEqual([expect.objectContaining({ outcome: "archived" })]);
  });

  it("looks up nothing for a copy without a Message-ID", async () => {
    const ingestId = crypto.randomUUID();
    const bytes = new TextEncoder().encode(
      `X-Fumi-Ingest-ID: ${ingestId}\r\nSubject: none\r\n\r\nbody\r\n`,
    );
    await putOriginal(ingestId, bytes);
    const prepare = vi.spyOn(env.MAIL_CATALOG, "withSession");
    expect(await relayedCopyOf(env, bytes, new Date().toISOString())).toBe(null);
    expect(prepare).not.toHaveBeenCalled();
  });
});
