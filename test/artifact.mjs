import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { setTimeout } from "node:timers/promises";

// Execute the built production bundle with native workerd Email/Cron events and local R2/D1.
// Miniflare simulates forwarding; this never sends SMTP or uses provisioned storage.
const output = ".cloudflare/output/v0/workers/default";
const config = JSON.parse(await readFile(`${output}/worker.config.json`, "utf8"));
config.env.FORWARD_TO = { type: "text", value: "synthetic-forward@gmail.com" };
config.manifest = {
  mainModule: "index.js",
  modules: {
    "index.js": { type: "esm", contents: await readFile(`${output}/bundle/index.js`, "utf8") },
  },
};
const runtime = new Miniflare({ workers: [{ config }], unsafeTriggerHandlers: true });
try {
  const raw = [
    "From: sender@example.invalid",
    "To: header@example.invalid",
    "Message-ID: <artifact@example.invalid>",
    "Subject: Native synthetic lifecycle",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="fixture"',
    "",
    "--fixture",
    "Content-Type: text/plain",
    "",
    "Synthetic body",
    "--fixture",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="fixture.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAECA//+/Q==",
    "--fixture--",
    "",
  ].join("\r\n");
  const response = await runtime.dispatchFetch(
    "http://localhost/cdn-cgi/local/email?from=envelope@example.invalid&to=bcc@example.invalid&format=json",
    { method: "POST", body: raw },
  );
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.outcome, "ok");
  assert.equal(result.forwards.length, 1);
  assert.equal(result.forwards[0].recipient, "synthetic-forward@gmail.com");
  const bucket = await runtime.getR2Bucket("MAIL_ARCHIVE");
  const objects = (await bucket.list()).objects;
  assert.equal(objects.length, 2);
  const stored = await bucket.get(objects.find((object) => object.key.endsWith("/raw.eml")).key);
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), new TextEncoder().encode(raw));
  const receiptObject = await bucket.get(
    objects.find((object) => object.key.endsWith("/receipt.json")).key,
  );
  const receipt = await receiptObject.json();
  assert.equal(receipt.archive.status, "stored");
  assert.equal(receipt.forward.status, "forwarded");
  assert.ok(
    result.forwards[0].headers.some(
      ([name, value]) => name.toLowerCase() === "x-fumi-ingest-id" && value === receipt.ingestId,
    ),
  );
  assert.deepEqual(receipt.envelope, {
    from: "envelope@example.invalid",
    to: "bcc@example.invalid",
  });
  // Email delivery above succeeds even before the catalog schema exists.
  const catalog = await runtime.getD1Database("MAIL_CATALOG");
  const migrations = await readD1Migrations("migrations");
  for (const migration of migrations) {
    // oxlint-disable-next-line no-await-in-loop -- Migrations must run in order.
    await catalog.batch(migration.queries.map((query) => catalog.prepare(query)));
  }
  const scan = await runtime.dispatchFetch(
    "http://localhost/cdn-cgi/local/scheduled?cron=*/5%20*%20*%20*%20*&format=json",
  );
  const scanResult = await scan.json();
  assert.equal(scan.status, 200, JSON.stringify(scanResult));
  assert.equal(scanResult.outcome, "ok");
  const rows = await catalog.prepare("SELECT COUNT(*) AS count FROM archive_sources").first();
  assert.equal(rows.count, 1);
  const bindings = await runtime.getBindings();
  async function waitForProcessing(rawKey) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      // oxlint-disable-next-line no-await-in-loop -- Poll the real local Workflow with a deadline.
      const job = await catalog
        .prepare("SELECT * FROM processing_jobs WHERE raw_key = ?")
        .bind(rawKey)
        .first();
      if (job?.state === "failed") assert.fail(`Workflow failed: ${job.failure_code}`);
      if (job?.state === "complete") {
        // oxlint-disable-next-line no-await-in-loop -- Confirm the managed engine also reached completion.
        const instance = await bindings.MAIL_PROCESSING.get(job.instance_id);
        // oxlint-disable-next-line no-await-in-loop -- Confirm engine state after ledger persistence.
        if ((await instance.status()).status === "complete") return;
      }
      // oxlint-disable-next-line no-await-in-loop -- Bounded local runtime polling.
      await setTimeout(50);
    }
    assert.fail("Workflow did not complete before deadline");
  }
  await waitForProcessing(receipt.archive.key);
  const immediate = await runtime.dispatchFetch(
    "http://localhost/cdn-cgi/local/email?from=envelope@example.invalid&to=bcc@example.invalid&format=json",
    { method: "POST", body: raw },
  );
  assert.equal(immediate.status, 200);
  assert.equal((await immediate.json()).outcome, "ok");
  const second = (await bucket.list()).objects.find(
    (object) => object.key.endsWith("/raw.eml") && object.key !== receipt.archive.key,
  );
  assert.ok(second);
  await waitForProcessing(second.key);
  const extraction = await catalog
    .prepare("SELECT * FROM mail_extractions WHERE raw_key = ? AND extractor_version = 'mime-v1'")
    .bind(second.key)
    .first();
  assert.equal(extraction.status, "complete");
  assert.equal(extraction.attachment_count, 1);
  assert.equal(JSON.parse(extraction.metadata_json).messageId, "<artifact@example.invalid>");
  const body = await bucket.get(extraction.body_json_key);
  assert.match((await body.json()).text, /Synthetic body/);
  const [attachment] = JSON.parse(extraction.attachments_json);
  const attachmentObject = await bucket.get(attachment.key);
  assert.deepEqual(
    new Uint8Array(await attachmentObject.arrayBuffer()),
    new Uint8Array([0, 1, 2, 3, 255, 254, 253]),
  );
  // Derivatives do not replace or rewrite the original source.
  assert.deepEqual(
    new Uint8Array(await (await bucket.get(second.key)).arrayBuffer()),
    new TextEncoder().encode(raw),
  );
  assert.equal(
    (await catalog.prepare("SELECT COUNT(*) AS count FROM archive_sources").first()).count,
    2,
  );
  assert.equal((await catalog.prepare("SELECT pass FROM archive_scan").first()).pass, 1);
  const searchScan = await runtime.dispatchFetch(
    "http://localhost/cdn-cgi/local/scheduled?cron=*/5%20*%20*%20*&format=json",
  );
  assert.equal(searchScan.status, 200);
  assert.equal((await searchScan.json()).outcome, "ok");
  assert.equal(
    (
      await catalog
        .prepare("SELECT COUNT(*) AS count FROM mail_search_documents WHERE status='ready'")
        .first()
    ).count,
    2,
  );
  const contentMatches = await catalog
    .prepare("SELECT COUNT(*) AS count FROM mail_search_fts WHERE mail_search_fts MATCH ?")
    .bind('"Synthetic body"')
    .first();
  assert.equal(contentMatches.count, 2);
  console.log(
    "Native Email/Cron/Workflow events, MIME derivatives, content search, R2/D1 and built artifact: passed",
  );
} finally {
  await runtime.dispose();
}
