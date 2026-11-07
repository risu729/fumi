import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";

// Execute the built production bundle with native workerd email events and local R2.
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
  console.log("Native email event and built artifact: passed");
} finally {
  await runtime.dispose();
}
