import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INLINE_ATTACHMENT_BASE64_CHARACTERS,
  OUTBOUND_LIMITS,
  createDraft,
  encodedMessageEstimate,
  getDraft,
  getSendStatus,
  getSentMail,
  listDrafts,
  listSentMail,
  previewMail,
  sendDraft,
  sendMail,
  updateDraft,
  uploadAttachment,
} from "../src/outbound.ts";
import type { MailInput, OutboundContext } from "../src/outbound.ts";
import { applyProviderEvent, reconcileProviderEvents } from "../src/outbound-events.ts";
import worker from "../src/index.ts";

const principal = {
  id: "synthetic-owner",
  scopes: ["mail:read", "mail:draft", "mail:send"],
  fromAddresses: ["sender@example.invalid"],
};
const input: MailInput = {
  from_address: "sender@example.invalid",
  to: ["recipient@example.invalid"],
  subject: "Synthetic subject",
  payload: { text: "Synthetic body" },
};

function context(
  send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => ({
    messageId: "synthetic-provider-id",
  })),
) {
  return {
    ctx: {
      MAIL_CATALOG: env.MAIL_CATALOG,
      MAIL_ARCHIVE: env.MAIL_ARCHIVE,
      EMAIL: { send },
    } as OutboundContext,
    send,
  };
}

function event(
  state: string,
  id = crypto.randomUUID(),
  recipient = input.to[0],
  timestamp = "2026-11-11T00:00:00.000Z",
) {
  return {
    type: `cf.email.sending.message.${state}`,
    source: { type: "email.sending", domain: "example.invalid", zoneId: "synthetic-zone" },
    payload: {
      eventId: id,
      messageId: "synthetic-provider-id",
      sender: input.from_address,
      recipient,
      terminal: state !== "deferred",
      delivery: { status: state },
    },
    metadata: {
      accountId: "synthetic-account",
      eventSubscriptionId: "synthetic-subscription",
      eventSchemaVersion: 1,
      eventTimestamp: timestamp,
    },
  };
}

