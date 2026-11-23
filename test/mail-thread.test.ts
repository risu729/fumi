import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMailThread } from "../src/mail-read.ts";
import type { MailPrincipal } from "../src/principal.ts";

const principal: MailPrincipal = {
  id: "synthetic-reader",
  scopes: ["mail:read"],
  fromAddresses: [],
};
const BASE = "https://fumi.example.invalid";
const SHA = "a".repeat(64);
const STALE = "c".repeat(64);
const ACCOUNT = "synthetic-account";

interface Source {
  kind?: "email_routing" | "gmail";
  date?: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  /** The extraction's SHA-256; differs from the source's for a stale extraction. */
  extractedSha?: string;
  rawState?: "present" | "missing";
  /** Raw metadata_json text, replacing the generated metadata. */
  metadataJson?: string;
  thread?: string;
  account?: string;
  /** Skip the R2 body: unrelated rows are never read. */
  body?: boolean;
}
const key = (id: string) => `ingest/2026-11-11/${id}/raw.eml`;
function statements(id: string, source: Source = {}) {
  const kind = source.kind ?? "email_routing";
  const raw = key(id);
  const list = [
    env.MAIL_CATALOG.prepare(
      `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES (?,?,?,?,?,?,?,'missing',?,0,0)`,
    ).bind(
      kind,
      kind === "gmail" ? (source.account ?? ACCOUNT) : "ingress-v1",
      id,
      raw,
      `${raw}.receipt`,
      source.date ?? "2026-11-11T00:00:00.000Z",
      source.rawState ?? "present",
      SHA,
    ),
    env.MAIL_CATALOG.prepare(
      `INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at) VALUES (?,'mime-v1',?,1,?,'complete',?,'[]',?,?,0)`,
    ).bind(
      raw,
      source.extractedSha ?? SHA,
      id,
      source.metadataJson ??
        JSON.stringify({
          subject: "Synthetic thread",
          messageId: source.messageId === undefined ? `<${id}@example.invalid>` : source.messageId,
          inReplyTo: source.inReplyTo ?? null,
        }),
      `synthetic/body/${id}`,
      `synthetic/manifest/${id}`,
    ),
  ];
  if (kind === "gmail")
    list.push(
      env.MAIL_CATALOG.prepare(
        `INSERT INTO gmail_messages (raw_key,account_namespace,message_id,thread_id,internal_date,label_ids_json,imported_at) VALUES (?,?,?,?,'0','["INBOX"]','2026-11-11T00:00:00.000Z')`,
      ).bind(raw, source.account ?? ACCOUNT, `gmail-${id}`, source.thread ?? `thread-${id}`),
    );
  return list;
}
async function insert(id: string, source: Source = {}) {
  await env.MAIL_CATALOG.batch(statements(id, source));
  if (source.body ?? true)
    await env.MAIL_ARCHIVE.put(`synthetic/body/${id}`, JSON.stringify({ text: id, html: null }));
  return `mail_${id}`;
}
/** Unrelated archive rows that share no header link, thread or ID with any test thread. */
async function unrelated(count: number) {
  const list = [];
  for (let index = 0; index < count; index += 1)
    list.push(
      ...statements(`unrelated-${index}`, {
        kind: index % 2 ? "gmail" : "email_routing",
        inReplyTo: `<unrelated-parent-${index}@example.invalid>`,
        body: false,
      }),
    );
  for (let index = 0; index < list.length; index += 300)
    // oxlint-disable-next-line no-await-in-loop -- Keep each D1 batch bounded.
    await env.MAIL_CATALOG.batch(list.slice(index, index + 300));
}
async function group(groupId: string, ...ids: string[]) {
  await env.MAIL_CATALOG.batch(
    ids.map((id) =>
      env.MAIL_CATALOG.prepare(
        `INSERT INTO mail_identity (raw_key,identity_version,raw_sha256,status,group_id,group_rule,indexed_at) VALUES (?,'identity-v1',?,'complete',?,'message_id_dkim','2026-11-11T00:00:00.000Z')`,
      ).bind(key(id), SHA, groupId),
    ),
  );
}
const thread = (id: string, options: { max_messages?: number; expand_copies?: boolean } = {}) =>
  readMailThread(env, principal, { message_id: id, ...options }, BASE);
const ids = (result: Awaited<ReturnType<typeof thread>>) =>
  result.messages.map((message) => message.id);

