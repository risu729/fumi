import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraft,
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
      VALUES (?,'mime-v1',?,1,'synthetic','complete',?,'[]','synthetic-body','synthetic-manifest',0)`)
      .bind(
        rawKey,
        "0".repeat(64),
        JSON.stringify({
          messageId: "<parent@example.invalid>",
          references: "<ancestor@example.invalid>",
        }),
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
      VALUES (?,'mime-v1',?,1,'synthetic','complete',?,'[]','synthetic-body','synthetic-manifest',0)`)
      .bind(
        rawKey,
        sha,
        JSON.stringify({
          messageId: "<parent@example.invalid>",
          to: [{ address: "forged@other.invalid" }],
        }),
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
