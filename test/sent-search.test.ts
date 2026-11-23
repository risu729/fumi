import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SEARCH_FILTERS, searchMail, type SearchArgs } from "../src/mail-read.ts";
import {
  createDraft,
  projectSentSearch,
  sendMail,
  uploadAttachment,
  type MailInput,
  type OutboundContext,
} from "../src/outbound.ts";
import { dispatchMailTool } from "../src/mcp.ts";
import { searchMailContent } from "../src/content-search.ts";
import type { MailPrincipal } from "../src/principal.ts";

const base = "https://mail.example.invalid";
const owner: MailPrincipal = {
  id: "synthetic-owner",
  scopes: ["mail:read", "mail:draft", "mail:send"],
  fromAddresses: ["owner@example.invalid", "alias@example.invalid"],
};
const other: MailPrincipal = {
  id: "synthetic-other",
  scopes: ["mail:read", "mail:draft", "mail:send"],
  fromAddresses: ["other@example.invalid"],
};
const message: MailInput = {
  from_address: "owner@example.invalid",
  to: ["recipient@example.invalid"],
  subject: "Synthetic sent subject",
  payload: { text: "Synthetic body" },
};

function context(
  send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => ({
    messageId: crypto.randomUUID(),
  })),
) {
  return {
    MAIL_CATALOG: env.MAIL_CATALOG,
    MAIL_ARCHIVE: env.MAIL_ARCHIVE,
    EMAIL: { send },
  } as OutboundContext;
}

/** Sends through fumi's outbound path, then fixes the operation time for ordering. */
async function sent(
  principal: MailPrincipal,
  key: string,
  at: string,
  input: Partial<MailInput> = {},
  ctx = context(),
) {
  const status = await sendMail(
    ctx,
    principal,
    { ...message, from_address: principal.fromAddresses[0], ...input },
    key,
  );
  const operation = String(status.operation_id);
  await env.MAIL_CATALOG.prepare("UPDATE outbound_operations SET created_at=? WHERE operation_id=?")
    .bind(Date.parse(at), operation)
    .run();
  return `sent_${operation}`;
}

/** An inbound archive source: live ingress, or an imported Gmail message with labels. */
async function inbound(
  id: string,
  at: string,
  options: { subject?: string; labels?: string[] } = {},
) {
  const gmail = options.labels !== undefined;
  const key = `ingest/${at.slice(0, 10)}/${id}/raw.eml`;
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES (?,?,?,?,?,?,'present','missing',?,0,0)`,
  )
    .bind(
      gmail ? "gmail" : "email_routing",
      gmail ? "account-a" : "ingress-v1",
      id,
      key,
      `${key}.receipt`,
      at,
      "a".repeat(64),
    )
    .run();
  if (gmail)
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO gmail_messages (raw_key,account_namespace,message_id,thread_id,internal_date,label_ids_json,imported_at) VALUES (?,'account-a',?,?,?,?,?)",
    )
      .bind(key, id, `thread-${id}`, String(Date.parse(at)), JSON.stringify(options.labels), at)
      .run();
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at) VALUES (?,'mime-v1',?,1,?,'complete',?,'[]',?,?,0)`,
  )
    .bind(
      key,
      "a".repeat(64),
      id,
      JSON.stringify({
        subject: options.subject ?? "Synthetic inbound subject",
        from: { address: "sender@example.invalid" },
        to: [{ address: "owner@example.invalid" }],
      }),
      `synthetic/body/${id}`,
      `synthetic/manifest/${id}`,
    )
    .run();
  return `mail_${id}`;
}

