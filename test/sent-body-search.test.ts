import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { indexMailContent, searchMailContent } from "../src/content-search.ts";
import { MailReadError } from "../src/mail-read.ts";
import { dispatchMailTool, handleMailResource } from "../src/mcp.ts";
import { sendMail, type MailInput, type OutboundContext } from "../src/outbound.ts";
import type { MailPrincipal } from "../src/principal.ts";
import { indexSentBodies } from "../src/sent-body-search.ts";

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

const hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

/** Sends through fumi's outbound path, then fixes the operation time. */
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

/**
 * An operation written with the columns a Worker before migration 0024 writes, and its
 * input.json, for composed replies and forwards and for inputs a send never stores.
 */
async function storedOperation(
  principal: MailPrincipal,
  id: string,
  json: string,
  options: { state?: string; at?: string } = {},
) {
  const hash = await hex(new TextEncoder().encode(json));
  const key = `outbound/sent/${id}/input.json`;
  await env.MAIL_ARCHIVE.put(key, json);
  const at = Date.parse(options.at ?? "2026-11-11T00:00:00.000Z");
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO outbound_operations (operation_id,principal_id,idempotency_key,input_hash,from_address,input_key,receipt_key,state,created_at,updated_at,subject,attachment_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,'Synthetic',0)`,
  )
    .bind(
      id,
      principal.id,
      id,
      hash,
      principal.fromAddresses[0],
      key,
      `outbound/sent/${id}/receipt.json`,
      options.state ?? "accepted",
      at,
      at,
    )
    .run();
  return `sent_${id}`;
}
function envelope(
  payload: { text?: string; html?: string },
  composed: { reply?: string; forward?: string } = {},
) {
  return JSON.stringify({
    version: "outbound-v1",
    input: {
      to: ["recipient@example.invalid"],
      cc: [],
      bcc: [],
      from_address: "owner@example.invalid",
      subject: "Synthetic",
      payload: { ...payload, attachments: [] },
      ...(composed.reply ? { reply_message_id: composed.reply } : {}),
      headers: {},
    },
    draft: null,
    forward_message_id: composed.forward ?? null,
  });
}

/** An indexed archive message: live ingress, or imported Gmail with labels. */
async function archived(id: string, text: string, labels?: string[]) {
  const bytes = new TextEncoder().encode(text);
  const sha256 = await hex(bytes);
  const bodyKey = `synthetic/search/${sha256}`;
  await env.MAIL_ARCHIVE.put(bodyKey, bytes, { sha256 });
  const gmail = labels !== undefined;
  const rawKey = `ingest/2026-11-11/${id}/raw.eml`;
  const manifestKey = `synthetic/manifest/${id}`;
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES(?,?,?,?,?,'2026-11-11T00:00:00.000Z','present','missing',?,0,0)`,
  )
    .bind(
      gmail ? "gmail" : "email_routing",
      gmail ? "account-a" : "ingress-v1",
      id,
      rawKey,
      `${rawKey}.receipt`,
      "a".repeat(64),
    )
    .run();
  if (gmail)
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO gmail_messages (raw_key,account_namespace,message_id,thread_id,internal_date,label_ids_json,imported_at) VALUES (?,'account-a',?,?,'0',?,'2026-11-11T00:00:00.000Z')",
    )
      .bind(rawKey, id, `thread-${id}`, JSON.stringify(labels))
      .run();
  await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,attachment_count,body_json_key,body_text_key,body_html_key,manifest_key,updated_at)
    VALUES(?,'mime-v1',?,1,?,'complete',?,'[]',0,'synthetic/body-json',?,NULL,?,0)`)
    .bind(
      rawKey,
      "a".repeat(64),
      id,
      JSON.stringify({ subject: "Synthetic inbound", from: { address: "sender@example.invalid" } }),
      bodyKey,
      manifestKey,
    )
    .run();
  expect(
    await indexMailContent(env, {
      raw_key: rawKey,
      manifest_key: manifestKey,
      body_text_key: bodyKey,
      body_html_key: null,
      attachments_json: "[]",
    }),
  ).toBe(true);
  return `mail_${id}`;
}

async function search(
  principal: MailPrincipal,
  input: Parameters<typeof searchMailContent>[2],
  catalog: D1Database = env.MAIL_CATALOG,
) {
  return searchMailContent(
    { MAIL_CATALOG: catalog, MAIL_ARCHIVE: env.MAIL_ARCHIVE },
    principal,
    input,
    base,
  );
}
async function ids(principal: MailPrincipal, query: string, filters = "") {
  return (await search(principal, { query, filters, max_results: 50 })).matches.map(
    (match) => match.message_id,
  );
}
async function bodySearch(operationId: string) {
  return (
    await env.MAIL_CATALOG.prepare(
      "SELECT body_search_json FROM outbound_operations WHERE operation_id=?",
    )
      .bind(operationId.replace(/^sent_/, ""))
      .first<{ body_search_json: string | null }>()
  )?.body_search_json;
}
function decode(token: string) {
  return JSON.parse(atob(token)) as Record<string, unknown>;
}

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.batch(
    [
      "sent_search_chunks",
      "outbound_provider_events",
      "outbound_recipients",
      "outbound_operations",
      "outbound_drafts",
      "outbound_attachments",
      "mail_events",
      "mail_search_chunks",
      "mail_search_documents",
      "gmail_messages",
      "mail_identity",
      "mail_extractions",
      "archive_sources",
    ].map((table) => env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`)),
  );
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
});

