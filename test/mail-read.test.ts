import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readMail,
  readMailAttachment,
  readMailResource,
  readMailThread,
  searchMail,
} from "../src/mail-read.ts";
import type { MailPrincipal } from "../src/principal.ts";

const principal: MailPrincipal = {
  id: "synthetic-reader",
  scopes: ["mail:read"],
  fromAddresses: [],
};
async function insert(
  id: string,
  date: string,
  metadata: Record<string, unknown> | null = { subject: "Synthetic mail" },
  reply?: string,
) {
  const key = `ingest/2026-11-11/${id}/raw.eml`;
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,observed_pass,observed_revision) VALUES ('email_routing','ingress-v1',?,?,?,?,'present','missing',0,0)`,
  )
    .bind(id, key, `${key}.receipt`, date)
    .run();
  if (metadata) {
    await env.MAIL_ARCHIVE.put(
      `synthetic/body/${id}`,
      JSON.stringify({ text: "x".repeat(20_000), html: "<b>Opaque</b>" }),
    );
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at) VALUES (?,'mime-v1',?,1,?,'complete',?,?,?, ?,0)`,
    )
      .bind(
        key,
        "a".repeat(64),
        id,
        JSON.stringify({
          ...metadata,
          messageId: `<${id}@example.invalid>`,
          inReplyTo: reply ?? null,
        }),
        JSON.stringify([
          {
            index: 0,
            filename: "synthetic.txt",
            mimeType: "text/plain",
            key: `synthetic/attachment/${id}`,
            size: 4,
            sha256: "b".repeat(64),
          },
        ]),
        `synthetic/body/${id}`,
        `synthetic/manifest/${id}`,
      )
      .run();
    await env.MAIL_ARCHIVE.put(`synthetic/attachment/${id}`, "data");
  }
  return `mail_${id}`;
}
beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec("DELETE FROM mail_extractions; DELETE FROM archive_sources;");
});
describe("bounded private mail reads", () => {
  it("returns visible incomplete extraction and preserves bounded complete content", async () => {
    const pending = await insert("pending", "2026-11-11T00:00:00.000Z", null);
    expect(await readMail(env, principal, pending)).toMatchObject({
      extraction: { status: "pending" },
      content: null,
    });
    const id = await insert("ready", "2026-11-11T00:00:01.000Z");
    const mail = await readMail(env, principal, id, "full", "https://fumi.example.invalid");
    expect(mail).toMatchObject({
      content_truncated: true,
      content: { text: "x".repeat(16000) },
      extraction_file_uri: `https://fumi.example.invalid/api/mail/${id}/body`,
    });
    expect(JSON.stringify(mail)).not.toContain("synthetic/body/");
    const body = await readMailResource(
      new Request("https://fumi.example.invalid"),
      env,
      principal,
      id,
      "body",
    );
    expect(await body.json()).toMatchObject({ text: "x".repeat(20000) });
  });
  it("serves exact attachment bytes as downloads without exposing keys", async () => {
    const id = await insert("with-attachment", "2026-11-11T00:00:00.000Z");
    const attachment = await readMailAttachment(
      env,
      principal,
      { message_id: id, attachment_id: "part_0" },
      "https://fumi.example.invalid",
    );
    expect(attachment.file_uri).toBe(
      `https://fumi.example.invalid/api/mail/${id}/attachments/part_0`,
    );
    const response = await readMailResource(
      new Request(attachment.file_uri),
      env,
      principal,
      id,
      "attachment",
      "part_0",
    );
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("data");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
  });
  it("uses a stable snapshot keyset and exact escaped filter bindings", async () => {
    await insert("older", "2026-11-10T00:00:00.000Z", { subject: "100% literal" });
    await insert("newer", "2026-11-11T00:00:00.000Z", { subject: "100% literal" });
    const first = await searchMail(env, principal, {
      query: 'subject:"100% literal"',
      max_results: 1,
    });
    expect(first.emails.map((m) => m.id)).toEqual(["mail_newer"]);
    await insert("late", "2026-11-09T00:00:00.000Z", { subject: "100% literal" });
    const second = await searchMail(env, principal, {
      query: 'subject:"100% literal"',
      max_results: 1,
      next_page_token: first.next_page_token!,
    });
    expect(second.emails.map((m) => m.id)).toEqual(["mail_older"]);
    expect(second.next_page_token).toBeNull();
    await expect(
      searchMail(env, principal, { query: "from:someone OR to:another" }),
    ).rejects.toMatchObject({ code: "unsupported_query" });
  });
  it("reads direct reply links oldest first without claiming complete threading", async () => {
    await insert("parent", "2026-11-10T00:00:00.000Z");
    const child = await insert(
      "child",
      "2026-11-11T00:00:00.000Z",
      { subject: "Reply" },
      "<parent@example.invalid>",
    );
    const thread = await readMailThread(
      env,
      principal,
      { message_id: child },
      "https://fumi.example.invalid",
    );
    expect(thread.messages.map((m) => m.id)).toEqual(["mail_parent", "mail_child"]);
    expect(thread.threading).toBe("direct_message_id_header_links_only");
  });
  it("enforces read authorization for attachment and raw content", async () => {
    await expect(
      readMailResource(
        new Request("https://fumi.example.invalid"),
        env,
        { ...principal, scopes: [] },
        "mail_unknown",
        "raw",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("reads a full page of large thread bodies within the bounded runtime", async () => {
    for (let index = 0; index < 20; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Build a valid full thread without concurrent fixture buffers.
      await insert(
        `large-${index}`,
        "2026-11-11T00:00:00.000Z",
        { subject: "Large" },
        index ? "<large-0@example.invalid>" : undefined,
      );
    }
    await env.MAIL_ARCHIVE.put(
      "synthetic/large-body",
      JSON.stringify({ text: "t".repeat(3 * 1024 * 1024), html: "h".repeat(3 * 1024 * 1024) }),
    );
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET body_json_key='synthetic/large-body'",
    ).run();
    const thread = await readMailThread(
      env,
      principal,
      { message_id: "mail_large-0", max_messages: 20 },
      "https://fumi.example.invalid",
    );
    expect(thread.messages).toHaveLength(20);
    for (const message of thread.messages) {
      expect(message).toMatchObject({
        content_truncated: true,
        content: { text: "t".repeat(16_000), html: "h".repeat(16_000) },
      });
    }
  }, 30_000);
});