async function ids(principal: MailPrincipal, args: SearchArgs) {
  return (await searchMail(env, principal, args)).emails.map((mail) => mail.id);
}

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.batch(
    [
      "outbound_provider_events",
      "outbound_recipients",
      "outbound_operations",
      "outbound_drafts",
      "outbound_attachments",
      "mail_events",
      "gmail_messages",
      "mail_identity",
      "mail_extractions",
      "archive_sources",
    ].map((table) => env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`)),
  );
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
});

describe("metadata search over fumi-sent mail", () => {
  it("returns this principal's sends beside inbound mail and never another principal's", async () => {
    const mail = await inbound("inbound", "2026-11-10T00:00:00.000Z");
    const mine = await sent(owner, "mine", "2026-11-11T00:00:00.000Z", {
      cc: ["copied@example.invalid"],
      bcc: ["hidden@example.invalid"],
    });
    const theirs = await sent(other, "theirs", "2026-11-12T00:00:00.000Z");
    expect(await ids(owner, {})).toEqual([mine, mail]);
    expect(await ids(other, {})).toEqual([theirs, mail]);
    // Another principal's recipients, sender and subject never match.
    expect(await ids(owner, { query: "from:other@example.invalid" })).toEqual([]);
    expect(await ids(owner, { query: "in:sent" })).toEqual([mine]);
    const page = await searchMail(env, owner, { query: "in:sent" });
    expect(page.emails[0]).toEqual({
      id: mine,
      thread_id: mine,
      label_ids: ["SENT"],
      state: "accepted",
      operation_id: mine.slice(5),
      created_at: Date.parse("2026-11-11T00:00:00.000Z"),
      metadata: {
        subject: "Synthetic sent subject",
        from_address: "owner@example.invalid",
        to: ["recipient@example.invalid"],
        cc: ["copied@example.invalid"],
      },
      group_id: null,
      copies: 1,
    });
    // Bcc stays out of search results, as for every other shared search surface.
    expect(JSON.stringify(page)).not.toContain("hidden@example.invalid");
    expect(page.coverage).toMatchObject({
      sent_operations: {
        searched: true,
        principal: "this_principal_only",
        states: ["accepted", "unknown"],
        metadata_unavailable: 0,
      },
    });
    const listed = await dispatchMailTool("search_email_ids", {}, context(), other, base);
    expect(listed["message_ids"]).toEqual([theirs, mail]);
    // The read path and the search path agree on ownership.
    await expect(
      dispatchMailTool("read_email", { message_id: theirs }, context(), owner, base),
    ).rejects.toMatchObject({ code: "send_not_found" });
  });

  it("requires mail:read", async () => {
    const sender: MailPrincipal = { ...owner, scopes: ["mail:send"] };
    await sent(owner, "mine", "2026-11-11T00:00:00.000Z");
    await expect(searchMail(env, sender, {})).rejects.toMatchObject({ code: "forbidden" });
    for (const tool of ["search_emails", "search_email_ids"] as const)
      // oxlint-disable-next-line no-await-in-loop -- Two sequential synthetic tool calls.
      await expect(
        dispatchMailTool(tool, { query: "in:sent" }, context(), sender, base),
      ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("chooses a mailbox with in:sent and in:inbox, including imported Gmail SENT", async () => {
    const live = await inbound("live", "2026-11-01T00:00:00.000Z");
    const gmailInbox = await inbound("gmail-inbox", "2026-11-02T00:00:00.000Z", {
      labels: ["INBOX", "Label_1"],
    });
    const gmailSent = await inbound("gmail-sent", "2026-11-03T00:00:00.000Z", {
      labels: ["SENT"],
    });
    const archived = await inbound("gmail-archived", "2026-11-04T00:00:00.000Z", { labels: [] });
    const mine = await sent(owner, "mine", "2026-11-05T00:00:00.000Z");
    expect(await ids(owner, {})).toEqual([mine, archived, gmailSent, gmailInbox, live]);
    expect(await ids(owner, { query: "in:sent" })).toEqual([mine, gmailSent]);
    expect(await ids(owner, { query: "in:SENT" })).toEqual([mine, gmailSent]);
    expect(await ids(owner, { query: "in:inbox" })).toEqual([gmailInbox, live]);
    expect(await ids(owner, { query: "in:inbox in:sent" })).toEqual([]);
    // archive_source names archive sources, so giving it leaves fumi-sent mail out.
    expect(await ids(owner, { query: "in:sent", archive_source: "gmail" })).toEqual([gmailSent]);
    expect(await ids(owner, { query: "in:sent", archive_source: "all" })).toEqual([gmailSent]);
    expect(await ids(owner, { archive_source: "all" })).toEqual([
      archived,
      gmailSent,
      gmailInbox,
      live,
    ]);
    expect(await ids(owner, { archive_source: "email_routing" })).toEqual([live]);
    // Labels apply to both: a sent_ record carries SENT only.
    expect(await ids(owner, { label_ids: ["SENT"] })).toEqual([mine, gmailSent]);
    expect(await ids(owner, { label_ids: ["INBOX"] })).toEqual([gmailInbox, live]);
    expect(await ids(owner, { label_ids: ["SENT", "Label_1"] })).toEqual([]);
    const all = await dispatchMailTool(
      "search_email_ids",
      { query: "in:sent" },
      context(),
      owner,
      base,
    );
    expect(all["message_ids"]).toEqual([mine, gmailSent]);
    await expect(searchMail(env, owner, { query: "in:spam" })).rejects.toMatchObject({
      code: "unsupported_query",
    });
    expect((await searchMail(env, owner, { query: "in:inbox" })).coverage).toMatchObject({
      sent_operations: { searched: false },
    });
    // Body search does not cover sent mail yet, so it does not accept the mailbox operator.
    await expect(
      searchMailContent(env, owner, { query: "Synthetic", filters: "in:sent" }, base),
    ).rejects.toMatchObject({ code: "unsupported_query" });
  });

  it("applies each metadata operator to sent mail", async () => {
    const ctx = context();
    const attachment = await uploadAttachment(ctx, owner, {
      filename: "report.txt",
      content_type: "text/plain",
      content_base64: btoa("synthetic attachment"),
    });
    const report = await sent(
      owner,
      "report",
      "2026-11-05T12:00:00.000Z",
      {
        to: ["Primary@Example.invalid"],
        cc: ["copied@example.invalid"],
        bcc: ["hidden@example.invalid"],
        subject: "Quarterly Report",
        payload: {
          text: "Synthetic body",
          attachments: [{ attachment_id: attachment.attachment_id, sha256: attachment.sha256 }],
        },
      },
      ctx,
    );
    const lunch = await sent(owner, "lunch", "2026-11-08T00:00:00.000Z", {
      from_address: "alias@example.invalid",
      to: ["friend@example.invalid"],
      subject: "Änderung lunch",
    });
    const query = async (value: string) => ids(owner, { query: `in:sent ${value}` });
    expect(await query("from:alias@")).toEqual([lunch]);
    expect(await query("from:OWNER@example.invalid")).toEqual([report]);
    expect(await query("to:primary@example")).toEqual([report]);
    expect(await query("to:copied@")).toEqual([report]);
    expect(await query("to:hidden@")).toEqual([]);
    expect(await query("subject:quarterly")).toEqual([report]);
    expect(await query('subject:"quarterly report"')).toEqual([report]);
    expect(await query("subject:Änderung")).toEqual([lunch]);
    expect(await query("after:2026-11-06")).toEqual([lunch]);
    expect(await query("before:2026-11-06")).toEqual([report]);
    expect(await query("after:2026-11-05 before:2026-11-06")).toEqual([report]);
    expect(await query("has:attachment")).toEqual([report]);
    expect(await query("has:attachment from:alias@")).toEqual([]);
  });

  it("searches submitted sends only, never drafts or unsubmitted operations", async () => {
    const accepted = await sent(owner, "accepted", "2026-11-01T00:00:00.000Z");
    const uncertain = await sent(
      owner,
      "uncertain",
      "2026-11-02T00:00:00.000Z",
      {},
      context(
        vi.fn(async () => {
          throw new Error("synthetic timeout");
        }),
      ),
    );
    await sent(
      owner,
      "rejected",
      "2026-11-03T00:00:00.000Z",
      {},
      context(
        vi.fn(async () => {
          throw Object.assign(new Error("synthetic rejection"), { code: "E_VALIDATION_ERROR" });
        }),
      ),
    );
    const claimed = await sent(owner, "claimed", "2026-11-04T00:00:00.000Z");
    const prepared = await sent(owner, "prepared", "2026-11-05T00:00:00.000Z");
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare(
        "UPDATE outbound_operations SET state='submitting' WHERE operation_id=?",
      ).bind(claimed.slice(5)),
      env.MAIL_CATALOG.prepare(
        "UPDATE outbound_operations SET state='prepared' WHERE operation_id=?",
      ).bind(prepared.slice(5)),
    ]);
    await createDraft(context(), owner, message);
    const page = await searchMail(env, owner, { query: "in:sent" });
    expect(page.emails.map((mail) => [mail.id, "state" in mail ? mail.state : null])).toEqual([
      // A surviving claim may have reached the provider, so it reads as unknown.
      [claimed, "unknown"],
      [uncertain, "unknown"],
      [accepted, "accepted"],
    ]);
    // The compatibility listing still shows every operation of the principal.
    const legacy = await dispatchMailTool(
      "search_email_ids",
      { label_ids: ["SENT"] },
      context(),
      owner,
      base,
    );
    expect(legacy["message_ids"]).toHaveLength(5);
  });

  it("pages inbound and sent mail together under one cursor", async () => {
    const sameTime = "2026-11-03T00:00:00.000Z";
    const expected = [
      await sent(owner, "s4", "2026-11-06T00:00:00.000Z"),
      await inbound("i3", "2026-11-05T00:00:00.000Z"),
      await sent(owner, "s3", "2026-11-04T00:00:00.000Z"),
      // At an equal time, sent_ IDs sort after mail_ IDs in descending ID order.
      await sent(owner, "s2", sameTime),
      await inbound("i2", sameTime),
      await inbound("i1", "2026-11-02T00:00:00.000Z"),
      await sent(owner, "s1", "2026-11-01T00:00:00.000Z"),
    ];
    expect(await ids(owner, { max_results: 50 })).toEqual(expected);
    for (const size of [1, 2, 3]) {
      const seen: string[] = [];
      let token: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- Each page needs the previous token.
        const page = await searchMail(env, owner, {
          max_results: size,
          ...(token ? { next_page_token: token } : {}),
        });
        expect(page.emails.length).toBeLessThanOrEqual(size);
        seen.push(...page.emails.map((mail) => mail.id));
        token = page.next_page_token ?? undefined;
        // Mail that arrives during the traversal is not part of it.
        // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic writes.
        await sent(owner, `late-${size}-${seen.length}`, "2026-11-01T12:00:00.000Z");
      } while (token);
      expect(seen).toEqual(expected);
      // oxlint-disable-next-line no-await-in-loop -- Reset the late sends between traversals.
      await env.MAIL_CATALOG.prepare(
        "DELETE FROM outbound_recipients WHERE operation_id IN (SELECT operation_id FROM outbound_operations WHERE idempotency_key LIKE 'late-%')",
      ).run();
      // oxlint-disable-next-line no-await-in-loop -- Reset the late sends between traversals.
      await env.MAIL_CATALOG.prepare(
        "DELETE FROM outbound_operations WHERE idempotency_key LIKE 'late-%'",
      ).run();
    }
    const first = await searchMail(env, owner, { max_results: 1 });
    await expect(
      searchMail(env, owner, {
        query: "in:sent",
        max_results: 1,
        next_page_token: first.next_page_token!,
      }),
    ).rejects.toMatchObject({ code: "page_query_mismatch" });
    // Tokens from before sent mail joined the search no longer continue.
    const earlier = btoa(
      JSON.stringify({
        snapshot: 10,
        groups: 0,
        beforeTime: sameTime,
        beforeId: "i2",
        query: JSON.stringify(["", "all", [], false]),
      }),
    );
    await expect(searchMail(env, owner, { next_page_token: earlier })).rejects.toMatchObject({
      code: "invalid_page_token",
    });
  });

  it("keeps another principal's send count out of the continuation token", async () => {
    await sent(owner, "first", "2026-11-02T00:00:00.000Z");
    await sent(owner, "second", "2026-11-01T00:00:00.000Z");
    const snapshot = async () => {
      const token = (await searchMail(env, owner, { query: "in:sent", max_results: 1 }))
        .next_page_token!;
      return (JSON.parse(atob(token)) as { sent: number }).sent;
    };
    const before = await snapshot();
    // The token is readable by its holder, so its sent snapshot must not move with
    // operations of other principals.
    await sent(other, "theirs-1", "2026-11-03T00:00:00.000Z");
    await sent(other, "theirs-2", "2026-11-04T00:00:00.000Z");
    expect(await snapshot()).toBe(before);
  });

  it("continues sent pages from an index position, not a scan from the newest send", async () => {
    for (let day = 1; day <= 24; day++)
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic sends.
      await sent(owner, `send-${day}`, `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`);
    const reads: number[] = [];
    const catalog = new Proxy(env.MAIL_CATALOG, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            reads.push(results[0]!.meta.rows_read);
            return results;
          };
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = { MAIL_CATALOG: catalog, MAIL_ARCHIVE: env.MAIL_ARCHIVE };
    let token: string | undefined;
    const seen: string[] = [];
    do {
      // oxlint-disable-next-line no-await-in-loop -- Each page needs the previous token.
      const page = await searchMail(counted, owner, {
        query: "in:sent",
        max_results: 2,
        ...(token ? { next_page_token: token } : {}),
      });
      seen.push(...page.emails.map((mail) => mail.id));
      token = page.next_page_token ?? undefined;
    } while (token);
    expect(seen).toHaveLength(24);
    // Each page reads its own rows plus the look-ahead and their recipients, however deep
    // the cursor is; a scan from the newest send reads every earlier page again.
    expect(Math.max(...reads)).toBeLessThan(20);
  });

  it("orders sent mail after any token time by its ISO string", async () => {
    const evening = await sent(owner, "evening", "2026-11-02T20:00:00.000Z");
    await sent(owner, "morning", "2026-11-03T05:00:00.000Z");
    const first = await searchMail(env, owner, { query: "in:sent", max_results: 1 });
    const position = (beforeTime: string) =>
      btoa(
        JSON.stringify({
          ...(JSON.parse(atob(first.next_page_token!)) as object),
          beforeTime,
          beforeId: "sent_~",
        }),
      );
    const after = async (beforeTime: string) =>
      ids(owner, { query: "in:sent", next_page_token: position(beforeTime) });
    // Archive times are ISO strings that sort as text; a time toISOString() did not
    // write, such as an offset, still compares as text rather than as an instant.
    expect(await after("2026-11-03T00:00:00.000+09:00")).toEqual([evening]);
    expect(await after("2026-11-03T00:00:00.000Z")).toEqual([evening]);
    // An archive row without a time sorts after every send.
    expect(await after("")).toEqual([]);
  });

  it("pages sends made in the same millisecond by their IDs", async () => {
    const at = "2026-11-02T00:00:00.000Z";
    const expected = [await sent(owner, "tie-1", at), await sent(owner, "tie-2", at)].sort((a, b) =>
      a < b ? 1 : -1,
    );
    const seen: string[] = [];
    let token: string | undefined;
    do {
      // oxlint-disable-next-line no-await-in-loop -- Each page needs the previous token.
      const page = await searchMail(env, owner, {
        query: "in:sent",
        max_results: 1,
        ...(token ? { next_page_token: token } : {}),
      });
      seen.push(...page.emails.map((mail) => mail.id));
      token = page.next_page_token ?? undefined;
    } while (token);
    // The created_at bound includes the token's own millisecond; the ID decides the rest.
    expect(seen).toEqual(expected);
  });

  it("binds the most filters D1 allows in the sent statement too", async () => {
    const first = await sent(owner, "first", "2026-11-02T00:00:00.000Z", { subject: "Änderung" });
    const second = await sent(owner, "second", "2026-11-01T00:00:00.000Z", {
      subject: "Änderung",
    });
    // Each subject:Ä binds two values, the most a filter can bind; in:sent counts too.
    const query = [
      "in:sent",
      ...Array.from({ length: MAX_SEARCH_FILTERS - 1 }, () => "subject:Ä"),
    ].join(" ");
    const page = await searchMail(env, owner, { query, max_results: 1, label_ids: ["SENT"] });
    expect(page.emails.map((mail) => mail.id)).toEqual([first]);
    const next = await searchMail(env, owner, {
      query,
      max_results: 1,
      label_ids: ["SENT"],
      next_page_token: page.next_page_token!,
    });
    expect(next.emails.map((mail) => mail.id)).toEqual([second]);
    await expect(searchMail(env, owner, { query: `${query} subject:Ä` })).rejects.toMatchObject({
      code: "query_too_long",
    });
  });

  it("projects the subject and attachment count of operations stored without them", async () => {
    const earlier = await sent(owner, "earlier", "2026-11-02T00:00:00.000Z", {
      subject: "Projected later",
    });
    const lost = await sent(owner, "lost", "2026-11-01T00:00:00.000Z");
    // Rows a Worker without the search columns inserted, and one whose input is gone.
    await env.MAIL_CATALOG.prepare(
      "UPDATE outbound_operations SET subject=NULL,attachment_count=NULL",
    ).run();
    await env.MAIL_ARCHIVE.delete(`outbound/sent/${lost.slice(5)}/input.json`);
    expect(await ids(owner, { query: "in:sent" })).toEqual([earlier, lost]);
    expect(await ids(owner, { query: "subject:projected" })).toEqual([]);
    expect(await ids(owner, { query: 'subject:""' })).toEqual([]);
    expect(
      (await searchMail(env, owner, { query: "in:sent" })).coverage["sent_operations"],
    ).toMatchObject({ metadata_unavailable: 2 });
    expect(await projectSentSearch(env)).toEqual({ projected: 1, unavailable: 1 });
    expect(await projectSentSearch(env)).toEqual({ projected: 0, unavailable: 0 });
    expect(await ids(owner, { query: "subject:projected" })).toEqual([earlier]);
    const page = await searchMail(env, owner, { query: "in:sent" });
    expect(page.coverage["sent_operations"]).toMatchObject({ metadata_unavailable: 1 });
    expect(page.emails[1]).toMatchObject({ id: lost, metadata: { subject: null } });
  });
});