describe("sent body search isolation", () => {
  it("returns only the caller's own sent bodies and counts, whoever holds a token", async () => {
    const mine = await sent(owner, "mine", "2026-11-11T00:00:00.000Z", {
      payload: { text: "The revised total is 48,200 yen." },
    });
    await indexSentBodies(env);
    const theirs = await sent(other, "theirs", "2026-11-12T00:00:00.000Z", {
      payload: { text: "Their own total is also 48,200 yen." },
    });
    await indexSentBodies(env);
    const later = await sent(other, "later", "2026-11-13T00:00:00.000Z", {
      payload: { text: "A later 48,200 yen note." },
    });
    expect(await indexSentBodies(env)).toEqual({
      indexed: 1,
      unavailable: 0,
      skipped: 0,
      deferred: 0,
    });
    const page = await search(owner, { query: "48,200" });
    expect(page.matches.map((match) => match.message_id)).toEqual([mine]);
    expect(JSON.stringify(page)).not.toContain("Their own");
    expect(page.coverage["sent_operations"]).toEqual({
      searched: true,
      principal: "this_principal_only",
      states: ["accepted", "unknown"],
      indexed: 1,
      pending: 0,
      unavailable: 0,
      html_only: 0,
    });
    const first = await search(other, { query: "48,200", max_results: 1 });
    expect(first.matches.map((match) => match.message_id)).toEqual([later]);
    expect(first.coverage["sent_operations"]).toMatchObject({ indexed: 2 });
    expect(decode(first.next_page_token!)).toMatchObject({ version: 2, phase: "sent" });
    // The token is not bound to a principal: the owner holding it gets only its own matches.
    const borrowed = await search(owner, {
      query: "48,200",
      max_results: 1,
      next_page_token: first.next_page_token!,
    });
    expect(borrowed.matches.map((match) => match.message_id)).toEqual([mine]);
    const second = await search(other, {
      query: "48,200",
      max_results: 1,
      next_page_token: first.next_page_token!,
    });
    expect(second.matches.map((match) => match.message_id)).toEqual([theirs]);
  });

  it("requires mail:read, never mail:send", async () => {
    await sent(owner, "mine", "2026-11-11T00:00:00.000Z");
    await indexSentBodies(env);
    const sender: MailPrincipal = { ...owner, scopes: ["mail:send", "mail:draft"] };
    await expect(search(sender, { query: "Synthetic" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      dispatchMailTool("search_mail_content", { query: "Synthetic" }, context(), sender, base),
    ).rejects.toMatchObject({ code: "forbidden" });
    // A reader that never sent through fumi gets no sent matches and counts of zero.
    const reader: MailPrincipal = {
      id: "synthetic-reader",
      scopes: ["mail:read"],
      fromAddresses: [],
    };
    const page = await search(reader, { query: "Synthetic" });
    expect(page.matches).toEqual([]);
    expect(page.coverage["sent_operations"]).toMatchObject({
      indexed: 0,
      pending: 0,
      unavailable: 0,
      html_only: 0,
    });
  });

  it("removes an operation's chunks when the operation is deleted", async () => {
    const mine = await sent(owner, "mine", "2026-11-11T00:00:00.000Z", {
      payload: { text: "deleted record needle" },
    });
    await indexSentBodies(env);
    expect(await ids(owner, "record needle")).toEqual([mine]);
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare("DELETE FROM outbound_recipients WHERE operation_id=?").bind(
        mine.slice(5),
      ),
      env.MAIL_CATALOG.prepare("DELETE FROM outbound_operations WHERE operation_id=?").bind(
        mine.slice(5),
      ),
    ]);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM sent_search_chunks").first("n"),
    ).toBe(0);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS n FROM sent_search_fts WHERE sent_search_fts MATCH '\"record needle\"'",
      ).first("n"),
    ).toBe(0);
  });
});

