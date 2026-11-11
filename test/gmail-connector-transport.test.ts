import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnectorGmailTransport } from "../src/gmail-connector-transport.ts";
import { gmailImportRuntime, handleGmailImport } from "../src/gmail-import-http.ts";
import { runGmailImportPage, startGmailImport } from "../src/gmail-import.ts";

const scope = {
  accountNamespace: "synthetic-account",
  before: 1_800_000_000,
  includeSpamTrash: false,
};
const accountHash = "a".repeat(64);
const prefix = "imports/gmail-connector-v1/synthetic-run";
const hash = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const raw = new Uint8Array([
  ...new TextEncoder().encode("Subject: Synthetic historical sent mail\r\n\r\n"),
  0,
  255,
  13,
  10,
]);
async function page(
  ids: string[],
  cursor: string | null = null,
  next: string | null = null,
  override: Record<string, unknown> = {},
) {
  const key = await hash(new TextEncoder().encode(JSON.stringify(cursor)));
  await env.MAIL_ARCHIVE.put(
    `${prefix}/pages/${key}.json`,
    JSON.stringify({
      schemaVersion: 1,
      accountHash,
      scope,
      pageToken: cursor,
      messageIds: ids,
      nextPageToken: next,
      ...override,
    }),
  );
}
async function message(id = "abcd", override: Record<string, unknown> = {}) {
  const rawSha256 = await hash(raw);
  await env.MAIL_ARCHIVE.put(`${prefix}/raw/${id}/${rawSha256}.eml`, raw);
  await env.MAIL_ARCHIVE.put(
    `${prefix}/messages/${id}.json`,
    JSON.stringify({
      schemaVersion: 1,
      accountHash,
      id,
      threadId: "threadabcd",
      internalDate: "1700000000000",
      labelIds: ["SENT", "Label_1"],
      rawSize: raw.byteLength,
      rawSha256,
      ...override,
    }),
  );
}
const transport = () =>
  createConnectorGmailTransport({
    bucket: env.MAIL_ARCHIVE,
    importId: "synthetic-run",
    expectedAccountHash: accountHash,
    scope,
  });