interface Read {
  sql: string;
  values: unknown[];
  rows: number;
}
/** A catalog that records each statement and the rows D1 reports it read. */
function counted(log: Read[]): typeof env {
  const statement = (sql: string, target: D1PreparedStatement, values: unknown[]) => ({
    bind: (...next: unknown[]) => statement(sql, target.bind(...next), next),
    async all() {
      const result = await target.all();
      log.push({ sql, values, rows: result.meta.rows_read });
      return result;
    },
    async first() {
      return (await this.all()).results[0] ?? null;
    },
  });
  return {
    ...env,
    MAIL_ARCHIVE: env.MAIL_ARCHIVE,
    MAIL_CATALOG: {
      prepare: (sql: string) => statement(sql, env.MAIL_CATALOG.prepare(sql), []),
    } as unknown as D1Database,
  };
}
async function plan(read: Read) {
  return (
    await env.MAIL_CATALOG.prepare(`EXPLAIN QUERY PLAN ${read.sql}`)
      .bind(...read.values)
      .all<{ detail: string }>()
  ).results.map((row) => row.detail);
}

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM mail_identity; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM archive_sources;",
  );
});

describe("thread reads by key", () => {
  it("reads a fixed number of catalog rows however large the unrelated archive is", async () => {
    await insert("parent", { date: "2026-11-10T00:00:00.000Z" });
    await insert("child", { inReplyTo: "<parent@example.invalid>" });
    await insert("gmail-a", { kind: "gmail", thread: "shared", date: "2026-11-10T00:00:00.000Z" });
    await insert("gmail-b", { kind: "gmail", thread: "shared" });
    const measure = async (id: string) => {
      const log: Read[] = [];
      const result = await readMailThread(counted(log), principal, { message_id: id }, BASE);
      return { result, log, rows: log.reduce((sum, read) => sum + read.rows, 0) };
    };
    const small = [await measure("mail_child"), await measure("mail_gmail-b")];
    await unrelated(2_000);
    const large = [await measure("mail_child"), await measure("mail_gmail-b")];
    expect(ids(large[0]!.result)).toEqual(["mail_parent", "mail_child"]);
    expect(ids(large[1]!.result)).toEqual(["mail_gmail-a", "mail_gmail-b"]);
    // Every statement, including each message's own read, is an index lookup: 2,000
    // more unrelated originals add only B-tree depth, not a scan of the archive.
    for (const [index, read] of large.entries()) {
      expect(read.rows).toBeLessThan(100);
      expect(read.rows - small[index]!.rows).toBeLessThan(10);
    }

    const [live, gmail] = large.map((read) =>
      read.log.find((statement) => statement.sql.includes("WITH matched"))!,
    );
    const livePlan = (await plan(live!)).join("\n");
    expect(livePlan).toContain("archive_sources_external_id (external_id=?)");
    expect(livePlan).toContain("mail_extractions_message_id (<expr>=?)");
    expect(livePlan).toContain("mail_extractions_in_reply_to (<expr>=?)");
    expect(livePlan).toContain(
      "SEARCH s USING INDEX sqlite_autoindex_archive_sources_1 (raw_key=?)",
    );
    const gmailPlan = (await plan(gmail!)).join("\n");
    expect(gmailPlan).toContain("gmail_messages_thread (account_namespace=? AND thread_id=?)");
    expect(gmailPlan).toContain(
      "SEARCH s USING INDEX sqlite_autoindex_archive_sources_1 (raw_key=?)",
    );
    for (const detail of [livePlan, gmailPlan]) {
      expect(detail).not.toMatch(/SCAN s\b/);
      expect(detail).not.toContain("(source_kind=?)");
    }
  });

  it("links live mail by Message-ID and In-Reply-To in both directions", async () => {
    await insert("root", { date: "2026-11-09T00:00:00.000Z" });
    // Another original that claims the same Message-ID as the anchor.
    await insert("resent", {
      date: "2026-11-10T00:00:00.000Z",
      messageId: "<root@example.invalid>",
    });
    await insert("reply", {
      date: "2026-11-11T00:00:00.000Z",
      inReplyTo: "<root@example.invalid>",
    });
    await insert("nested", {
      date: "2026-11-12T00:00:00.000Z",
      inReplyTo: "<reply@example.invalid>",
    });
    await insert("other", { inReplyTo: "<elsewhere@example.invalid>" });
    // Message-ID match and the anchor's replies, oldest first.
    expect(ids(await thread("mail_root"))).toEqual(["mail_root", "mail_resent", "mail_reply"]);
    // The anchor's parent by its In-Reply-To, and the anchor's own replies.
    expect(ids(await thread("mail_reply"))).toEqual([
      "mail_root",
      "mail_resent",
      "mail_reply",
      "mail_nested",
    ]);
    // Links are direct only: the grandparent is not followed.
    expect(ids(await thread("mail_nested"))).toEqual(["mail_reply", "mail_nested"]);
    expect((await thread("mail_root")).threading).toBe("direct_message_id_header_links_only");
  });

  it("returns only the anchor when it has no Message-ID or In-Reply-To", async () => {
    await insert("bare", { messageId: null });
    await insert("also-bare", { messageId: null });
    await insert("linked", { inReplyTo: "<bare@example.invalid>" });
    expect(ids(await thread("mail_bare"))).toEqual(["mail_bare"]);
  });

  it("keeps the newest messages, oldest first, and reports truncation", async () => {
    await insert("first", { date: "2026-11-09T00:00:00.000Z" });
    for (const day of [10, 11, 12])
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic fixtures.
      await insert(`reply-${day}`, {
        date: `2026-11-${day}T00:00:00.000Z`,
        inReplyTo: "<first@example.invalid>",
      });
    const result = await thread("mail_first", { max_messages: 2 });
    expect(ids(result)).toEqual(["mail_reply-11", "mail_reply-12"]);
    expect(result.truncated).toBe(true);
    expect((await thread("mail_first", { max_messages: 4 })).truncated).toBe(false);
  });

  it("collapses copies to the anchor and expands them on request", async () => {
    await insert("copy-a", {
      date: "2026-11-09T00:00:00.000Z",
      messageId: "<shared@example.invalid>",
    });
    await insert("copy-b", {
      date: "2026-11-10T00:00:00.000Z",
      messageId: "<shared@example.invalid>",
    });
    await insert("answer", {
      date: "2026-11-11T00:00:00.000Z",
      inReplyTo: "<shared@example.invalid>",
    });
    await group("synthetic-group", "copy-a", "copy-b");
    const collapsed = await thread("mail_copy-b");
    expect(collapsed.messages.map((message) => [message.id, message.copies])).toEqual([
      ["mail_copy-b", 2],
      ["mail_answer", 1],
    ]);
    expect(collapsed.copies).toBe("one_representative_per_copy_group");
    const expanded = await thread("mail_copy-b", { expand_copies: true });
    expect(ids(expanded)).toEqual(["mail_copy-a", "mail_copy-b", "mail_answer"]);
    expect(expanded.copies).toBe("every_original");
  });

  it("matches header links of extractions that are not current, without their content", async () => {
    // Unchanged behavior: links come from the stored extraction, and each message read
    // withholds content unless its extraction is current.
    await insert("anchor", { date: "2026-11-09T00:00:00.000Z" });
    await insert("stale", {
      date: "2026-11-10T00:00:00.000Z",
      inReplyTo: "<anchor@example.invalid>",
      extractedSha: STALE,
    });
    await insert("missing", {
      date: "2026-11-11T00:00:00.000Z",
      inReplyTo: "<anchor@example.invalid>",
      rawState: "missing",
    });
    const result = await thread("mail_anchor");
    expect(ids(result)).toEqual(["mail_anchor", "mail_stale", "mail_missing"]);
    expect(
      result.messages.map((message) => (message as { content?: unknown }).content === null),
    ).toEqual([false, true, true]);
  });

  it("stores and skips malformed metadata without failing the write or the read", async () => {
    await insert("anchor");
    await insert("malformed", { metadataJson: "{not json", body: false });
    expect(ids(await thread("mail_anchor"))).toEqual(["mail_anchor"]);
  });

  it("reads one Gmail account's thread and the anchor without provenance", async () => {
    await insert("g-1", { kind: "gmail", thread: "t", date: "2026-11-09T00:00:00.000Z" });
    await insert("g-2", { kind: "gmail", thread: "t", date: "2026-11-10T00:00:00.000Z" });
    await insert("g-other-thread", { kind: "gmail", thread: "u" });
    await insert("g-other-account", { kind: "gmail", thread: "t", account: "other-account" });
    // A live message with the same Message-ID is not part of a Gmail thread.
    await insert("live", { messageId: "<g-1@example.invalid>" });
    const result = await thread("mail_g-2");
    expect(ids(result)).toEqual(["mail_g-1", "mail_g-2"]);
    expect(result.thread_id).toBe("mail_g-1");
    expect(result.threading).toBe("gmail_account_thread_id");
    await env.MAIL_CATALOG.prepare("DELETE FROM gmail_messages WHERE raw_key=?")
      .bind(key("g-1"))
      .run();
    const bare = await thread("mail_g-1");
    expect(ids(bare)).toEqual(["mail_g-1"]);
    expect(bare.threading).toBe("gmail_provenance_unavailable");
  });
});