describe("sent body search filters and states", () => {
  it("chooses sent bodies or the archive with in: and applies metadata operators", async () => {
    const ctx = context();
    const report = await sent(
      owner,
      "report",
      "2026-11-05T12:00:00.000Z",
      {
        to: ["Primary@Example.invalid"],
        cc: ["copied@example.invalid"],
        bcc: ["hidden@example.invalid"],
        subject: "Quarterly Report",
        payload: { text: "quarterly needle report" },
      },
      ctx,
    );
    const lunch = await sent(owner, "lunch", "2026-11-08T00:00:00.000Z", {
      from_address: "alias@example.invalid",
      to: ["friend@example.invalid"],
      subject: "Lunch",
      payload: { text: "quarterly needle lunch" },
    });
    await indexSentBodies(env);
    const live = await archived("live", "quarterly needle live");
    const gmailSent = await archived("gmail-sent", "quarterly needle gmail sent", ["SENT"]);
    const gmailInbox = await archived("gmail-inbox", "quarterly needle gmail inbox", ["INBOX"]);
    const all = await ids(owner, "quarterly needle");
    // Sent matches first, newest chunk first, then archive matches.
    expect(all.slice(0, 2).sort()).toEqual([lunch, report].sort());
    expect(all.slice(2)).toEqual([gmailInbox, gmailSent, live]);
    expect((await ids(owner, "quarterly needle", "in:sent")).slice(2)).toEqual([gmailSent]);
    expect(await ids(owner, "quarterly needle", "in:SENT")).toHaveLength(3);
    expect(await ids(owner, "quarterly needle", "in:inbox")).toEqual([gmailInbox, live]);
    expect(await ids(owner, "quarterly needle", "in:inbox in:sent")).toEqual([]);
    expect(
      (await search(owner, { query: "quarterly needle", filters: "in:inbox" })).coverage[
        "sent_operations"
      ],
    ).toEqual({ searched: false });
    await expect(
      search(owner, { query: "quarterly needle", filters: "in:spam" }),
    ).rejects.toMatchObject({ code: "unsupported_query" });
    const sentOnly = async (filters: string) =>
      ids(owner, "quarterly needle", `in:sent ${filters}`);
    expect(await sentOnly("to:primary@example")).toEqual([report]);
    expect(await sentOnly("to:copied@")).toEqual([report]);
    // Bcc is never matched by to:.
    expect(await sentOnly("to:hidden@")).toEqual([]);
    expect(await sentOnly("from:alias@")).toEqual([lunch]);
    expect(await sentOnly("subject:quarterly")).toEqual([report]);
    // after: applies to the archived Gmail SENT copy too (received 2026-11-11).
    expect(await sentOnly("after:2026-11-06")).toEqual([lunch, gmailSent]);
    expect(await sentOnly("before:2026-11-06")).toEqual([report]);
    expect(await sentOnly("has:attachment")).toEqual([]);
    // Bcc addresses are not in results, citations or the indexed text.
    const page = await search(owner, { query: "quarterly needle" });
    expect(JSON.stringify(page)).not.toContain("hidden@example.invalid");
  });

  it("indexes and searches submitted sends only, and repeats the state check at query time", async () => {
    const body = { payload: { text: "state check needle" } };
    const accepted = await sent(owner, "accepted", "2026-11-01T00:00:00.000Z", body);
    const uncertain = await sent(
      owner,
      "uncertain",
      "2026-11-02T00:00:00.000Z",
      body,
      context(
        vi.fn(async () => {
          throw new Error("synthetic timeout");
        }),
      ),
    );
    const rejected = await sent(
      owner,
      "rejected",
      "2026-11-03T00:00:00.000Z",
      body,
      context(
        vi.fn(async () => {
          throw Object.assign(new Error("synthetic rejection"), { code: "E_VALIDATION_ERROR" });
        }),
      ),
    );
    const claimed = await sent(owner, "claimed", "2026-11-04T00:00:00.000Z", body);
    const prepared = await sent(owner, "prepared", "2026-11-05T00:00:00.000Z", body);
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare(
        "UPDATE outbound_operations SET state='submitting' WHERE operation_id=?",
      ).bind(claimed.slice(5)),
      env.MAIL_CATALOG.prepare(
        "UPDATE outbound_operations SET state='prepared' WHERE operation_id=?",
      ).bind(prepared.slice(5)),
    ]);
    expect(
      (await search(owner, { query: "state check needle" })).coverage["sent_operations"],
    ).toMatchObject({ indexed: 0, pending: 3 });
    expect(await indexSentBodies(env)).toEqual({
      indexed: 3,
      unavailable: 0,
      skipped: 1,
      deferred: 0,
    });
    expect(await indexSentBodies(env)).toEqual({
      indexed: 0,
      unavailable: 0,
      skipped: 0,
      deferred: 0,
    });
    expect(JSON.parse((await bodySearch(rejected))!)).toEqual({
      version: "sent-text-v1",
      status: "not_sent",
    });
    expect(await bodySearch(prepared)).toBeNull();
    expect((await ids(owner, "state check needle")).sort()).toEqual(
      [accepted, uncertain, claimed].sort(),
    );
    const page = await search(owner, { query: "state check needle" });
    expect(page.coverage["sent_operations"]).toMatchObject({ indexed: 3, pending: 0 });
    // An indexed operation whose state leaves the searched states stops matching.
    await env.MAIL_CATALOG.prepare(
      "UPDATE outbound_operations SET state='rejected' WHERE operation_id=?",
    )
      .bind(accepted.slice(5))
      .run();
    expect((await ids(owner, "state check needle")).sort()).toEqual([uncertain, claimed].sort());
  });
});

