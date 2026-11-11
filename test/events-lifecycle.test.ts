import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { indexArchiveSource } from "../src/reconcile.ts";
import { extractArchiveMail } from "../src/mime-extraction.ts";
import {
  completeProcessing,
  failProcessing,
  processingInstanceId,
} from "../src/processing-jobs.ts";
import { commitSource, readCheckpoint } from "../src/catalog.ts";

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  const objects = (await env.MAIL_ARCHIVE.list()).objects;
  if (objects.length) await env.MAIL_ARCHIVE.delete(objects.map((object) => object.key));
  await env.MAIL_CATALOG.batch(
    ["mail_events", "mail_extractions", "processing_jobs", "archive_sources", "archive_issues"].map(
      (table) => env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`),
    ),
  );
});
async function source(live = true) {
  const id = crypto.randomUUID();
  const key = `ingest/2026-11-11/${id}/raw.eml`;
  const bytes = new TextEncoder().encode("Subject: Synthetic events\r\n\r\nSynthetic body\r\n");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  await env.MAIL_ARCHIVE.put(key, bytes, {
    sha256: digest,
    customMetadata: {
      schemaVersion: "1",
      ingestId: id,
      receivedAt: "2026-11-11T12:00:00.000Z",
      sha256: sha,
      envelopeFrom: "sender@example.invalid",
      envelopeTo: "recipient@example.invalid",
      ...(live ? { eventNotifications: "1" } : {}),
    },
  });
  const params = { rawKey: key, pipelineVersion: "mime-v1" as const, attempt: 0 };
  const instanceId = processingInstanceId(key);
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO processing_jobs (raw_key,pipeline_version,instance_id,state,created_at,updated_at,next_check_at) VALUES (?,'mime-v1',?,'running',0,0,0)`,
  )
    .bind(key, instanceId)
    .run();
  return { id, key, params, instanceId };
}
async function events() {
  return (
    await env.MAIL_CATALOG.prepare(
      "SELECT event_id,name,data_json FROM mail_events ORDER BY sequence",
    ).all()
  ).results;
}
describe("transactional mail lifecycle events", () => {
  it("recovers live raw metadata through the catalog and emits ready only after MIME completion", async () => {
    const item = await source();
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    expect(await events()).toMatchObject([
      { name: "email.received", data_json: JSON.stringify({ ingestId: item.id }) },
    ]);
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    expect(await events()).toHaveLength(1);
    await extractArchiveMail(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    await completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), item.params);
    await completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), item.params);
    expect((await events()).map((event) => event["name"])).toEqual([
      "email.received",
      "email.ready",
    ]);
  });
  it("does not turn historical reconciliation or extraction into new-mail notifications", async () => {
    const item = await source(false);
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    await extractArchiveMail(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    await completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), item.params);
    expect(await events()).toEqual([]);
  });
  it("does not publish failed or ready events for stale processing attempts", async () => {
    const item = await source();
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    const stale = { ...item.params, attempt: 1 };
    await failProcessing(env.MAIL_CATALOG.withSession("first-primary"), stale);
    await expect(
      completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), stale),
    ).rejects.toThrow("fenced");
    expect(await events()).toHaveLength(1);
    await failProcessing(env.MAIL_CATALOG.withSession("first-primary"), item.params);
    await failProcessing(env.MAIL_CATALOG.withSession("first-primary"), item.params);
    expect((await events()).map((event) => event["name"])).toEqual([
      "email.received",
      "email.processing_failed",
    ]);
  });
  it("does not publish ready from a ledger completion lacking a complete MIME record", async () => {
    const item = await source();
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    await completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), item.params);
    expect((await events()).map((event) => event["name"])).toEqual(["email.received"]);
  });
  it("does not publish a catalog event behind a stale catalog revision", async () => {
    const item = await source();
    const db = env.MAIL_CATALOG.withSession("first-primary");
    const checkpoint = await readCheckpoint(db);
    await indexArchiveSource(env.MAIL_ARCHIVE, env.MAIL_CATALOG, item.key, item.instanceId);
    await env.MAIL_CATALOG.prepare("DELETE FROM mail_events").run();
    const result = await commitSource(
      db,
      checkpoint,
      {
        ingestId: item.id,
        rawKey: item.key,
        receiptKey: item.key.replace("raw.eml", "receipt.json"),
        receivedAt: "2026-11-11T12:00:00.000Z",
        snapshot: null,
        forward: null,
        rawState: "present",
        receiptState: "missing",
        rawSize: 10,
        rawSha256: "a".repeat(64),
        notifyEvents: true,
      },
      [],
      item.instanceId,
    );
    expect(result.committed).toBe(false);
    expect(await events()).toEqual([]);
  });
});
