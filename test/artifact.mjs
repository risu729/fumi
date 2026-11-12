import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { setTimeout } from "node:timers/promises";

// Execute the built production bundle with native workerd Email/Cron events and local R2/D1.
// Miniflare simulates forwarding; this never sends SMTP or uses provisioned storage.
const output = ".cloudflare/output/v0/workers/default";
const { encryptedPdf, password: syntheticPdfPassword } = JSON.parse(
  await readFile(".cloudflare/attachment-fixture.json", "utf8"),
);
const config = JSON.parse(await readFile(`${output}/worker.config.json`, "utf8"));
assert.ok(["forward", "archive-only"].includes(config.env.INGRESS_MODE.value));
if (config.env.INGRESS_MODE.value === "archive-only") {
  assert.equal(config.env.FORWARD_TO, undefined);
} else {
  assert.equal(config.env.FORWARD_TO.type, "secret");
}
// Exercise both runtime modes from either actual build variant.
config.env.INGRESS_MODE = { type: "text", value: "forward" };
assert.deepEqual(config.exports.MailProcessing, {
  type: "workflow",
  name: "fumi-mail-processing",
  concurrency: { limit: 25 },
  defaultRetention: { successRetention: "3 days", errorRetention: "3 days" },
});
const rpcWorker = process.env["FUMI_ROUTING_RPC_WORKER"];
const rpcEntrypoint = process.env["FUMI_ROUTING_RPC_ENTRYPOINT"];
const workers = [{ config }];
if (rpcWorker && rpcEntrypoint) {
  assert.deepEqual(config.env.ROUTING_DISPATCH_RPC, {
    type: "worker",
    worker: rpcWorker,
    exportName: rpcEntrypoint,
  });
  assert.deepEqual(config.env.ROUTING_DISPATCH_RPC_IDENTITY, {
    type: "text",
    value: JSON.stringify([rpcWorker, rpcEntrypoint]),
  });
  // Prove the native built binding reaches a named RPC export without contacting
  // the configured production service. This target exists only in local workerd.
  workers.push({
    config: {
      name: rpcWorker,
      compatibilityDate: config.compatibilityDate,
      exports: { [rpcEntrypoint]: { type: "worker" } },
      manifest: {
        mainModule: "synthetic-owner.js",
        modules: {
          "synthetic-owner.js": {
            type: "esm",
            contents: `import {WorkerEntrypoint} from "cloudflare:workers";
        class SyntheticOwner extends WorkerEntrypoint {
          async manifest() {
            const json=JSON.stringify({schemaVersion:1,pluginId:"synthetic-owner",version:"1.0.0",protocol:"fumi-offer-v1",mode:"exclusive",inputFields:["subject"],capabilities:["offer"],match:'subject == "Synthetic"'});
            const sha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(json))),n=>n.toString(16).padStart(2,"0")).join("");
            return {json,sha256};
          }
          async offer(request) {
            if(request.kind!=="owner"||request.input.envelope.receivedAt!==request.source.receivedAt||request.attempt.expiresAt<=Date.now())throw new Error("Invalid synthetic offer");
            return {schemaVersion:1,operationId:request.operationId,requestSha256:request.requestSha256,result:"not_applicable"};
          }
          async receipt(request) { return {...request,result:"not_found"}; }
        }
        export {SyntheticOwner as ${JSON.stringify(rpcEntrypoint)}};`,
          },
        },
      },
    },
  });
} else {
  assert.equal(config.env.ROUTING_DISPATCH_RPC, undefined);
}
config.env.FORWARD_TO = { type: "text", value: "synthetic-forward@gmail.com" };
config.env.PDF_LOADER = { type: "worker-loader" };
const pdfBytes = Uint8Array.from(atob(encryptedPdf), (c) => c.charCodeAt(0));
const pdfHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pdfBytes)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
config.env.ATTACHMENT_CONVERSION_CONFIG = {
  type: "text",
  value: JSON.stringify({
    version: 1,
    enabled: true,
    revision: "synthetic-native-pdf",
    maxCalls: 1,
    documents: false,
    ocr: false,
    zip: false,
    pdf: true,
  }),
};
config.env.ATTACHMENT_PASSWORDS = {
  type: "text",
  value: JSON.stringify({ [pdfHash]: [syntheticPdfPassword] }),
};
config.manifest = {
  mainModule: "index.js",
  modules: {
    "index.js": { type: "esm", contents: await readFile(`${output}/bundle/index.js`, "utf8") },
  },
};
const runtime = new Miniflare({ workers, unsafeTriggerHandlers: true });
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
  if (rpcWorker && rpcEntrypoint) {
    const identity = {
      schemaVersion: 1,
      operationId: "a".repeat(64),
      requestSha256: "b".repeat(64),
    };
    const receivedAt = "2026-01-01T00:00:00.000Z";
    const ownerRequest = {
      ...identity,
      kind: "owner",
      pluginId: "synthetic-owner",
      manifestVersion: "1.0.0",
      manifestSha256: "c".repeat(64),
      attempt: { generation: 1, expiresAt: Date.now() + 5000 },
      source: { eventId: "d".repeat(64), rawSha256: "e".repeat(64), receivedAt },
      input: {
        subject: "Synthetic",
        envelope: { from: "sender@example.invalid", to: "receiver@example.invalid", receivedAt },
        text: "No authentication code in this fixture",
      },
    };
    // Miniflare's Node bridge returns RPC object proxies; await individual fields.
    const receiptValue = async (value) => ({
      schemaVersion: await value.schemaVersion,
      operationId: await value.operationId,
      requestSha256: await value.requestSha256,
      result: await value.result,
    });
    assert.deepEqual(await receiptValue(await bindings.ROUTING_DISPATCH_RPC.offer(ownerRequest)), {
      ...identity,
      result: "not_applicable",
    });
    assert.deepEqual(await receiptValue(await bindings.ROUTING_DISPATCH_RPC.receipt(identity)), {
      ...identity,
      result: "not_found",
    });
    const publication = await bindings.ROUTING_DISPATCH_RPC.manifest();
    const publicationJson = await publication.json;
    const actualSha256 = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publicationJson)),
      ),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    assert.equal(await publication.sha256, actualSha256);
  }
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
  await bucket.put(
    "config/routing-shadow-v1.json",
    JSON.stringify({
      schemaVersion: 1,
      configJson: JSON.stringify({
        schemaVersion: 1,
        adoptions: [],
        rules: [
          {
            id: "synthetic",
            priority: 1,
            match: 'subject.startsWith("Native")',
            outcome: "review",
          },
        ],
        fallback: "unresolved",
      }),
      manifests: [],
    }),
  );
  const eventsBeforeShadow = await catalog
    .prepare("SELECT COUNT(*) AS count FROM mail_events")
    .first();
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
  const shadow = await catalog
    .prepare("SELECT state,decision_json FROM routing_shadow_decisions")
    .all();
  assert.equal(shadow.results.length, 2);
  for (const row of shadow.results) {
    assert.equal(row.state, "complete");
    const decision = JSON.parse(row.decision_json);
    assert.equal(decision.dispatchAllowed, false);
    assert.equal(decision.status, "shadow");
    assert.equal(decision.fallback.outcome, "review");
  }
  assert.deepEqual(
    await catalog.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
    eventsBeforeShadow,
  );
  // A disabled private artifact still records its control generation. This proves
  // the post-MIME Workflow hook runs before Cron without creating any external call.
  await bucket.put(
    "config/routing-dispatch-v1.json",
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      generation: 1,
      enabled: false,
      routing: {
        configJson: JSON.stringify({
          schemaVersion: 1,
          adoptions: [],
          rules: [],
          fallback: "unresolved",
        }),
        manifests: [],
      },
      destination: {
        id: "synthetic",
        adapter: { kind: "rpc", serviceRef: "default", timeoutMs: 5000 },
        offerFields: [],
      },
      owners: [],
    }),
  );
  assert.equal(
    (await catalog.prepare("SELECT COUNT(*) count FROM routing_dispatch_control").first()).count,
    0,
  );
  const pdfMail = `From: sender@example.invalid\r\nTo: header@example.invalid\r\nMessage-ID: <synthetic-pdf@example.invalid>\r\nSubject: Synthetic native encrypted PDF\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="locked"\r\n\r\n--locked\r\nContent-Type: text/plain\r\n\r\nEncrypted fixture attached.\r\n--locked\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="synthetic.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encryptedPdf.match(/.{1,76}/g).join("\r\n")}\r\n--locked--\r\n`;
  const pdfIngest = await runtime.dispatchFetch(
    "http://localhost/cdn-cgi/local/email?from=envelope@example.invalid&to=bcc@example.invalid&format=json",
    { method: "POST", body: pdfMail },
  );
  assert.equal(pdfIngest.status, 200);
  assert.equal((await pdfIngest.json()).outcome, "ok");
  const pdfSource = (await bucket.list()).objects.find(
    (object) =>
      object.key.endsWith("/raw.eml") &&
      object.key !== receipt.archive.key &&
      object.key !== second.key,
  );
  assert.ok(pdfSource);
  await waitForProcessing(pdfSource.key);
  assert.deepEqual(
    await catalog
      .prepare("SELECT revision,generation,accepting FROM routing_dispatch_control")
      .first(),
    { revision: 1, generation: 1, accepting: 0 },
  );
  assert.equal(
    (await catalog.prepare("SELECT COUNT(*) count FROM routing_dispatch_outbox").first()).count,
    0,
  );
  const pdfEvents = await catalog.prepare("SELECT COUNT(*) count FROM mail_events").first();
  const pdfScan = await runtime.dispatchFetch(
    "http://localhost/cdn-cgi/local/scheduled?cron=*/5%20*%20*%20*&format=json",
  );
  const pdfScanResult = await pdfScan.json();
  assert.equal(pdfScan.status, 200, JSON.stringify(pdfScanResult));
  assert.equal(pdfScanResult.outcome, "ok");
  const converted = await catalog
    .prepare("SELECT * FROM attachment_conversions WHERE raw_key=?")
    .bind(pdfSource.key)
    .first();
  assert.equal(converted.state, "complete");
  assert.equal(converted.representation, "local_decrypted_pdf");
  assert.equal(converted.source_sha256, pdfHash);
  const clearPdf = new Uint8Array(await (await bucket.get(converted.result_key)).arrayBuffer());
  const clearHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", clearPdf)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(clearHash, converted.result_sha256);
  assert.equal(new TextDecoder().decode(clearPdf).includes("/Encrypt"), false);
  assert.deepEqual(
    new Uint8Array(await (await bucket.get(pdfSource.key)).arrayBuffer()),
    new TextEncoder().encode(pdfMail),
  );
  assert.equal(
    (await catalog.prepare("SELECT COUNT(*) count FROM attachment_conversion_calls").first()).count,
    0,
  );
  assert.deepEqual(
    await catalog.prepare("SELECT COUNT(*) count FROM mail_events").first(),
    pdfEvents,
  );
  console.log(
    "Native Email/Cron/Workflow events, MIME, search, routing shadow, isolated encrypted PDF, R2/D1 and built artifact: passed",
  );
} finally {
  await runtime.dispose();
}