describe("sent body search pages", () => {
  it("crosses from sent matches into archive matches under one token", async () => {
    const sends: string[] = [];
    for (const day of [1, 2, 3]) {
      // oxlint-disable-next-line no-await-in-loop -- Index each send so chunk IDs follow send order.
      const send = await sent(owner, `send-${day}`, `2026-11-0${day}T00:00:00.000Z`, {
        payload: { text: `paging needle ${day}` },
      });
      sends.push(send);
      // oxlint-disable-next-line no-await-in-loop -- See above.
      await indexSentBodies(env);
    }
    const archive: string[] = [];
    for (const index of [1, 2, 3, 4])
      // oxlint-disable-next-line no-await-in-loop -- Ordered synthetic messages.
      archive.push(await archived(`archive-${index}`, `paging needle archive ${index}`));
    const expected = [...sends].reverse().concat([...archive].reverse());
    expect(await ids(owner, "paging needle")).toEqual(expected);
    for (const size of [1, 2, 3, 4]) {
      const seen: string[] = [];
      const phases: unknown[] = [];
      let token: string | undefined;
      do {
        // oxlint-disable-next-line no-await-in-loop -- Each page needs the previous token.
        const page = await search(owner, {
          query: "paging needle",
          max_results: size,
          ...(token ? { next_page_token: token } : {}),
        });
        expect(page.matches.length).toBeLessThanOrEqual(size);
        seen.push(...page.matches.map((match) => match.message_id));
        token = page.next_page_token ?? undefined;
        if (token) phases.push(decode(token)["phase"]);
        // A send indexed during the traversal is not part of it.
        // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic writes.
        await sent(owner, `late-${size}-${seen.length}`, "2026-11-10T00:00:00.000Z", {
          payload: { text: "late paging needle" },
        });
        // oxlint-disable-next-line no-await-in-loop -- See above.
        await indexSentBodies(env);
      } while (token);
      expect(seen).toEqual(expected);
      expect(phases).toContain("archive");
      // oxlint-disable-next-line no-await-in-loop -- Reset the late sends between traversals.
      await env.MAIL_CATALOG.batch([
        env.MAIL_CATALOG.prepare(
          "DELETE FROM outbound_recipients WHERE operation_id IN (SELECT operation_id FROM outbound_operations WHERE idempotency_key LIKE 'late-%')",
        ),
        env.MAIL_CATALOG.prepare(
          "DELETE FROM outbound_operations WHERE idempotency_key LIKE 'late-%'",
        ),
      ]);
    }
    // A page of two holds the last sent match and the first archive match.
    const first = await search(owner, { query: "paging needle", max_results: 2 });
    const second = await search(owner, {
      query: "paging needle",
      max_results: 2,
      next_page_token: first.next_page_token!,
    });
    expect(second.matches.map((match) => match.message_id)).toEqual([sends[0], archive[3]]);
    expect(decode(second.next_page_token!)).toMatchObject({ phase: "archive" });
    // A page that ends with the last sent match continues at the first archive match.
    const three = await search(owner, { query: "paging needle", max_results: 3 });
    expect(decode(three.next_page_token!)).toEqual({
      version: 2,
      phase: "archive",
      before: Number.MAX_SAFE_INTEGER,
      query: "paging needle",
      filter: "",
    });
    // With nothing left in the archive, the last sent match ends the traversal.
    expect(
      (await search(owner, { query: "paging needle", filters: "in:sent", max_results: 3 }))
        .next_page_token,
    ).toBeNull();
  });

  it("continues a token issued before sent bodies joined as an archive-phase token", async () => {
    await sent(owner, "mine", "2026-11-01T00:00:00.000Z", { payload: { text: "legacy needle" } });
    await indexSentBodies(env);
    const one = await archived("one", "legacy needle one");
    const two = await archived("two", "legacy needle two");
    const chunk = await env.MAIL_CATALOG.prepare(
      "SELECT c.id FROM mail_search_chunks c JOIN archive_sources s ON s.raw_key=c.raw_key WHERE s.external_id='two'",
    ).first<number>("id");
    const legacy = btoa(JSON.stringify({ before: chunk, query: "legacy needle", filter: "" }));
    const page = await search(owner, { query: "legacy needle", next_page_token: legacy });
    // No sent match: the traversal was in the archive, below the token's chunk.
    expect(page.matches.map((match) => match.message_id)).toEqual([one]);
    expect(two).toBe("mail_two");
    for (const token of [
      { version: 3, phase: "archive", before: 5, query: "legacy needle", filter: "" },
      { version: 2, phase: "other", before: 5, query: "legacy needle", filter: "" },
      { version: 2, phase: "sent", before: 0, query: "legacy needle", filter: "" },
      { version: 2, phase: "sent", before: 5, query: "different", filter: "" },
      // in:inbox never searches sent bodies, so no sent-phase token exists for it.
      { version: 2, phase: "sent", before: 5, query: "legacy needle", filter: "in:inbox" },
    ])
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic tokens.
      await expect(
        search(owner, {
          query: "legacy needle",
          filters: token.filter,
          next_page_token: btoa(JSON.stringify(token)),
        }),
      ).rejects.toMatchObject({ code: "invalid_page_token" });
  });
});

