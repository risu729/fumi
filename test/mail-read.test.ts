import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SEARCH_FILTERS,
  readMail,
  readMailAttachment,
  readMailResource,
  readMailThread,
  resolveMailRawKey,
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
    `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision) VALUES ('email_routing','ingress-v1',?,?,?,?,'present','missing',?,0,0)`,
  )
    .bind(id, key, `${key}.receipt`, date, "a".repeat(64))
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
  it.each([
    [
      "blocked after a completed extraction",
      "UPDATE mail_extractions SET status='blocked',failure_code='source_changed'",
    ],
    ["whose original is missing", "UPDATE archive_sources SET raw_state='missing'"],
    ["whose original changed", `UPDATE archive_sources SET raw_sha256='${"c".repeat(64)}'`],
  ])("serves no derived content for an extraction %s", async (_, change) => {
    const id = await insert("stale", "2026-11-11T00:00:00.000Z");
    const raw = "ingest/2026-11-11/stale/raw.eml";
    await env.MAIL_ARCHIVE.put(raw, "synthetic original");
    await env.MAIL_ARCHIVE.put("synthetic/text/stale", "synthetic text");
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET body_text_key='synthetic/text/stale'",
    ).run();
    const download = (kind: "raw" | "body" | "text" | "attachment", method = "GET") =>
      readMailResource(
        new Request("https://fumi.example.invalid", { method }),
        env,
        principal,
        id,
        kind,
        kind === "attachment" ? "part_0" : undefined,
      );
    for (const kind of ["body", "text", "attachment"] as const)
      // oxlint-disable-next-line no-await-in-loop -- Each download reads one bounded object.
      expect((await download(kind)).status).toBe(200);
    await env.MAIL_CATALOG.prepare(change).run();
    for (const kind of ["body", "text", "attachment"] as const)
      for (const method of ["GET", "HEAD"])
        // oxlint-disable-next-line no-await-in-loop -- Each rejection is checked in turn.
        await expect(download(kind, method)).rejects.toMatchObject({
          code: "content_unavailable",
        });
    expect(await (await download("raw")).text()).toBe("synthetic original");
    const mail = await readMail(env, principal, id);
    expect(mail).toMatchObject({
      content: null,
      content_truncated: false,
      attachments: [{ attachment_id: "part_0", read_attachment_supported: false }],
    });
    expect(mail).not.toHaveProperty("extraction_file_uri");
    await expect(
      readMailAttachment(
        env,
        principal,
        { message_id: id, attachment_id: "part_0" },
        "https://fumi.example.invalid",
      ),
    ).rejects.toMatchObject({ code: "extraction_incomplete" });
  });
  it("answers HEAD downloads from object metadata without reading the body", async () => {
    const id = await insert("head", "2026-11-11T00:00:00.000Z");
    const archive = {
      head: (key: string) => env.MAIL_ARCHIVE.head(key),
      get: () => {
        throw new Error("HEAD must not read the object body");
      },
    } as unknown as R2Bucket;
    const response = await readMailResource(
      new Request("https://fumi.example.invalid", { method: "HEAD" }),
      { MAIL_CATALOG: env.MAIL_CATALOG, MAIL_ARCHIVE: archive },
      principal,
      id,
      "attachment",
      "part_0",
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    await expect(
      readMailResource(
        new Request("https://fumi.example.invalid", { method: "HEAD" }),
        { MAIL_CATALOG: env.MAIL_CATALOG, MAIL_ARCHIVE: archive },
        principal,
        id,
        "attachment",
        "part_9",
      ),
    ).rejects.toMatchObject({ code: "content_unavailable" });
  });
  it("refuses to pick one of several sources that share an external ID", async () => {
    const id = await insert("shared", "2026-11-11T00:00:00.000Z");
    const key = "ingest/2026-11-11/shared-gmail/raw.eml";
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,observed_pass,observed_revision) VALUES ('gmail','synthetic-account','shared',?,?,'2026-11-11T00:00:00.000Z','present','missing',0,0)`,
    )
      .bind(key, `${key}.receipt`)
      .run();
    const conflict = { code: "message_conflict" };
    await expect(readMail(env, principal, id)).rejects.toMatchObject(conflict);
    await expect(resolveMailRawKey(env, principal, id)).rejects.toMatchObject(conflict);
    await expect(
      readMailResource(new Request("https://fumi.example.invalid"), env, principal, id, "raw"),
    ).rejects.toMatchObject(conflict);
    await expect(
      readMailAttachment(
        env,
        principal,
        { message_id: id, attachment_id: "part_0" },
        "https://fumi.example.invalid",
      ),
    ).rejects.toMatchObject(conflict);
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
  it("matches non-ASCII metadata filters exactly as stored, folding only ASCII case", async () => {
    await insert("fullwidth", "2026-11-11T00:00:00.000Z", {
      subject: "\u3010\u91cd\u8981\u3011\uff30\uff24\uff26 Report",
    });
    await insert("latin", "2026-11-10T00:00:00.000Z", { subject: "\u00c4nderung" });
    const ids = async (query: string) =>
      (await searchMail(env, principal, { query })).emails.map((m) => m.id);
    expect(await ids("subject:\uff30\uff24\uff26")).toEqual(["mail_fullwidth"]);
    expect(await ids("subject:\u00c4nderung")).toEqual(["mail_latin"]);
    expect(await ids("subject:\u00c4NDERUNG")).toEqual(["mail_latin"]);
    expect(await ids("subject:report")).toEqual(["mail_fullwidth"]);
  });
  it("keeps matching stored lowercase non-ASCII text for uppercase filters", async () => {
    await insert("fullwidth", "2026-11-11T00:00:00.000Z", { subject: "\uff50\uff44\uff46 report" });
    await insert("latin", "2026-11-10T00:00:00.000Z", { subject: "\u00e4nderung" });
    const ids = async (query: string) =>
      (await searchMail(env, principal, { query })).emails.map((m) => m.id);
    expect(await ids("subject:\uff30\uff24\uff26")).toEqual(["mail_fullwidth"]);
    expect(await ids("subject:\u00c4nderung")).toEqual(["mail_latin"]);
    expect(await ids("subject:\u00e4nderung")).toEqual(["mail_latin"]);
  });
  it("matches filter values longer than D1's 50-byte LIKE pattern limit literally", async () => {
    const ascii = "Quarterly synthetic statement for the account ending 0000";
    const kana = "あ".repeat(20);
    const percent = "%".repeat(30);
    await insert("ascii", "2026-11-11T00:00:00.000Z", { subject: `Re: ${ascii}` });
    await insert("kana", "2026-11-10T00:00:00.000Z", { subject: `【${kana}】` });
    await insert("percent", "2026-11-09T00:00:00.000Z", { subject: `${percent} off` });
    await insert("other", "2026-11-08T00:00:00.000Z", { subject: "%_\\ other" });
    const ids = async (query: string) =>
      (await searchMail(env, principal, { query })).emails.map((m) => m.id);
    expect(await ids(`subject:"${ascii.toUpperCase()}"`)).toEqual(["mail_ascii"]);
    expect(await ids(`subject:${kana}`)).toEqual(["mail_kana"]);
    expect(await ids(`subject:${"Ä".repeat(30)}`)).toEqual([]);
    expect(await ids(`subject:${percent}`)).toEqual(["mail_percent"]);
    expect(await ids("subject:%_\\")).toEqual(["mail_other"]);
    // A NUL is part of the value, not the end of it.
    expect(await ids("subject:\u0000")).toEqual([]);
    expect(await ids('subject:""')).toEqual([
      "mail_ascii",
      "mail_kana",
      "mail_percent",
      "mail_other",
    ]);
  });
  it("binds the most filters D1 allows next to every other search parameter", async () => {
    await insert("latin", "2026-11-10T00:00:00.000Z", { subject: "Änderung" });
    // Each subject:Ä binds two values, the most a filter can bind.
    const filters = (count: number) => Array.from({ length: count }, () => "subject:Ä");
    const most = filters(MAX_SEARCH_FILTERS).join(" ");
    expect((await searchMail(env, principal, { query: most })).emails.map((m) => m.id)).toEqual([
      "mail_latin",
    ]);
    // The worst case adds an archive source, ten labels and a cursor.
    const labels = Array.from({ length: 10 }, (_, index) => `LABEL_${index}`);
    const cursor = btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(
          JSON.stringify({
            version: 2,
            snapshot: Number.MAX_SAFE_INTEGER,
            groups: Number.MAX_SAFE_INTEGER,
            sent: Number.MAX_SAFE_INTEGER,
            beforeTime: "9999-12-31T00:00:00.000Z",
            beforeId: "mail_~",
            query: JSON.stringify([most, "email_routing", labels, false]),
          }),
        ),
      ),
    );
    const worst = await searchMail(env, principal, {
      query: most,
      archive_source: "email_routing",
      label_ids: labels,
      next_page_token: cursor,
      max_results: 50,
    });
    expect(worst.emails).toEqual([]);
    await expect(
      searchMail(env, principal, { query: filters(MAX_SEARCH_FILTERS + 1).join(" ") }),
    ).rejects.toMatchObject({ code: "query_too_long" });
    // The cap counts filters, not bound values: has:attachment binds none.
    await expect(
      searchMail(env, principal, {
        query: Array.from({ length: MAX_SEARCH_FILTERS + 1 }, () => "has:attachment").join(" "),
      }),
    ).rejects.toMatchObject({ code: "query_too_long" });
  });
  it("never splits a surrogate pair at the inline preview limit", async () => {
    const id = await insert("emoji", "2026-11-11T00:00:00.000Z");
    const text = `${"x".repeat(15_999)}\u{1f600}tail`;
    await env.MAIL_ARCHIVE.put("synthetic/body/emoji", JSON.stringify({ text, html: null }));
    const mail = await readMail(env, principal, id);
    expect(mail).toMatchObject({ content_truncated: true });
    const preview = (mail as { content: { text: string } }).content.text;
    // Compare booleans: printing a lone surrogate breaks the test runner's UTF-8 transport.
    expect(preview === "x".repeat(15_999)).toBe(true);
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
