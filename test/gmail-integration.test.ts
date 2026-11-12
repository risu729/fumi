import { env } from "cloudflare:workers";
import { applyD1Migrations, introspectWorkflowInstance } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startGmailImport, runGmailImportPage } from "../src/gmail-import.ts";
import { readMail, readMailThread, readMailResource, searchMail } from "../src/mail-read.ts";
import { processingInstanceId } from "../src/processing-jobs.ts";
import { dispatchMailTool } from "../src/mcp.ts";
import { handleHttp } from "../src/http.ts";
import { resolveGrant } from "../src/auth.ts";
import { searchMailContent } from "../src/content-search.ts";
import { repairRoutingShadow, ROUTING_CONFIG_KEY } from "../src/routing-shadow-runtime.ts";

const reader = {
  id: "synthetic-owner",
  scopes: ["mail:read", "mail:draft", "mail:send"],
  fromAddresses: ["sender@example.invalid"],
};
const scope = { accountNamespace: "account-a", before: 1_800_000_000, includeSpamTrash: true };
const pendingImport = {
  ...env,
  MAIL_PROCESSING: {
    createBatch: vi
      .fn()
      .mockImplementation(async ({ instances }: { instances: { id: string }[] }) => ({
        created: instances.map(({ id }) => ({ id })),
        errors: [],
      })),
    get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
  },
};
async function source(id: string, labels: string[], namespace = "account-a", extract = false) {
  const selected = { ...scope, accountNamespace: namespace };
  const raw = btoa(
    "From: untrusted@example.invalid\r\nTo: untrusted-to@example.invalid\r\nMessage-ID: <claimed@example.invalid>\r\nSubject: Imported mail\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHistorical content\r\n",
  );
  const transport = {
    list: async () => ({ messages: [{ id }] }),
    getRaw: async () => ({
      id,
      threadId: "provider-thread",
      internalDate: "1700000000000",
      labelIds: labels,
      raw,
    }),
  };
  const run = `${namespace}-${id}`;
  await startGmailImport(env, run, selected);
  await runGmailImportPage(extract ? env : pendingImport, transport, run, selected);
  const row = await env.MAIL_CATALOG.prepare(
    "SELECT s.external_id,s.raw_key FROM archive_sources s JOIN gmail_messages g ON g.raw_key=s.raw_key WHERE g.account_namespace=? AND g.message_id=?",
  )
    .bind(namespace, id)
    .first<{ external_id: string; raw_key: string }>();
  if (!row) throw new Error("Synthetic import missing");
  if (extract) {
    await using instance = await introspectWorkflowInstance(
      env.MAIL_PROCESSING,
      processingInstanceId(row.raw_key),
    );
    await instance.waitForStatus("complete");
  }
  return { id: `mail_${row.external_id}`, rawKey: row.raw_key };
}

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM routing_shadow_decisions; DELETE FROM routing_shadow_scan; DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM processing_jobs; DELETE FROM archive_sources; DELETE FROM mail_events;",
  );
  const objects = await env.MAIL_ARCHIVE.list();
  if (objects.objects.length) await env.MAIL_ARCHIVE.delete(objects.objects.map((o) => o.key));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("historical Gmail retrieval integration", () => {
  it("indexes imported MIME with verifiable citations while routing stays historically suppressed", async () => {
    const imported = await source("combined123", ["SENT"], "account-a", true);
    // Import dispatch and Workflow indexing finish without scheduled repair.
    expect(
      await env.MAIL_CATALOG.prepare("SELECT status FROM mail_search_documents WHERE raw_key=?")
        .bind(imported.rawKey)
        .first("status"),
    ).toBe("ready");
    const found = await searchMailContent(
      env,
      reader,
      { query: "Historical content" },
      "https://mail.example.invalid",
    );
    expect(found.matches).toHaveLength(1);
    const match = found.matches[0]!;
    expect(match.message_id).toBe(imported.id);
    const response = await readMailResource(
      new Request(match.citation.file_uri),
      env,
      reader,
      imported.id,
      "text",
    );
    const bytes = await response.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    expect(hash).toBe(match.citation.sha256);
    expect(new TextDecoder().decode(bytes)).toContain("Historical content");
    await env.MAIL_ARCHIVE.put(
      ROUTING_CONFIG_KEY,
      JSON.stringify({
        schemaVersion: 1,
        configJson: JSON.stringify({
          schemaVersion: 1,
          adoptions: [],
          rules: [{ id: "synthetic-review", priority: 1, match: "true", outcome: "review" }],
          fallback: "unresolved",
        }),
        manifests: [],
      }),
    );
    expect(await repairRoutingShadow(env)).toMatchObject({
      status: "complete",
      examined: 1,
      written: 1,
      blocked: 0,
      failed: 0,
    });
    const row = await env.MAIL_CATALOG.prepare(
      "SELECT source_kind,notify_events,state,decision_json FROM routing_shadow_decisions WHERE raw_key=?",
    )
      .bind(imported.rawKey)
      .first<{
        source_kind: string;
        notify_events: number;
        state: string;
        decision_json: string;
      }>();
    expect(row).toMatchObject({ source_kind: "gmail", notify_events: 0, state: "complete" });
    expect(JSON.parse(row!.decision_json)).toMatchObject({
      status: "historical_suppressed",
      dispatchAllowed: false,
    });
    expect(await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS n FROM mail_events").first("n")).toBe(
      0,
    );
  });
  it("preserves SENT/custom labels, pending/blocked coverage, and binds cursors to source and labels", async () => {
    const sent = await source("sent123", ["SENT", "Label_1"]);
    const inbox = await source("inbox123", ["INBOX"]);
    const mail = await readMail(env, reader, sent.id);
    expect(mail).toMatchObject({
      label_ids: ["SENT", "Label_1"],
      extraction: { status: "pending" },
      content: null,
      provenance: {
        source_kind: "gmail",
        message_id: "sent123",
        thread_id: "provider-thread",
        internal_date: "1700000000000",
        smtp_envelope_available: false,
      },
    });
    expect(
      (
        await searchMail(env, reader, { archive_source: "gmail", label_ids: ["SENT", "Label_1"] })
      ).emails.map((m) => m.id),
    ).toEqual([sent.id]);
    expect(
      (await searchMail(env, reader, { label_ids: ["INBOX"] })).emails.map((m) => m.id),
    ).toEqual([inbox.id]);
    expect((await searchMail(env, reader, { archive_source: "email_routing" })).emails).toEqual([]);
    await env.MAIL_CATALOG.prepare(
      "INSERT INTO mail_extractions(raw_key,extractor_version,instance_id,status,failure_code,updated_at) VALUES (?,'mime-v1','synthetic-blocked','blocked','input_too_large',0)",
    )
      .bind(sent.rawKey)
      .run();
    expect(await readMail(env, reader, sent.id)).toMatchObject({
      extraction: { status: "blocked", failure_code: "input_too_large" },
      content: null,
      label_ids: ["SENT", "Label_1"],
    });
    const first = await searchMail(env, reader, { archive_source: "gmail", max_results: 1 });
    expect(first.next_page_token).not.toBeNull();
    await expect(
      searchMail(env, reader, {
        archive_source: "all",
        max_results: 1,
        next_page_token: first.next_page_token!,
      }),
    ).rejects.toMatchObject({ code: "page_query_mismatch" });
    await expect(
      searchMail(env, reader, {
        archive_source: "gmail",
        label_ids: ["INBOX"],
        next_page_token: first.next_page_token!,
      }),
    ).rejects.toMatchObject({ code: "page_query_mismatch" });
  });

  it("groups by account and provider thread even before extraction without linking claimed headers", async () => {
    const first = await source("first123", ["SENT"], "account-a", true);
    const second = await source("second123", ["INBOX"]);
    const other = await source("other123", ["SENT"], "account-b", true);
    const a = await readMail(env, reader, first.id, "minimal");
    const b = await readMail(env, reader, second.id, "minimal");
    expect(a.thread_id).toBe(b.thread_id);
    const thread = await readMailThread(
      env,
      reader,
      { message_id: second.id },
      "https://mail.example.invalid",
    );
    expect(thread.threading).toBe("gmail_account_thread_id");
    expect(new Set(thread.messages.map((m) => m.id))).toEqual(new Set([first.id, second.id]));
    expect(thread.messages.map((m) => m.id)).not.toContain(other.id);
  });

  it("keeps legacy SENT operations separate and requires explicit sender for imported replies", async () => {
    const imported = await source("sent123", ["SENT"], "account-a", true);
    const email = {
      ...env,
      EMAIL: {
        send: vi.fn(async () => ({ messageId: "synthetic-provider" })),
      } as unknown as SendEmail,
    };
    const historical = await dispatchMailTool(
      "search_emails",
      { archive_source: "gmail", label_ids: ["SENT"] },
      email,
      reader,
      "https://mail.example.invalid",
    );
    expect(historical["emails"]).toMatchObject([{ id: imported.id, label_ids: ["SENT"] }]);
    const operations = await dispatchMailTool(
      "search_emails",
      { label_ids: ["SENT"] },
      email,
      reader,
      "https://mail.example.invalid",
    );
    expect(operations["coverage"]).toMatchObject({ source: "principal_outgoing_operations" });
    const reply = {
      to: ["recipient@example.invalid"],
      subject: "Synthetic reply",
      payload: { text: "Synthetic content" },
      reply_message_id: imported.id,
    };
    await expect(
      dispatchMailTool("preview_email", reply, email, reader, "https://mail.example.invalid"),
    ).rejects.toMatchObject({ code: "reply_sender_unavailable" });
    const preview = await dispatchMailTool(
      "preview_email",
      { ...reply, from_address: "sender@example.invalid" },
      email,
      reader,
      "https://mail.example.invalid",
    );
    expect(preview).toMatchObject({
      input: { from_address: "sender@example.invalid", reply_message_id: imported.id },
      submitted: false,
    });
    expect(email.EMAIL.send).not.toHaveBeenCalled();
  });
});

