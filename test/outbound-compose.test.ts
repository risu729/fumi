import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OUTBOUND_LIMITS,
  createDraft,
  forwardMail,
  getSentMail,
  previewMail,
  sendDraft,
  sendMail,
  updateDraft,
} from "../src/outbound.ts";
import type { MailInput, OutboundContext } from "../src/outbound.ts";
import {
  FORWARD_SEPARATOR,
  QUOTE_TRUNCATED,
  formatMailDate,
  htmlToText,
  quoteLines,
} from "../src/outbound-compose.ts";

const principal = {
  id: "synthetic-owner",
  scopes: ["mail:read", "mail:draft", "mail:send"],
  fromAddresses: ["sender@example.invalid"],
};
const rawKey = "ingest/2026-11-17/synthetic-parent/raw.eml";
const prefix = "ingest/2026-11-17/synthetic-parent";
const parentText = "First line\r\n\r\n> earlier quote\r\nLast line\r\n";
const attribution =
  "On Tue, Nov 17, 2026 at 11:13 PM Parent Sender <parent@example.invalid> wrote:";
const encoder = new TextEncoder();

async function sha256(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

async function stored(kind: string, bytes: Uint8Array) {
  const digest = await sha256(bytes);
  const key = `${prefix}/${kind}/${digest}`;
  await env.MAIL_ARCHIVE.put(key, bytes);
  return { key, sha256: digest, size: bytes.byteLength };
}

/** A completed extraction shaped like src/mime-extraction.ts output. */
async function seedParent(
  body: { text: string | null; html: string | null } = { text: parentText, html: null },
  attachments: { filename: string | null; mimeType: string; content: Uint8Array }[] = [],
  metadata: Record<string, unknown> = {},
) {
  const bodyRef = await stored("body-json", encoder.encode(JSON.stringify(body)));
  const attachmentRefs = [];
  for (const [index, attachment] of attachments.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- Synthetic fixtures are tiny and ordered.
    const reference = await stored("attachment", attachment.content);
    attachmentRefs.push({
      index,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      ...reference,
    });
  }
  await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions (raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,
    metadata_json,attachments_json,attachment_count,body_json_key,manifest_key,updated_at)
    VALUES (?,'mime-v1',?,1,'synthetic','complete',?,?,?,?,'synthetic-manifest',0)`)
    .bind(
      rawKey,
      "0".repeat(64),
      JSON.stringify({
        subject: "Synthetic parent",
        from: { name: "Parent Sender", address: "parent@example.invalid" },
        to: [{ name: "", address: "owner@example.invalid" }],
        cc: [{ name: "Copied", address: "copied@example.invalid" }],
        bcc: [{ address: "hidden@example.invalid" }],
        date: "2026-11-17T14:13:00.000Z",
        messageId: "<parent@example.invalid>",
        threadHeaders: [{ name: "date", value: "Tue, 17 Nov 2026 23:13:00 +0900" }],
        ...metadata,
      }),
      JSON.stringify(attachmentRefs),
      attachmentRefs.length,
      bodyRef.key,
    )
    .run();
}

function context() {
  const send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => ({
    messageId: "synthetic-provider-id",
  }));
  return {
    ctx: {
      MAIL_CATALOG: env.MAIL_CATALOG,
      MAIL_ARCHIVE: env.MAIL_ARCHIVE,
      EMAIL: { send },
    } as OutboundContext,
    send,
  };
}

const sent = (send: ReturnType<typeof context>["send"], call = 0) =>
  send.mock.calls[call]?.[0] as EmailMessageBuilder;

const reply: MailInput = {
  from_address: "sender@example.invalid",
  to: ["parent@example.invalid"],
  subject: "",
  payload: { text: "Reply body", html: "<p>Reply body</p>" },
  reply_message_id: rawKey,
};

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.batch(
    [
      "outbound_recipients",
      "outbound_operations",
      "outbound_drafts",
      "outbound_attachments",
      "mail_events",
      "mail_extractions",
    ].map((table) => env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`)),
  );
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
});