const parameters = { q: `before:${scope.before}`, includeSpamTrash: false, maxResults: 10 };
beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_CATALOG.exec(
    "DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM processing_jobs; DELETE FROM archive_sources; DELETE FROM mail_events;",
  );
  const objects = await env.MAIL_ARCHIVE.list();
  if (objects.objects.length) await env.MAIL_ARCHIVE.delete(objects.objects.map((x) => x.key));
});
describe("connected Gmail staged transport", () => {
  it("preserves exact binary MIME and provider provenance through the existing resumable importer", async () => {
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No OAuth or network request"));
    try {
      await page(["abcd"], null, "page-two");
      await message();
      await page(["abcd"], "page-two", null);
      await startGmailImport(env, "synthetic-run", scope);
      expect(await runGmailImportPage(env, transport(), "synthetic-run", scope)).toEqual({
        status: "advanced",
        imported: 1,
      });
      expect(await runGmailImportPage(env, transport(), "synthetic-run", scope)).toEqual({
        status: "complete",
        imported: 0,
      });
      const source = await env.MAIL_CATALOG.prepare(
        "SELECT s.raw_key,s.source_kind,s.notify_events,g.label_ids_json,g.thread_id FROM archive_sources s JOIN gmail_messages g ON g.raw_key=s.raw_key",
      ).first<{
        raw_key: string;
        source_kind: string;
        notify_events: number;
        label_ids_json: string;
        thread_id: string;
      }>();
      expect(source).toMatchObject({
        source_kind: "gmail",
        notify_events: 0,
        thread_id: "threadabcd",
      });
      expect(JSON.parse(source!.label_ids_json)).toEqual(["SENT", "Label_1"]);
      const saved = await env.MAIL_ARCHIVE.get(source!.raw_key);
      expect(new Uint8Array(await saved!.arrayBuffer())).toEqual(raw);
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
      ).toEqual({ count: 0 });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it("stops without advancing an incomplete staged page, then resumes after missing raw arrives", async () => {
    await page(["abcd"]);
    await startGmailImport(env, "synthetic-run", scope);
    await expect(
      runGmailImportPage(env, transport(), "synthetic-run", scope),
    ).rejects.toMatchObject({ code: "connector_stage_missing" });
    const row = await env.MAIL_CATALOG.prepare(
      "SELECT revision,pending_json,complete FROM gmail_imports",
    ).first();
    expect(row).toEqual({ revision: 0, pending_json: '["abcd"]', complete: 0 });
    await message();
    expect(await runGmailImportPage(env, transport(), "synthetic-run", scope)).toEqual({
      status: "complete",
      imported: 1,
    });
  });
  it("rejects account, frozen scope and cursor mismatches before importing", async () => {
    await page(["abcd"], null, null, { accountHash: "b".repeat(64) });
    await expect(transport().list(parameters)).rejects.toMatchObject({
      code: "connector_scope_mismatch",
    });
    await page(["abcd"], null, null, { scope: { ...scope, before: scope.before - 1 } });
    await expect(transport().list(parameters)).rejects.toMatchObject({
      code: "connector_scope_mismatch",
    });
    await page(["abcd"], null, null, { pageToken: "other" });
    await expect(transport().list(parameters)).rejects.toMatchObject({
      code: "connector_scope_mismatch",
    });
    await expect(transport().list({ ...parameters, q: "in:inbox" })).rejects.toMatchObject({
      code: "connector_scope_mismatch",
    });
  });
  it("rejects tampered raw bytes, metadata account mismatch and excluded spam/trash", async () => {
    await message();
    const rawSha = await hash(raw);
    await env.MAIL_ARCHIVE.put(`${prefix}/raw/abcd/${rawSha}.eml`, new Uint8Array(raw.length));
    await expect(transport().getRaw("abcd")).rejects.toMatchObject({
      code: "connector_stage_integrity_mismatch",
    });
    await message("abcd", { accountHash: "b".repeat(64) });
    await expect(transport().getRaw("abcd")).rejects.toMatchObject({
      code: "connector_scope_mismatch",
    });
    await message("abcd", { labelIds: ["TRASH"] });
    await expect(transport().getRaw("abcd")).rejects.toMatchObject({
      code: "gmail_message_outside_scope",
    });
  });
  it("bounds list size, duplicate IDs and path traversal and handles the terminal empty page", async () => {
    await page(["abcd", "abcd"]);
    await expect(transport().list(parameters)).rejects.toMatchObject({
      code: "connector_stage_invalid",
    });
    await page(Array.from({ length: 11 }, (_, i) => `id${i}`));
    await expect(transport().list(parameters)).rejects.toMatchObject({
      code: "connector_stage_invalid",
    });
    await expect(transport().getRaw("../private")).rejects.toMatchObject({
      code: "gmail_invalid_message",
    });
    await page([], null, "still-more");
    await expect(transport().list(parameters)).rejects.toMatchObject({
      code: "connector_stage_invalid",
    });
    await page([]);
    expect(await transport().list(parameters)).toEqual({ messages: [] });
  });
  it("mounts the connector transport without OAuth material while keeping the import scope separate", async () => {
    await page(["abcd"]);
    await message();
    const runtime = gmailImportRuntime({
      ...env,
      GMAIL_IMPORT_CONFIG: JSON.stringify({
        importId: "synthetic-run",
        expectedAccountHash: accountHash,
        scope,
        transport: "connector",
      }),
    });
    expect(runtime).not.toBeNull();
    const principal = { id: "operator", scopes: ["mail:import"], fromAddresses: [] };
    const start = new Request("https://mail.example.invalid/api/admin/gmail-import/start", {
      method: "POST",
    });
    expect(
      (await handleGmailImport(start, env, { ...principal, scopes: ["mail:read"] }, runtime))
        .status,
    ).toBe(403);
    expect((await handleGmailImport(start, env, principal, runtime)).status).toBe(200);
    const response = await handleGmailImport(
      new Request("https://mail.example.invalid/api/admin/gmail-import/page", { method: "POST" }),
      env,
      principal,
      runtime,
    );
    expect(await response.json()).toEqual({ status: "complete", imported: 1 });
    expect(
      gmailImportRuntime({
        GMAIL_IMPORT_CONFIG: JSON.stringify({
          importId: "synthetic-run",
          expectedAccountHash: accountHash,
          scope,
        }),
      }),
    ).toBeNull();
  });
});