describe("mounted Gmail operator authentication", () => {
  it("requires valid Access JWT, same origin and dedicated grant before configured actions", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "synthetic-import-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) !== "https://synthetic-import.cloudflareaccess.com/cdn-cgi/access/certs")
          throw new Error("Unexpected synthetic network request");
        return new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const settings = {
      ...env,
      ACCESS_ISSUER: "https://synthetic-import.cloudflareaccess.com",
      ACCESS_AUDIENCE: "synthetic-import-app",
      API_ORIGIN: "https://mail.example.invalid",
      MAIL_GRANTS: JSON.stringify({
        "user:operator": {
          scopes: ["mail:read", "mail:draft", "mail:send", "mail:events", "mail:import"],
          fromAddresses: [],
        },
        "user:reader": { scopes: ["mail:read"], fromAddresses: [] },
      }),
    };
    expect(resolveGrant(settings.MAIL_GRANTS, "user:operator")?.scopes).toHaveLength(5);
    async function request(action: string, subject = "operator", options: RequestInit = {}) {
      const jwt = await new SignJWT({ type: "app", sub: subject })
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-import-key" })
        .setIssuer(settings.ACCESS_ISSUER)
        .setAudience(settings.ACCESS_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      return new Request(`${settings.API_ORIGIN}/api/admin/gmail-import/${action}`, {
        ...options,
        headers: { "cf-access-jwt-assertion": jwt, ...options.headers },
      });
    }
    const endpoint = `${settings.API_ORIGIN}/api/admin/gmail-import/start`;
    expect((await handleHttp(new Request(endpoint, { method: "POST" }), settings)).status).toBe(
      401,
    );
    expect(
      (
        await handleHttp(
          await request("start", "operator", {
            method: "POST",
            headers: { origin: "https://other.example.invalid" },
          }),
          settings,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleHttp(await request("start", "reader", { method: "POST" }), settings)).status,
    ).toBe(403);
    expect(
      (await handleHttp(await request("start", "operator", { method: "POST" }), settings)).status,
    ).toBe(503);
    const configured = {
      ...settings,
      GMAIL_IMPORT_CONFIG: JSON.stringify({
        importId: "operator",
        expectedAccountHash: "a".repeat(64),
        scope,
      }),
      GMAIL_IMPORT_ACCESS_TOKEN: "synthetic-token",
    };
    expect(
      (await handleHttp(await request("start", "operator", { method: "POST" }), configured)).status,
    ).toBe(200);
    const denied = await handleHttp(
      await request("page", "operator", {
        method: "POST",
        body: '{"accountNamespace":"untrusted"}',
      }),
      configured,
    );
    expect(denied.status).toBe(400);
    const status = await handleHttp(await request("status"), configured);
    expect(await status.json()).toMatchObject({ status: "pending", imported_count: 0 });
    expect(status.headers.get("cache-control")).toBe("no-store");
  });
});