// Exercise the same production bundle with no forwarding credential. This local
// runtime has its own storage; no deployed bindings or SMTP are contacted.
const standaloneConfig = structuredClone(config);
standaloneConfig.env.INGRESS_MODE = { type: "text", value: "archive-only" };
delete standaloneConfig.env.FORWARD_TO;
const standaloneRuntime = new Miniflare({
  workers: [{ config: standaloneConfig }, ...workers.slice(1)],
  unsafeTriggerHandlers: true,
});
try {
  const raw =
    "From: sender@example.invalid\r\nTo: archive@example.invalid\r\nMessage-ID: <standalone@example.invalid>\r\nSubject: Standalone\r\n\r\nSynthetic standalone body\r\n";
  const url =
    "http://localhost/cdn-cgi/local/email?from=sender@example.invalid&to=archive@example.invalid&format=json";
  const response = await standaloneRuntime.dispatchFetch(url, { method: "POST", body: raw });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.outcome, "ok");
  assert.equal(result.forwards.length, 0);
  const bucket = await standaloneRuntime.getR2Bucket("MAIL_ARCHIVE");
  const objects = (await bucket.list()).objects;
  assert.equal(objects.length, 2);
  const receipt = await (
    await bucket.get(objects.find((object) => object.key.endsWith("/receipt.json")).key)
  ).json();
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(receipt.forward, { status: "skipped", reason: "archive_only" });
  assert.equal(await (await bucket.get(receipt.archive.key)).text(), raw);
  const catalog = await standaloneRuntime.getD1Database("MAIL_CATALOG");
  for (const migration of await readD1Migrations("migrations")) {
    // oxlint-disable-next-line no-await-in-loop -- Migrations must run in order.
    await catalog.batch(migration.queries.map((query) => catalog.prepare(query)));
  }
  const scan = await standaloneRuntime.dispatchFetch(
    "http://localhost/cdn-cgi/local/scheduled?cron=*/5%20*%20*%20*%20*&format=json",
  );
  assert.equal((await scan.json()).outcome, "ok");
  assert.deepEqual(
    await catalog
      .prepare("SELECT raw_state,forward_status,receipt_state,notify_events FROM archive_sources")
      .first(),
    {
      raw_state: "present",
      forward_status: "skipped",
      receipt_state: "valid",
      notify_events: 1,
    },
  );
  // An unavailable raw archive must reach the native rejection path, never a
  // successful no-op or an accidental forwarding fallback.
  delete standaloneConfig.env.MAIL_ARCHIVE;
  await standaloneRuntime.setOptions({
    workers: [{ config: standaloneConfig }, ...workers.slice(1)],
    unsafeTriggerHandlers: true,
  });
  const rejected = await standaloneRuntime.dispatchFetch(url, { method: "POST", body: raw });
  const rejection = await rejected.json();
  assert.equal(rejection.forwards.length, 0);
  assert.equal(rejection.rejectReason, "Message could not be stored");
  console.log("Native standalone Email capture, catalog recovery and rejection: passed");
} finally {
  await standaloneRuntime.dispose();
}