describe("Gmail-style reply and forward composition", () => {
  it("formats dates, quotes and HTML-only parents like Gmail", () => {
    expect(formatMailDate("Tue, 17 Nov 2026 23:13:00 +0900")).toBe("Tue, Nov 17, 2026 at 11:13 PM");
    expect(formatMailDate("Mon, 16 Nov 2026 00:05:00 -0500 (EST)")).toBe(
      "Mon, Nov 16, 2026 at 12:05 AM",
    );
    expect(formatMailDate("2026-11-17T14:13:00.000Z")).toBe("Tue, Nov 17, 2026 at 2:13 PM UTC");
    expect(formatMailDate("Mon, 16 Nov 2026 10:00:00 EST")).toBe("Mon, Nov 16, 2026 at 10:00 AM");
    expect(formatMailDate("Mon, 16 Nov 2026 10:00:00 GMT")).toBe("Mon, Nov 16, 2026 at 10:00 AM");
    expect(formatMailDate("not a date")).toBeNull();
    expect(quoteLines("a\n\n> b\n")).toBe("> a\n>\n>> b");
    expect(
      htmlToText(
        "<html><head><style>p{}</style></head><body><p>One &amp; two</p><div>Three<br>&#x41;&lt;</div></body></html>",
      ),
    ).toBe("One & two\nThree\nA<");
    expect(
      htmlToText(
        "a<!-- hidden <b> -->b<script>x<y</script>c<br/>&lt;script&gt;<header>d</header><x-y attr='>'>",
      ),
    ).toBe("abc\n<script>d'>");
    expect(htmlToText("Price < 5 and a < b<br>c")).toBe("Price < 5 and a < b\nc");
    expect(htmlToText("<p>İİİİ</p><script>secret</script>visible")).toBe("İİİİ\nvisible");
  });

  it("quotes the parent below the reply, prefixes Re: and archives the composed message", async () => {
    await seedParent();
    const { ctx, send } = context();
    const result = await sendMail(ctx, principal, reply, "quoted-reply");
    const message = sent(send);
    expect(message.subject).toBe("Re: Synthetic parent");
    expect(message.text).toBe(
      `Reply body\n\n${attribution}\n\n> First line\n>\n>> earlier quote\n> Last line\n`,
    );
    expect(message.html).toBe(
      `<p>Reply body</p><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution.replace(/</g, "&lt;").replace(/>/g, "&gt;")}<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">First line<br>\n<br>\n&gt; earlier quote<br>\nLast line</blockquote></div>`,
    );
    expect(message.attachments).toEqual([]);
    const archived = await getSentMail(ctx, principal, result.operation_id);
    expect(archived.input.subject).toBe(message.subject);
    expect(archived.input.payload.text).toBe(message.text);
    expect(archived.input.payload.html).toBe(message.html);
  });

  it("keeps an explicit Re: subject, quotes only parts the author wrote and inserts before </body>", async () => {
    await seedParent();
    const { ctx, send } = context();
    await sendMail(
      ctx,
      principal,
      { ...reply, subject: "RE: Kept", payload: { html: "<html><body><p>Hi</p></body></html>" } },
      "html-only",
    );
    const message = sent(send);
    expect(message.subject).toBe("RE: Kept");
    expect(message.text).toBeUndefined();
    expect(message.html).toMatch(
      /^<html><body><p>Hi<\/p><br><div class="gmail_quote">.*<\/div><\/body><\/html>$/s,
    );
  });

  it("prefixes only a prefilled subject and keeps one the caller changed", async () => {
    await seedParent();
    const { ctx, send } = context();
    await sendMail(ctx, principal, { ...reply, subject: "Synthetic parent" }, "same-subject");
    expect(sent(send).subject).toBe("Re: Synthetic parent");
    await sendMail(ctx, principal, { ...reply, subject: "Project update" }, "changed-subject");
    expect(sent(send, 1).subject).toBe("Project update");
  });

  it("escapes hostile parent headers and markup into the HTML quote", async () => {
    await seedParent({ text: '<script>alert(1)</script>\n"><img src=x>', html: null }, [], {
      from: { name: '"><img src=x onerror=alert(1)>', address: "evil@example.invalid" },
      subject: "Hi\r\nBcc: victim@example.invalid",
    });
    const { ctx, send } = context();
    await sendMail(ctx, principal, reply, "hostile");
    const message = sent(send);
    expect(message.subject).toBe("Re: Hi Bcc: victim@example.invalid");
    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(message.html).toContain(
      "&lt;img src=x onerror=alert(1)&gt; &lt;evil@example.invalid&gt;",
    );
    expect(message.bcc).toEqual([]);
    expect(message.headers).toEqual({
      "In-Reply-To": "<parent@example.invalid>",
      References: "<parent@example.invalid>",
    });
  });

  it("adds no attribution when the parent has no text", async () => {
    await seedParent({ text: "\n \n", html: null });
    const { ctx, send } = context();
    await sendMail(ctx, principal, reply, "empty-parent");
    expect(sent(send).text).toBe("Reply body");
  });

  it("stays linear on long newline and whitespace runs", async () => {
    await seedParent({
      text: `${"\n".repeat(OUTBOUND_LIMITS.bodyBytes)}x${"\n".repeat(100_000)}`,
      html: null,
    });
    const { ctx, send } = context();
    const started = Date.now();
    await sendMail(ctx, principal, { ...reply, payload: { text: "Reply body" } }, "newlines");
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions").run();
    await seedParent({ text: null, html: `<p>${" ".repeat(200_000)}x${" ".repeat(200_000)}<!--` });
    await sendMail(ctx, principal, { ...reply, payload: { text: "Reply body" } }, "spaces");
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions").run();
    await seedParent(undefined, [], {});
    await forwardMail(
      ctx,
      principal,
      rawKey,
      { ...reply, reply_message_id: undefined, payload: { text: "\n".repeat(200_000) } },
      "forward-newlines",
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("matches a same-key retry on the caller's request, before composing", async () => {
    await seedParent(undefined, [
      { filename: "notes.txt", mimeType: "text/plain", content: encoder.encode("synthetic") },
    ]);
    const { ctx, send } = context();
    const first = await sendMail(ctx, principal, reply, "retry");
    // The parent body becoming unreadable cannot strand a retry of a settled operation.
    await env.MAIL_ARCHIVE.delete(
      (await env.MAIL_ARCHIVE.list({ prefix: `${prefix}/body-json/` })).objects.map((o) => o.key),
    );
    const retry = await sendMail(ctx, principal, reply, "retry");
    expect(retry.operation_id).toBe(first.operation_id);
    await expect(
      sendMail(ctx, principal, { ...reply, include_attachments: true }, "retry"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resumes a prepared reply from its archived message without recomposing", async () => {
    await seedParent();
    const { ctx, send } = context();
    const session = env.MAIL_CATALOG.withSession("first-primary");
    let batches = 0;
    const interrupted = {
      ...ctx,
      MAIL_CATALOG: {
        withSession: () => ({
          prepare: session.prepare.bind(session),
          batch: async (statements: D1PreparedStatement[]) => {
            batches++;
            if (batches === 2) throw new Error("synthetic preclaim crash");
            return session.batch(statements);
          },
        }),
      } as unknown as D1Database,
    };
    await expect(sendMail(interrupted, principal, reply, "prepared-reply")).rejects.toThrow();
    // Composition would now fail; the archived message is what gets sent.
    await env.MAIL_ARCHIVE.delete(
      (await env.MAIL_ARCHIVE.list({ prefix: `${prefix}/body-json/` })).objects.map((o) => o.key),
    );
    const resumed = await sendMail(ctx, principal, reply, "prepared-reply");
    expect(resumed.state).toBe("accepted");
    expect(sent(send).text).toContain(`${attribution}\n\n> First line`);
  });

  it("matches operations from before request_hash on their original digest", async () => {
    const { ctx, send } = context();
    const plain = {
      from_address: "sender@example.invalid",
      to: ["recipient@example.invalid"],
      subject: "Plain",
      payload: { text: "Plain body" },
    };
    const first = await sendMail(ctx, principal, plain, "legacy");
    await env.MAIL_CATALOG.prepare("UPDATE outbound_operations SET request_hash = NULL").run();
    expect((await sendMail(ctx, principal, plain, "legacy")).operation_id).toBe(first.operation_id);
    await expect(
      sendMail(ctx, principal, { ...plain, subject: "Changed" }, "legacy"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("quotes a reply draft exactly once through update and send", async () => {
    await seedParent();
    const { ctx, send } = context();
    const draft = await createDraft(ctx, principal, reply);
    const updated = await updateDraft(ctx, principal, draft.draft_id, 1, {
      ...draft.input,
      payload: { text: "Edited reply" },
    });
    expect(updated.input.payload.text).toBe("Edited reply");
    await sendDraft(ctx, principal, draft.draft_id, 2, "draft-send");
    expect(sent(send).text).toBe(
      `Edited reply\n\n${attribution}\n\n> First line\n>\n>> earlier quote\n> Last line\n`,
    );
  });

  it("sends without the quote when quote is false and never reads the parent body", async () => {
    await seedParent();
    await env.MAIL_ARCHIVE.delete(
      (await env.MAIL_ARCHIVE.list({ prefix: `${prefix}/body-json/` })).objects.map((o) => o.key),
    );
    const { ctx, send } = context();
    await sendMail(ctx, principal, { ...reply, quote: false }, "unquoted");
    expect(sent(send).text).toBe("Reply body");
    expect(sent(send).subject).toBe("Re: Synthetic parent");
    await expect(sendMail(ctx, principal, reply, "quoted-missing")).rejects.toMatchObject({
      code: "original_unavailable",
    });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      previewMail(ctx, principal, { ...reply, reply_message_id: undefined, quote: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("stores the author's own draft text and composes the quote at preview and send", async () => {
    await seedParent();
    const { ctx } = context();
    const draft = await createDraft(ctx, principal, reply);
    expect(draft.input.payload.text).toBe("Reply body");
    expect(draft.input.subject).toBe("");
    const preview = await previewMail(ctx, principal, reply);
    expect(preview.input.payload.text).toContain(`${attribution}\n\n> First line`);
  });

  it("quotes an HTML-only parent through its text rendering", async () => {
    await seedParent({ text: null, html: "<p>Rendered <b>parent</b></p><p>Second</p>" });
    const { ctx, send } = context();
    await sendMail(ctx, principal, { ...reply, payload: { text: "Reply body" } }, "html-parent");
    expect(sent(send).text).toBe(`Reply body\n\n${attribution}\n\n> Rendered parent\n> Second\n`);
  });

  it("truncates only the quoted original to fit the body limit", async () => {
    await seedParent({ text: `${"x".repeat(100)}\n`.repeat(4000), html: null });
    const { ctx, send } = context();
    const author = "Author text is never shortened";
    await sendMail(ctx, principal, { ...reply, payload: { text: author } }, "long-parent");
    const text = sent(send).text ?? "";
    expect(text.startsWith(`${author}\n\n${attribution}\n\n> xxx`)).toBe(true);
    expect(text.endsWith(`\n> ${QUOTE_TRUNCATED}\n`)).toBe(true);
    expect(encoder.encode(text).byteLength).toBeLessThanOrEqual(OUTBOUND_LIMITS.bodyBytes);
    expect(encoder.encode(text).byteLength).toBeGreaterThan(OUTBOUND_LIMITS.bodyBytes - 200);
  });

  it("attaches the parent's attachments to a reply only when asked", async () => {
    const content = encoder.encode("synthetic reply attachment");
    await seedParent(undefined, [{ filename: "notes.txt", mimeType: "text/plain", content }]);
    const { ctx, send } = context();
    await sendMail(ctx, principal, reply, "reply-default");
    expect(sent(send).attachments).toEqual([]);
    await sendMail(ctx, principal, { ...reply, include_attachments: true }, "reply-attached");
    expect(sent(send, 1).attachments).toHaveLength(1);
    expect(sent(send, 1).attachments?.[0]).toMatchObject({ filename: "notes.txt" });
    expect(new Uint8Array(sent(send, 1).attachments?.[0]?.content as ArrayBuffer)).toEqual(content);
    const draft = await createDraft(ctx, principal, { ...reply, include_attachments: true });
    expect(draft.input.include_attachments).toBe(true);
    expect(draft.input.payload.attachments).toEqual([]);
    const { reply_message_id: _parent, ...newMail } = reply;
    await expect(
      previewMail(ctx, principal, { ...newMail, include_attachments: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("forwards Gmail-style with the original attachments", async () => {
    const content = encoder.encode("synthetic report");
    await seedParent(undefined, [{ filename: "dir/report.txt", mimeType: "text/plain", content }]);
    const { ctx, send } = context();
    const forward = {
      from_address: "sender@example.invalid",
      to: ["next@example.invalid"],
      subject: "",
      payload: {},
    };
    const result = await forwardMail(ctx, principal, rawKey, forward, "forward");
    const message = sent(send);
    expect(message.subject).toBe("Fwd: Synthetic parent");
    expect(message.text).toBe(
      [
        FORWARD_SEPARATOR,
        "From: Parent Sender <parent@example.invalid>",
        "Date: Tue, Nov 17, 2026 at 11:13 PM",
        "Subject: Synthetic parent",
        "To: <owner@example.invalid>",
        "Cc: Copied <copied@example.invalid>",
        "",
        "First line",
        "",
        "> earlier quote",
        "Last line",
        "",
      ].join("\n"),
    );
    expect(message.text).not.toContain("hidden@example.invalid");
    expect(message.html).toBeUndefined();
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]).toMatchObject({
      filename: "dir_report.txt",
      type: "text/plain",
      disposition: "attachment",
    });
    expect(new Uint8Array(message.attachments?.[0]?.content as ArrayBuffer)).toEqual(content);
    const archived = await getSentMail(ctx, principal, result.operation_id);
    expect(archived.input.payload.attachments).toEqual([
      {
        attachment_id: "part_0",
        sha256: await sha256(content),
        size: content.byteLength,
        filename: "dir_report.txt",
        content_type: "text/plain",
      },
    ]);
    await forwardMail(
      ctx,
      principal,
      rawKey,
      { ...forward, subject: "Fw: kept", payload: { text: "FYI" }, include_attachments: false },
      "forward-without-attachments",
    );
    expect(sent(send, 1).subject).toBe("Fw: kept");
    expect(sent(send, 1).text?.startsWith(`FYI\n\n${FORWARD_SEPARATOR}\n`)).toBe(true);
    expect(sent(send, 1).attachments).toEqual([]);
  });

  it("rejects forwards that exceed body or attachment limits instead of shortening them", async () => {
    const { ctx, send } = context();
    const forward = {
      from_address: "sender@example.invalid",
      to: ["next@example.invalid"],
      subject: "",
      payload: {},
    };
    await seedParent({ text: "x".repeat(OUTBOUND_LIMITS.bodyBytes), html: null });
    await expect(forwardMail(ctx, principal, rawKey, forward, "too-long")).rejects.toMatchObject({
      code: "forward_too_large",
    });
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions").run();
    await seedParent(
      undefined,
      Array.from({ length: OUTBOUND_LIMITS.attachments + 1 }, (_, index) => ({
        filename: `part-${index}.txt`,
        mimeType: "text/plain",
        content: encoder.encode(`attachment ${index}`),
      })),
    );
    await expect(forwardMail(ctx, principal, rawKey, forward, "too-many")).rejects.toMatchObject({
      code: "original_attachments_too_large",
    });
    await expect(
      forwardMail(ctx, principal, rawKey, { ...forward, quote: true }, "quoted-forward"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(send).not.toHaveBeenCalled();
    await forwardMail(
      ctx,
      principal,
      rawKey,
      { ...forward, include_attachments: false },
      "too-many-dropped",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