describe("sent body indexing", () => {
  it("marks inputs that can never be read and retries request failures", async () => {
    const missing = await sent(owner, "missing", "2026-11-01T00:00:00.000Z");
    const changed = await sent(owner, "changed", "2026-11-02T00:00:00.000Z");
    const oversized = await sent(owner, "oversized", "2026-11-03T00:00:00.000Z");
    const malformed = await storedOperation(owner, "send_malformed", '{"input":{"payload":"x"}}', {
      at: "2026-11-04T00:00:00.000Z",
    });
    const notJson = await storedOperation(owner, "send_not_json", "not json", {
      at: "2026-11-05T00:00:00.000Z",
    });
    await env.MAIL_ARCHIVE.delete(`outbound/sent/${missing.slice(5)}/input.json`);
    await env.MAIL_ARCHIVE.put(`outbound/sent/${changed.slice(5)}/input.json`, "{}");
    await env.MAIL_ARCHIVE.put(
      `outbound/sent/${oversized.slice(5)}/input.json`,
      new Uint8Array(6 * 1024 * 1024 + 1),
    );
    expect(await indexSentBodies(env)).toEqual({
      indexed: 0,
      unavailable: 5,
      skipped: 0,
      deferred: 0,
    });
    for (const id of [missing, changed, oversized, malformed, notJson])
      // oxlint-disable-next-line no-await-in-loop -- Sequential reads.
      expect(JSON.parse((await bodySearch(id))!)).toEqual({
        version: "sent-text-v1",
        status: "unavailable",
      });
    expect((await search(owner, { query: "Synthetic" })).coverage["sent_operations"]).toMatchObject(
      { indexed: 0, pending: 0, unavailable: 5 },
    );
    // An R2 request failure leaves the row for the next run.
    const retried = await sent(owner, "retried", "2026-11-06T00:00:00.000Z");
    const failing = {
      MAIL_CATALOG: env.MAIL_CATALOG,
      MAIL_ARCHIVE: {
        get: async () => {
          throw new Error("synthetic R2 failure");
        },
      } as unknown as R2Bucket,
    };
    expect(await indexSentBodies(failing)).toEqual({
      indexed: 0,
      unavailable: 0,
      skipped: 0,
      deferred: 1,
    });
    expect(await bodySearch(retried)).toBeNull();
    expect(await indexSentBodies(env)).toMatchObject({ indexed: 1, deferred: 0 });
  });

  it("publishes once when two runs index the same operation", async () => {
    const mine = await sent(owner, "mine", "2026-11-01T00:00:00.000Z", {
      payload: { text: "raced needle" },
    });
    let inner: Awaited<ReturnType<typeof indexSentBodies>> | undefined;
    const racing = {
      MAIL_CATALOG: env.MAIL_CATALOG,
      MAIL_ARCHIVE: {
        get: async (key: string) => {
          // Another run publishes while this one holds the input.
          inner ??= await indexSentBodies(env);
          return env.MAIL_ARCHIVE.get(key);
        },
      } as unknown as R2Bucket,
    };
    expect(await indexSentBodies(racing)).toMatchObject({ indexed: 0, deferred: 0 });
    expect(inner).toMatchObject({ indexed: 1 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM sent_search_chunks").first("n"),
    ).toBe(1);
    expect(await ids(owner, "raced needle")).toEqual([mine]);
  });

  it("indexes the composed body with its quote, and records how it was composed", async () => {
    const reply = await storedOperation(
      owner,
      "send_reply",
      envelope(
        {
          text: "The revised total is 48,200 yen.\n\nOn Tue, Nov 17, 2026 at 11:13 PM Sato <sato@example.invalid> wrote:\n\n> Could you confirm the quoted total?",
          html: "<p>The revised total is 48,200 yen.</p>",
        },
        { reply: "mail_parent" },
      ),
    );
    const forward = await storedOperation(
      owner,
      "send_forward",
      envelope(
        { text: "FYI\n\n---------- Forwarded message ---------\nforwarded original needle" },
        { forward: "ingest/2026-11-11/parent/raw.eml" },
      ),
    );
    const htmlOnly = await storedOperation(
      owner,
      "send_html",
      envelope({ html: "<p>html only needle</p>" }),
    );
    const created = await storedOperation(
      owner,
      "send_new",
      envelope({ text: "請求書の合計は四万八千二百円です" }),
    );
    expect(await indexSentBodies(env)).toMatchObject({ indexed: 4 });
    const coverage = async (id: string) => JSON.parse((await bodySearch(id))!) as unknown;
    expect(await coverage(reply)).toEqual({
      version: "sent-text-v1",
      status: "ready",
      chunks: 1,
      omitted: [],
      composed: "reply",
    });
    expect(await coverage(forward)).toMatchObject({ composed: "forward", chunks: 1 });
    expect(await coverage(created)).toMatchObject({ composed: "new" });
    expect(await coverage(htmlOnly)).toEqual({
      version: "sent-text-v1",
      status: "ready",
      chunks: 0,
      omitted: ["html_only_body"],
      composed: "new",
    });
    expect(await ids(owner, "quoted total")).toEqual([reply]);
    expect(await ids(owner, "forwarded original")).toEqual([forward]);
    expect(await ids(owner, "html only")).toEqual([]);
    expect(await ids(owner, "四万八千")).toEqual([created]);
    expect(await ids(owner, "48,200")).toEqual([reply]);
    expect((await search(owner, { query: "48,200" })).coverage["sent_operations"]).toMatchObject({
      indexed: 4,
      html_only: 1,
    });
  });

  it("bounds the indexed body and finds a phrase across a chunk boundary", async () => {
    const boundary = await storedOperation(
      owner,
      "send_boundary",
      envelope({ text: `${"a".repeat(3490)}boundary needle${"b".repeat(100)}` }),
    );
    const long = await storedOperation(
      owner,
      "send_long",
      envelope({ text: `${"c".repeat(100_000)}beyond the cut needle` }),
    );
    await indexSentBodies(env);
    const page = await search(owner, { query: "boundary needle" });
    expect(page.matches.map((match) => [match.message_id, match.citation["chunk"]])).toEqual([
      [boundary, 1],
    ]);
    expect(JSON.parse((await bodySearch(long))!)).toEqual({
      version: "sent-text-v1",
      status: "ready",
      chunks: 31,
      omitted: ["body_truncated"],
      composed: "new",
    });
    expect(await ids(owner, "beyond the cut")).toEqual([]);
  });
});

describe("sent body citations", () => {
  it("cites the exact /text download, whose digest equals the chunk sha256", async () => {
    const mine = await sent(owner, "mine", "2026-11-01T00:00:00.000Z", {
      bcc: ["hidden@example.invalid"],
      payload: { text: "Citation needle with ünïcödé and 日本語", html: "<p>Citation</p>" },
    });
    await indexSentBodies(env);
    const ctx = context();
    const result = await dispatchMailTool(
      "search_mail_content",
      { query: "citation needle", filters: "in:sent" },
      ctx,
      owner,
      base,
    );
    const [match] = result["matches"] as {
      message_id: string;
      group_id: unknown;
      excerpt: string;
      citation: Record<string, string>;
    }[];
    const input = await env.MAIL_CATALOG.prepare(
      "SELECT input_hash FROM outbound_operations WHERE operation_id=?",
    )
      .bind(mine.slice(5))
      .first<string>("input_hash");
    expect(match).toMatchObject({
      message_id: mine,
      group_id: null,
      excerpt: "Citation needle with ünïcödé and 日本語",
      citation: {
        part: "body",
        chunk: 0,
        representation: "original_text",
        file_uri: `${base}/api/mail/${mine}/text`,
        original_file_uri: `${base}/api/mail/${mine}/text`,
        input_sha256: input,
        record_uri: `${base}/api/mail/${mine}/body`,
      },
    });
    expect(match!.citation["original_sha256"]).toBe(match!.citation["sha256"]);
    const response = await handleMailResource(
      new Request(match!.citation["file_uri"]!),
      ctx,
      owner,
      mine,
      "text",
    );
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe("attachment");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(await hex(bytes)).toBe(match!.citation["sha256"]);
    expect(new TextDecoder().decode(bytes)).toBe("Citation needle with ünïcödé and 日本語");
    const head = await handleMailResource(
      new Request(match!.citation["file_uri"]!, { method: "HEAD" }),
      ctx,
      owner,
      mine,
      "text",
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    // Another principal, a missing scope and an HTML-only send get an unavailable download.
    await expect(
      handleMailResource(new Request(match!.citation["file_uri"]!), ctx, other, mine, "text"),
    ).rejects.toBeInstanceOf(MailReadError);
    await expect(
      handleMailResource(
        new Request(match!.citation["file_uri"]!),
        ctx,
        { ...owner, scopes: ["mail:send"] },
        mine,
        "text",
      ),
    ).rejects.toBeInstanceOf(MailReadError);
    const htmlOnly = await sent(owner, "html", "2026-11-02T00:00:00.000Z", {
      payload: { html: "<p>HTML only</p>" },
    });
    await expect(
      handleMailResource(
        new Request(`${base}/api/mail/${htmlOnly}/text`),
        ctx,
        owner,
        htmlOnly,
        "text",
      ),
    ).rejects.toBeInstanceOf(MailReadError);
    await expect(
      handleMailResource(new Request(`${base}/api/mail/${mine}/raw`), ctx, owner, mine, "raw"),
    ).rejects.toBeInstanceOf(MailReadError);
  });
});

describe("sent body search cost", () => {
  /** Writes operations and their chunks directly, as thousands of sends would. */
  async function bulk(principal: MailPrincipal, count: number, prefix: string) {
    const statements = Array.from({ length: count }, (_, index) => [
      env.MAIL_CATALOG.prepare(
        `INSERT INTO outbound_operations (operation_id,principal_id,idempotency_key,input_hash,from_address,input_key,receipt_key,state,created_at,updated_at,subject,attachment_count,body_search_json)
         VALUES (?,?,?,?,?,?,?,'accepted',?,?,'Synthetic',0,'{"version":"sent-text-v1","status":"ready","chunks":1,"omitted":[],"composed":"new"}')`,
      ).bind(
        `${prefix}-${index}`,
        principal.id,
        `${prefix}-${index}`,
        "a".repeat(64),
        principal.fromAddresses[0],
        `outbound/sent/${prefix}-${index}/input.json`,
        `outbound/sent/${prefix}-${index}/receipt.json`,
        index,
        index,
      ),
      env.MAIL_CATALOG.prepare(
        "INSERT INTO sent_search_chunks(operation_id,part,ordinal,text,sha256) VALUES(?,'body',0,'the common needle',?)",
      ).bind(`${prefix}-${index}`, "b".repeat(64)),
    ]).flat();
    for (let start = 0; start < statements.length; start += 300)
      // oxlint-disable-next-line no-await-in-loop -- Keep each synthetic batch small.
      await env.MAIL_CATALOG.batch(statements.slice(start, start + 300));
  }
  /** The sent statement as searchMailContent prepared and bound it, and its result. */
  async function sentStatement(input: Parameters<typeof searchMailContent>[2]) {
    const prepare = env.MAIL_CATALOG.prepare.bind(env.MAIL_CATALOG);
    let captured: { sql: string; values: unknown[] } | undefined;
    const spy = vi.spyOn(env.MAIL_CATALOG, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (!sql.includes("sent_search_fts MATCH")) return statement;
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: unknown[]) => {
        captured = { sql, values };
        return bind(...values);
      };
      return statement;
    });
    try {
      const result = await search(owner, input);
      return { result, ...captured! };
    } finally {
      spy.mockRestore();
    }
  }

  it("walks matches in descending rowid order without a temporary sort", async () => {
    await bulk(owner, 3, "plan");
    for (const filters of [
      "",
      "in:sent to:someone@ after:2026-01-01 subject:plan has:attachment",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- One filter at a time keeps the spy scoped.
      const { sql, values } = await sentStatement({ query: "needle", filters });
      // oxlint-disable-next-line no-await-in-loop -- Same as above.
      const plan = await env.MAIL_CATALOG.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...values)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail);
      expect(details.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([]);
      const scan = /^SCAN sent_search_fts VIRTUAL TABLE INDEX (\d+):(\S*)$/.exec(details[0]!);
      expect(scan, details.join("\n")).not.toBeNull();
      expect(Number(scan![1]) & 0xc0).toBe(0xc0);
      expect(scan![2]).toContain("<");
    }
  });

  it("reads a bounded number of rows per page however many of the caller's chunks match", async () => {
    await bulk(owner, 2000, "bulk");
    const first = await sentStatement({ query: "the common", filters: "in:sent" });
    expect(first.result.matches).toHaveLength(20);
    const second = await sentStatement({
      query: "the common",
      filters: "in:sent",
      next_page_token: first.result.next_page_token!,
    });
    expect(second.result.matches).toHaveLength(20);
    expect(second.result.matches[0]!.message_id).toBe("sent_bulk-1979");
    for (const { sql, values } of [first, second]) {
      // oxlint-disable-next-line no-await-in-loop -- Measure one page at a time.
      const { meta } = await env.MAIL_CATALOG.prepare(sql)
        .bind(...values)
        .all();
      // Walking rowids in order stops after the 21 rows the page needs.
      expect(meta.rows_read).toBeLessThan(500);
    }
  });

  it("walks other principals' matches below the caller's without returning them", async () => {
    await bulk(other, 2000, "theirs");
    await bulk(owner, 20, "mine");
    const page = await sentStatement({ query: "the common", filters: "in:sent" });
    expect(page.result.matches.map((match) => match.message_id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `sent_mine-${19 - index}`),
    );
    expect(page.result.next_page_token).toBeNull();
    expect(page.result.coverage["sent_operations"]).toMatchObject({ indexed: 20 });
    const { meta } = await env.MAIL_CATALOG.prepare(page.sql)
      .bind(...page.values)
      .all();
    // Looking for a 21st match of the caller visits each of the other principal's 2,000
    // matches through two primary-key rows: the accepted response-time signal
    // (docs/sent-body-search.md#measurements). It stays linear in the matches.
    expect(meta.rows_read).toBeGreaterThan(2000);
    expect(meta.rows_read).toBeLessThan(2.1 * 2020);
  });
});