/** Store a content-addressed extraction body the way MIME extraction does. */
async function storeBody(text: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({ text, html: null }));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const key = `ingest/synthetic/body-json/${digest}`;
  await env.MAIL_ARCHIVE.put(key, bytes);
  return key;
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
    ].map((table) => env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`)),
  );
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
});

describe("durable outbound submission in workerd", () => {
  it("checks scopes, sender identity, duplicate recipients and header injection before any send", async () => {
    const { ctx, send } = context();
    await expect(
      sendMail(ctx, { ...principal, scopes: ["mail:read"] }, input, "read-only"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      sendMail(ctx, principal, { ...input, from_address: "other@example.invalid" }, "sender"),
    ).rejects.toMatchObject({ code: "sender_forbidden" });
    await expect(
      sendMail(
        ctx,
        principal,
        { ...input, subject: "bad\r\nBcc: other@example.invalid" },
        "header",
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sendMail(ctx, principal, { ...input, cc: input.to }, "dup")).rejects.toMatchObject(
      { code: "duplicate_recipient" },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("persists immutable input before provider I/O and keeps API ID separate from RFC headers", async () => {
    const { ctx, send } = context(
      vi.fn(async (message) => {
        const operation = await env.MAIL_CATALOG.prepare(
          "SELECT input_key, state FROM outbound_operations",
        ).first<{ input_key: string; state: string }>();
        expect(operation?.state).toBe("submitting");
        expect(await env.MAIL_ARCHIVE.get(operation?.input_key ?? "missing")).not.toBeNull();
        expect((message as EmailMessageBuilder).headers?.["Message-ID"]).toBeUndefined();
        return { messageId: "synthetic-provider-id" };
      }),
    );
    const result = await sendMail(ctx, principal, input, "durable");
    expect(result.state).toBe("accepted");
    expect(result.recipients[0]?.state).toBe("pending");
    expect((await getSentMail(ctx, principal, result.operation_id)).input.payload.text).toBe(
      input.payload.text,
    );
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      getSendStatus(ctx, { ...principal, id: "different-owner" }, result.operation_id),
    ).rejects.toMatchObject({ code: "send_not_found" });
  });

  it("serializes concurrent same-key calls and rejects changed content", async () => {
    const { ctx, send } = context();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sendMail(ctx, principal, input, "concurrent")),
    );
    expect(new Set(results.map((result) => result.operation_id)).size).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(
      sendMail(ctx, principal, { ...input, subject: "Changed" }, "concurrent"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds a lost provider response without automatic resubmission", async () => {
    const { ctx, send } = context(
      vi.fn(async () => {
        throw new Error("synthetic lost response");
      }),
    );
    const result = await sendMail(ctx, principal, input, "lost-response");
    expect(result.state).toBe("unknown");
    expect((await sendMail(ctx, principal, input, "lost-response")).operation_id).toBe(
      result.operation_id,
    );
    expect(send).toHaveBeenCalledTimes(1);
    await env.MAIL_CATALOG.prepare(
      "UPDATE outbound_operations SET state = 'submitting' WHERE operation_id = ?",
    )
      .bind(result.operation_id)
      .run();
    expect((await getSendStatus(ctx, principal, result.operation_id)).state).toBe("unknown");
    await sendMail(ctx, principal, input, "lost-response");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records documented policy rejection without exposing provider text or retrying", async () => {
    const { ctx, send } = context(
      vi.fn(async () => {
        throw Object.assign(new Error("private synthetic provider text"), {
          code: "E_SENDER_NOT_VERIFIED",
        });
      }),
    );
    const rejected = await sendMail(ctx, principal, input, "rejected");
    expect(rejected.state).toBe("rejected");
    expect(rejected.failure_code).toBe("provider_rejected");
    expect(rejected.recipients[0]?.state).toBe("rejected");
    await sendMail(ctx, principal, input, "rejected");
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rejected)).not.toContain("private synthetic");
  });

  it("resumes only an unclaimed prepared operation after a D1 claim failure", async () => {
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
    await expect(sendMail(interrupted, principal, input, "prepared")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(
      await env.MAIL_CATALOG.prepare("SELECT state FROM outbound_operations").first("state"),
    ).toBe("prepared");
    const resumed = await sendMail(ctx, principal, input, "prepared");
    expect(resumed.state).toBe("accepted");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not submit when the R2 outbox write fails", async () => {
    const { ctx, send } = context();
    const broken = {
      ...ctx,
      MAIL_ARCHIVE: {
        get: ctx.MAIL_ARCHIVE.get.bind(ctx.MAIL_ARCHIVE),
        put: async () => {
          throw new Error("synthetic storage failure");
        },
      } as unknown as R2Bucket,
    };
    await expect(sendMail(broken, principal, input, "storage-fail")).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(
      await env.MAIL_CATALOG.prepare("SELECT count(*) n FROM outbound_operations").first("n"),
    ).toBe(0);
  });

  it("checks revisions and submits the exact requested draft snapshot", async () => {
    const { ctx, send } = context();
    const draft = await createDraft(ctx, principal, input);
    const revised = await updateDraft(ctx, principal, draft.draft_id, 1, {
      ...input,
      subject: "Revision two",
    });
    expect(revised.revision).toBe(2);
    await expect(updateDraft(ctx, principal, draft.draft_id, 1, input)).rejects.toMatchObject({
      code: "draft_conflict",
    });
    await expect(sendDraft(ctx, principal, draft.draft_id, 1, "stale")).rejects.toMatchObject({
      code: "draft_conflict",
    });
    await sendDraft(ctx, principal, draft.draft_id, 2, "snapshot");
    expect((send.mock.calls[0]?.[0] as EmailMessageBuilder | undefined)?.subject).toBe(
      "Revision two",
    );
    expect((await getDraft(ctx, principal, draft.draft_id)).revision).toBe(2);
  });

  it("keeps pagination membership fixed while new drafts and sends arrive", async () => {
    const { ctx } = context(vi.fn(async () => ({ messageId: crypto.randomUUID() })));
    await createDraft(ctx, principal, input);
    await createDraft(ctx, principal, input);
    const first = await listDrafts(ctx, principal, { limit: 1 });
    const later = await createDraft(ctx, principal, input);
    const second = await listDrafts(ctx, principal, { limit: 1, cursor: first.next_cursor ?? "" });
    expect(second.drafts).toHaveLength(1);
    expect(second.drafts[0]?.draft_id).not.toBe(later.draft_id);
    expect(second.next_cursor).toBeUndefined();
    await sendMail(ctx, principal, input, "page-1");
    await sendMail(ctx, principal, input, "page-2");
    const sentFirst = await listSentMail(ctx, principal, { limit: 1 });
    const sentLater = await sendMail(ctx, principal, input, "page-3");
    const sentSecond = await listSentMail(ctx, principal, {
      limit: 1,
      cursor: sentFirst.next_cursor ?? "",
    });
    expect(sentSecond.messages[0]?.operation_id).not.toBe(sentLater.operation_id);
    expect(sentSecond.next_cursor).toBeUndefined();
    await expect(listSentMail(ctx, principal, { cursor: "malformed" })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });

  it("resolves reply headers only from stored archive metadata", async () => {
    const { ctx, send } = context();
    const rawKey = "ingest/synthetic/raw.eml";
    await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions (raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,
      metadata_json,attachments_json,body_json_key,manifest_key,updated_at)
      VALUES (?,'mime-v1',?,1,'synthetic','complete',?,'[]',?,'synthetic-manifest',0)`)
      .bind(
        rawKey,
        "0".repeat(64),
        JSON.stringify({
          messageId: "<parent@example.invalid>",
          references: "<ancestor@example.invalid>",
        }),
        await storeBody("Synthetic parent body"),
      )
      .run();
    await sendMail(ctx, principal, { ...input, reply_message_id: rawKey }, "reply");
    expect((send.mock.calls[0]?.[0] as EmailMessageBuilder | undefined)?.headers).toEqual({
      "In-Reply-To": "<parent@example.invalid>",
      References: "<ancestor@example.invalid> <parent@example.invalid>",
    });
    await expect(
      sendMail(
        ctx,
        principal,
        { ...input, headers: { "In-Reply-To": "untrusted" } },
        "injected-reply",
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions WHERE raw_key = ?")
      .bind(rawKey)
      .run();
  });

  it("builds RFC 5322 References from the parent's In-Reply-To and trims long chains", async () => {
    const { ctx, send } = context(vi.fn(async () => ({ messageId: crypto.randomUUID() })));
    const rawKey = "ingest/synthetic/threading.eml";
    const seed = async (metadata: Record<string, unknown>) => {
      await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions WHERE raw_key = ?")
        .bind(rawKey)
        .run();
      await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions (raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,
        metadata_json,attachments_json,body_json_key,manifest_key,updated_at)
        VALUES (?,'mime-v1',?,1,'synthetic','complete',?,'[]',?,'synthetic-manifest',0)`)
        .bind(rawKey, "0".repeat(64), JSON.stringify(metadata), await storeBody("Parent"))
        .run();
    };
    const headers = (call: number) =>
      (send.mock.calls[call]?.[0] as EmailMessageBuilder | undefined)?.headers;
    const replyInput = { ...input, reply_message_id: rawKey, quote: false };

    // RFC 5322 section 3.6.4: without References, a single-ID In-Reply-To starts the chain.
    await seed({ messageId: "<parent@example.invalid>", inReplyTo: "<grand@example.invalid>" });
    await sendMail(ctx, principal, replyInput, "in-reply-to-only");
    expect(headers(0)).toEqual({
      "In-Reply-To": "<parent@example.invalid>",
      References: "<grand@example.invalid> <parent@example.invalid>",
    });

    // A chain over the header bounds keeps the thread root and the newest ancestors.
    const ancestor = (index: number) =>
      `<${String(index).padStart(2, "0")}${"a".repeat(90)}@example.invalid>`;
    const chain = Array.from({ length: 30 }, (_, index) => ancestor(index));
    await seed({ messageId: "<parent@example.invalid>", references: chain.join(" ") });
    await expect(sendMail(ctx, principal, replyInput, "long-chain")).resolves.toMatchObject({
      state: "accepted",
    });
    const references = String(headers(1)?.["References"]).split(" ");
    expect(new TextEncoder().encode(references.join(" ")).byteLength).toBeLessThanOrEqual(2048);
    expect(references[0]).toBe(ancestor(0));
    expect(references.at(-2)).toBe(ancestor(29));
    expect(references.at(-1)).toBe("<parent@example.invalid>");
    expect(references.slice(1, -1)).toEqual(chain.slice(-(references.length - 2)));

    // Short IDs: at most 21 entries, still starting at the root.
    const short = Array.from({ length: 30 }, (_, index) => `<${index}@example.invalid>`);
    await seed({ messageId: "<parent@example.invalid>", references: short.join(" ") });
    await sendMail(ctx, principal, replyInput, "many-ancestors");
    expect(String(headers(2)?.["References"]).split(" ")).toEqual([
      short[0],
      ...short.slice(-19),
      "<parent@example.invalid>",
    ]);

    // A parent without a usable Message-ID is a header problem, not invalid caller input.
    await seed({ references: "<grand@example.invalid>" });
    await expect(sendMail(ctx, principal, replyInput, "no-message-id")).rejects.toMatchObject({
      code: "reply_headers_unavailable",
    });
    expect(send).toHaveBeenCalledTimes(3);
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions WHERE raw_key = ?")
      .bind(rawKey)
      .run();
  });

  it("matches a same-key retry of a reply hashed with the earlier References rule", async () => {
    const { ctx, send } = context(vi.fn(async () => ({ messageId: crypto.randomUUID() })));
    const rawKey = "ingest/synthetic/earlier-rule.eml";
    const replyInput = { ...input, reply_message_id: rawKey, quote: false };
    const ids = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => `<${from + index}@example.invalid>`).join(
        " ",
      );
    const cases = [
      // Before 2026-11-20 a parent's single In-Reply-To was ignored without References...
      [{}, { inReplyTo: "<grand@example.invalid>" }],
      // ...and only the newest 20 References were kept, dropping the thread root.
      [{ references: ids(5, 25) }, { references: ids(0, 25) }],
    ] as const;
    for (const [index, [earlier, stored]] of cases.entries()) {
      const parent = { messageId: "<parent@example.invalid>" };
      // The current rule over `earlier` yields what the earlier rule built from `stored`.
      // oxlint-disable-next-line no-await-in-loop -- Each case reseeds the same parent row.
      await env.MAIL_CATALOG.prepare(`INSERT OR REPLACE INTO mail_extractions (raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,
        metadata_json,attachments_json,body_json_key,manifest_key,updated_at)
        VALUES (?,'mime-v1',?,1,'synthetic','complete',?,'[]',?,'synthetic-manifest',0)`)
        .bind(
          rawKey,
          "0".repeat(64),
          JSON.stringify({ ...parent, ...earlier }),
          // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic setup.
          await storeBody("Parent"),
        )
        .run();
      // oxlint-disable-next-line no-await-in-loop -- The retry must follow the first send.
      const first = await sendMail(ctx, principal, replyInput, `earlier-rule-${index}`);
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic setup.
      await env.MAIL_CATALOG.prepare(
        "UPDATE mail_extractions SET metadata_json = ? WHERE raw_key = ?",
      )
        .bind(JSON.stringify({ ...parent, ...stored }), rawKey)
        .run();
      // oxlint-disable-next-line no-await-in-loop -- The retry must follow the first send.
      await expect(
        sendMail(ctx, principal, replyInput, `earlier-rule-${index}`),
      ).resolves.toMatchObject({ operation_id: first.operation_id, state: "accepted" });
      // Rows from before request_hash compare input_hash, the digest of the uncomposed
      // input; this reply composes to its own input, so the archived digest stands in.
      // oxlint-disable-next-line no-await-in-loop -- Sequential synthetic setup.
      await env.MAIL_CATALOG.prepare(
        "UPDATE outbound_operations SET request_hash = NULL WHERE operation_id = ?",
      )
        .bind(first.operation_id)
        .run();
      // oxlint-disable-next-line no-await-in-loop -- The retry must follow the first send.
      await expect(
        sendMail(ctx, principal, replyInput, `earlier-rule-${index}`),
      ).resolves.toMatchObject({ operation_id: first.operation_id, state: "accepted" });
      // A different request under the same key is still a conflict.
      // oxlint-disable-next-line no-await-in-loop -- The retry must follow the first send.
      await expect(
        sendMail(ctx, principal, { ...replyInput, subject: "Other" }, `earlier-rule-${index}`),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
    expect(send).toHaveBeenCalledTimes(2);
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions WHERE raw_key = ?")
      .bind(rawKey)
      .run();
  });

  it("allows configured sender domains exactly and defaults replies from the captured envelope", async () => {
    const { ctx, send } = context(vi.fn(async () => ({ messageId: crypto.randomUUID() })));
    const domainPrincipal = { ...principal, fromAddresses: [], fromDomains: ["example.invalid"] };
    await sendMail(
      ctx,
      domainPrincipal,
      {
        ...input,
        from_address: "custom.local+tag@example.invalid",
        reply_to: "reply@example.invalid",
      },
      "custom-sender",
    );
    expect((send.mock.calls[0]?.[0] as EmailMessageBuilder | undefined)?.from).toBe(
      "custom.local+tag@example.invalid",
    );
    expect((send.mock.calls[0]?.[0] as EmailMessageBuilder | undefined)?.replyTo).toBe(
      "reply@example.invalid",
    );
    await expect(
      sendMail(
        ctx,
        domainPrincipal,
        { ...input, from_address: "sender@sub.example.invalid" },
        "subdomain",
      ),
    ).rejects.toMatchObject({ code: "sender_forbidden" });
    await expect(
      sendMail(
        ctx,
        domainPrincipal,
        { ...input, from_address: "sender@example.invalid.evil" },
        "suffix",
      ),
    ).rejects.toMatchObject({ code: "sender_forbidden" });
    const noSender = { to: input.to, subject: input.subject, payload: input.payload };
    await expect(sendMail(ctx, domainPrincipal, noSender, "new-missing")).rejects.toMatchObject({
      code: "from_address_required",
    });
    const rawKey = "ingest/synthetic-envelope/raw.eml";
    const sha = "0".repeat(64);
    const receipt = {
      schemaVersion: 1,
      ingestId: "synthetic-envelope",
      receivedAt: "2026-11-11T00:00:00Z",
      envelope: { from: "origin@example.invalid", to: "captured@example.invalid" },
      reportedRawSize: 1,
      archive: { status: "stored", key: rawKey, size: 1, sha256: sha },
      forward: { status: "forwarded" },
    };
    await env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions (raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,
      metadata_json,attachments_json,body_json_key,manifest_key,updated_at)
      VALUES (?,'mime-v1',?,1,'synthetic','complete',?,'[]',?,'synthetic-manifest',0)`)
      .bind(
        rawKey,
        sha,
        JSON.stringify({
          messageId: "<parent@example.invalid>",
          to: [{ address: "forged@other.invalid" }],
        }),
        await storeBody("Synthetic parent body"),
      )
      .run();
    await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,
      receipt_snapshot,forward_status,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision)
      VALUES ('email_routing','ingress-v1','synthetic-envelope',?,? ,?,'forwarded','present','valid',?,0,0)`)
      .bind(rawKey, "ingest/synthetic-envelope/receipt.json", JSON.stringify(receipt), sha)
      .run();
    await sendMail(
      ctx,
      domainPrincipal,
      { ...noSender, reply_message_id: rawKey },
      "default-reply",
    );
    expect((send.mock.calls[1]?.[0] as EmailMessageBuilder | undefined)?.from).toBe(
      "captured@example.invalid",
    );
    await sendMail(
      ctx,
      domainPrincipal,
      { ...noSender, reply_message_id: rawKey, from_address: "override@example.invalid" },
      "override-reply",
    );
    expect((send.mock.calls[2]?.[0] as EmailMessageBuilder | undefined)?.from).toBe(
      "override@example.invalid",
    );
    await env.MAIL_CATALOG.prepare("DELETE FROM archive_sources WHERE raw_key = ?")
      .bind(rawKey)
      .run();
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions WHERE raw_key = ?")
      .bind(rawKey)
      .run();
  });

  it("binds attachment bytes/hash/owner and detects storage mutation", async () => {
    const { ctx, send } = context();
    const attachment = await uploadAttachment(ctx, principal, {
      filename: "synthetic.txt",
      content_type: "text/plain",
      content_base64: btoa("synthetic attachment"),
    });
    const attached = {
      ...input,
      payload: {
        text: "Body",
        attachments: [{ attachment_id: attachment.attachment_id, sha256: attachment.sha256 }],
      },
    };
    await expect(
      previewMail(ctx, { ...principal, id: "other-owner" }, attached),
    ).rejects.toMatchObject({ code: "attachment_not_found" });
    await ctx.MAIL_ARCHIVE.put(`outbound/attachments/${attachment.attachment_id}`, "modified");
    await expect(sendMail(ctx, principal, attached, "mutated")).rejects.toMatchObject({
      code: "attachment_unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("enforces the attachment limits on upload and per message", async () => {
    const { ctx, send } = context();
    const upload = (content_base64: string) =>
      uploadAttachment(ctx, principal, {
        filename: "synthetic.bin",
        content_type: "application/octet-stream",
        content_base64,
      });
    // Zero bytes: 4 * 3,495,253 characters hold 10 MiB - 1 bytes, and the last group
    // adds one byte (AA==) or two (AAA=).
    const full = "A".repeat(4 * 3_495_253);
    const atLimit = await upload(`${full}AA==`);
    expect(atLimit.size).toBe(OUTBOUND_LIMITS.inlineAttachmentBytes);
    await expect(upload(`${full}AAA=`)).rejects.toMatchObject({ code: "attachment_limit" });
    await expect(upload(`${full}AAAA`)).rejects.toMatchObject({ code: "attachment_limit" });
    // `base64` output: CRLF (or LF) every 76 characters and a final newline.
    const wrapped = `${full}AA==`.replace(/.{76}/g, "$&\r\n");
    expect(wrapped.length).toBeLessThanOrEqual(INLINE_ATTACHMENT_BASE64_CHARACTERS);
    await expect(upload(`${wrapped}\n`)).resolves.toMatchObject({ sha256: atLimit.sha256 });
    await expect(upload("A".repeat(INLINE_ATTACHMENT_BASE64_CHARACTERS + 1))).rejects.toMatchObject(
      { code: "attachment_limit" },
    );
    await expect(upload("AA")).resolves.toMatchObject({ size: 1 });
    await expect(upload("not base64!")).rejects.toMatchObject({ code: "invalid_attachment" });
    await expect(upload("A")).rejects.toMatchObject({ code: "invalid_attachment" });
    await expect(upload("")).rejects.toMatchObject({ code: "attachment_limit" });
    const reference = ({ attachment_id, sha256 }: { attachment_id: string; sha256: string }) => ({
      attachment_id,
      sha256,
    });
    const withAttachments = (attachments: { attachment_id: string; sha256: string }[]) => ({
      ...input,
      payload: { text: "Body", attachments: attachments.map(reference) },
    });
    // 10 MiB + 6 MiB is exactly the 16 MiB per-message total; one more byte is over.
    const six = await upload("A".repeat(8_388_608));
    const sixAndOne = await upload(`${"A".repeat(8_388_608)}AA==`);
    await expect(
      previewMail(ctx, principal, withAttachments([atLimit, six])),
    ).resolves.toMatchObject({ submitted: false });
    await expect(
      previewMail(ctx, principal, withAttachments([atLimit, sixAndOne])),
    ).rejects.toMatchObject({ code: "attachment_limit" });
    await expect(
      sendMail(ctx, principal, withAttachments([atLimit, sixAndOne]), "over-total"),
    ).rejects.toMatchObject({ code: "attachment_limit" });
    const small = await upload(btoa("synthetic"));
    await expect(
      previewMail(ctx, principal, withAttachments(Array.from({ length: 9 }, () => small))),
    ).rejects.toMatchObject({ code: "invalid_attachments" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a message over the encoded-size cap before the provider sees it", async () => {
    const { ctx, send } = context();
    const limits = OUTBOUND_LIMITS as { encodedMessageBytes: number };
    const original = limits.encodedMessageBytes;
    // No message within the other limits reaches 24 MiB, so lower the cap.
    limits.encodedMessageBytes = 1024;
    try {
      const long = { ...input, payload: { text: "x".repeat(2048) } };
      await expect(previewMail(ctx, principal, long)).rejects.toMatchObject({
        code: "message_too_large",
      });
      await expect(sendMail(ctx, principal, long, "too-large")).rejects.toMatchObject({
        code: "message_too_large",
      });
      const draft = await createDraft(ctx, principal, long);
      await expect(
        sendDraft(ctx, principal, draft.draft_id, draft.revision, "too-large-draft"),
      ).rejects.toMatchObject({ code: "message_too_large" });
    } finally {
      limits.encodedMessageBytes = original;
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the largest allowed message under the encoded-size cap", () => {
    // 254 bytes: a 64-byte local part and a 189-byte domain.
    const longAddress = (index: number) =>
      `${"r".repeat(61)}${String(index).padStart(3, "0")}@${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(53)}.invalid`;
    const attachment = (size: number) => ({
      attachment_id: "att_synthetic",
      sha256: "0".repeat(64),
      size,
      filename: "\u00e9".repeat(100),
      content_type: "application/octet-stream",
      object_key: "outbound/attachments/att_synthetic",
    });
    const largest = (attachmentSizes: number[]) => ({
      to: Array.from({ length: OUTBOUND_LIMITS.recipients - 1 }, (_, index) => longAddress(index)),
      cc: [],
      bcc: [longAddress(99)],
      from_address: "sender@example.invalid",
      subject: "\u3042".repeat(332),
      payload: {
        text: "=".repeat(OUTBOUND_LIMITS.bodyBytes / 2),
        html: "=".repeat(OUTBOUND_LIMITS.bodyBytes / 2),
        attachments: attachmentSizes.map(attachment),
      },
      reply_to: longAddress(100),
      headers: { "In-Reply-To": `<${"m".repeat(990)}@x>`, References: "<r@x> ".repeat(340) },
    });
    const eighth = OUTBOUND_LIMITS.totalAttachmentBytes / OUTBOUND_LIMITS.attachments;
    expect(encodedMessageEstimate(largest(Array.from({ length: 8 }, () => eighth)))).toBeLessThan(
      OUTBOUND_LIMITS.encodedMessageBytes,
    );
    // 18 MiB of attachments, the rejected alternative, does not fit.
    expect(
      encodedMessageEstimate(largest(Array.from({ length: 8 }, () => (eighth * 18) / 16))),
    ).toBeGreaterThan(OUTBOUND_LIMITS.encodedMessageBytes);
  });

  it("retains early unmapped provider events and projects mixed recipients without regressions", async () => {
    const { ctx } = context();
    const delivered = event("delivered");
    await applyProviderEvent(ctx, delivered);
    const sent = await sendMail(
      ctx,
      principal,
      { ...input, cc: ["second@example.invalid"] },
      "mixed",
    );
    await reconcileProviderEvents(ctx);
    await applyProviderEvent(
      ctx,
      event("deferred", crypto.randomUUID(), input.to[0], "2026-11-11T00:01:00Z"),
    );
    await applyProviderEvent(ctx, event("bounced", crypto.randomUUID(), "second@example.invalid"));
    await applyProviderEvent(ctx, delivered);
    const result = await getSendStatus(ctx, principal, sent.operation_id);
    expect(result.recipients.find((recipient) => recipient.kind === "to")?.state).toBe("delivered");
    expect(result.recipients.find((recipient) => recipient.kind === "cc")?.state).toBe("bounced");
    expect(
      await env.MAIL_CATALOG.prepare("SELECT count(*) n FROM outbound_provider_events").first("n"),
    ).toBe(3);
    await expect(
      applyProviderEvent(ctx, { ...delivered, type: "untrusted" }),
    ).rejects.toMatchObject({ code: "invalid_provider_event" });
  });

  it("holds receipt write failures and reconciles unknown from trustworthy delivery evidence", async () => {
    const { ctx, send } = context();
    const realPut = ctx.MAIL_ARCHIVE.put.bind(ctx.MAIL_ARCHIVE);
    const bucket = {
      get: ctx.MAIL_ARCHIVE.get.bind(ctx.MAIL_ARCHIVE),
      put: async (key: string, value: string, options: R2PutOptions) => {
        if (key.endsWith("receipt.json")) throw new Error("synthetic receipt failure");
        return realPut(key, value, options);
      },
    } as unknown as R2Bucket;
    const result = await sendMail(
      { ...ctx, MAIL_ARCHIVE: bucket },
      principal,
      input,
      "receipt-failure",
    );
    expect(result.state).toBe("unknown");
    expect(result.provider_message_id).toBe("synthetic-provider-id");
    await applyProviderEvent(ctx, event("delivered"));
    expect((await getSendStatus(ctx, principal, result.operation_id)).state).toBe("accepted");
    await sendMail(ctx, principal, input, "receipt-failure");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads send status as one snapshot while an event projects between reads", async () => {
    const { ctx } = context();
    const bucket = {
      get: ctx.MAIL_ARCHIVE.get.bind(ctx.MAIL_ARCHIVE),
      put: async (key: string, value: string, options: R2PutOptions) => {
        if (key.endsWith("receipt.json")) throw new Error("synthetic receipt failure");
        return ctx.MAIL_ARCHIVE.put(key, value, options);
      },
    } as unknown as R2Bucket;
    const sent = await sendMail({ ...ctx, MAIL_ARCHIVE: bucket }, principal, input, "snapshot");
    expect(sent.state).toBe("unknown");
    const session = env.MAIL_CATALOG.withSession("first-primary");
    let projected = false;
    // A delivery event projects right after the operation row is read, before
    // anything else the status read does.
    const project = async () => {
      if (projected) return;
      projected = true;
      await applyProviderEvent(ctx, event("delivered"));
    };
    const racing = {
      ...ctx,
      MAIL_CATALOG: {
        withSession: () => ({
          prepare: (query: string) => {
            const statement = session.prepare(query);
            if (!query.startsWith("SELECT * FROM outbound_operations")) return statement;
            return {
              bind: (...values: unknown[]) => {
                const bound = statement.bind(...values);
                const first = bound.first.bind(bound);
                Object.assign(bound, {
                  first: async (...args: []) => {
                    const row = await first(...args);
                    await project();
                    return row;
                  },
                });
                return bound;
              },
            } as unknown as D1PreparedStatement;
          },
          batch: async (statements: D1PreparedStatement[]) => {
            const results = await session.batch(statements);
            await project();
            return results;
          },
        }),
      } as unknown as D1Database,
    };
    const status = await getSendStatus(racing, principal, sent.operation_id);
    expect(projected).toBe(true);
    expect({ state: status.state, recipients: status.recipients.map((r) => r.state) }).toEqual({
      state: "unknown",
      recipients: ["pending"],
    });
    const settled = await getSendStatus(ctx, principal, sent.operation_id);
    expect({ state: settled.state, recipients: settled.recipients.map((r) => r.state) }).toEqual({
      state: "accepted",
      recipients: ["delivered"],
    });
  });

  it("retries a delivery event with a bounded backoff from its attempt count", async () => {
    const outage = vi.spyOn(env.MAIL_CATALOG, "withSession").mockImplementation(() => {
      throw new Error("synthetic D1 outage for recipient@example.invalid");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const messages = [1, 2, 3, 4, 5, 6, 40].map((attempts) => ({
      id: `synthetic-message-${attempts}`,
      timestamp: new Date(),
      body: event("delivered"),
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    try {
      await worker.queue(
        {
          queue: "fumi-delivery-events",
          messages,
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        } as unknown as MessageBatch,
        env,
      );
      expect(messages.map((message) => message.ack.mock.calls.length)).toEqual([
        0, 0, 0, 0, 0, 0, 0,
      ]);
      expect(messages.map((message) => message.retry.mock.calls)).toEqual(
        [30, 60, 120, 240, 480, 900, 900].map((delaySeconds) => [[{ delaySeconds }]]),
      );
      expect(errors.mock.calls).toEqual(
        messages.map(() => [JSON.stringify({ event: "delivery_event", status: "deferred" })]),
      );
    } finally {
      outage.mockRestore();
      errors.mockRestore();
    }
  });

  it("recovers the R2 acceptance receipt when post-send D1 writes fail", async () => {
    const { ctx, send } = context();
    const session = env.MAIL_CATALOG.withSession("first-primary");
    let providerReturned = false;
    let unavailable = true;
    const unreliable = {
      ...ctx,
      EMAIL: {
        send: async (message: EmailMessage | EmailMessageBuilder) => {
          const result = await send(message);
          providerReturned = true;
          return result;
        },
      },
      MAIL_CATALOG: {
        withSession: () => ({
          prepare: (query: string) => {
            const statement = session.prepare(query);
            if (
              providerReturned &&
              unavailable &&
              query.startsWith("UPDATE outbound_operations SET provider_message_id")
            ) {
              return {
                bind: () => ({
                  run: async () => {
                    throw new Error("synthetic post-send D1 failure");
                  },
                }),
              } as unknown as D1PreparedStatement;
            }
            return statement;
          },
          batch: async (statements: D1PreparedStatement[]) => {
            if (providerReturned && unavailable) throw new Error("synthetic post-send D1 failure");
            return session.batch(statements);
          },
        }),
      } as unknown as D1Database,
    };
    await expect(sendMail(unreliable, principal, input, "d1-after-send")).rejects.toThrow();
    const operation = await env.MAIL_CATALOG.prepare(
      "SELECT operation_id,receipt_key FROM outbound_operations",
    ).first<{ operation_id: string; receipt_key: string }>();
    expect(operation).not.toBeNull();
    expect(await env.MAIL_ARCHIVE.get(operation?.receipt_key ?? "missing")).not.toBeNull();
    unavailable = false;
    await reconcileProviderEvents(ctx);
    expect((await getSendStatus(ctx, principal, operation?.operation_id ?? "missing")).state).toBe(
      "accepted",
    );
    await sendMail(ctx, principal, input, "d1-after-send");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
