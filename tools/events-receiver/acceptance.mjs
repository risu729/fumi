/** Production MCP Events acceptance against the temporary receiver.
 *
 * Runs from GitHub Actions only. It subscribes with an Access service token,
 * sends two controlled messages to the principal's own sender address, checks
 * single-key deliveries, rotates the signing secret and checks a dual-signature
 * delivery, then unsubscribes. It prints only booleans and counts: no event IDs,
 * addresses, secrets or callback URLs. */
import { appendFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as v from "valibot";

const CRON_PERIOD_MS = 300_000;
const POLL_MS = 20_000;

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const fumiOrigin = required("FUMI_ORIGIN");
const receiverOrigin = required("RECEIVER_ORIGIN");
const secrets = [required("SIGNING_SECRET_1"), required("SIGNING_SECRET_2")];
const readToken = required("READ_TOKEN");
const runKey = `${required("GITHUB_RUN_ID")}-${required("GITHUB_RUN_ATTEMPT")}`;
const callback = `${receiverOrigin}/events`;
const accessHeaders = {
  "CF-Access-Client-Id": required("ACCESS_CLIENT_ID"),
  "CF-Access-Client-Secret": required("ACCESS_CLIENT_SECRET"),
};

const subscribeResult = v.looseObject({ id: v.pipe(v.string(), v.regex(/^sub_[a-f0-9]{64}$/)) });
const emptyResult = v.looseObject({});
const listResult = v.looseObject({ events: v.array(v.looseObject({ name: v.string() })) });
const NAMES = ["email.received", "email.ready", "email.send_status_changed"];

const summary = ["### MCP Events acceptance", ""];
/** @param {string} label @param {boolean | number | string} value */
function report(label, value) {
  const line = `- ${label}: ${String(value)}`;
  summary.push(line);
  console.log(line);
}
/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @typedef {{ eventId: string, kind: string, name: string | null, presented: number, matchedKeys: number[], receivedAt: number }} DeliveryRecord */
/** @returns {Promise<{ deliveries: DeliveryRecord[], rejected: number }>} */
async function results() {
  const response = await fetch(`${receiverOrigin}/results`, {
    headers: { Authorization: `Bearer ${readToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Receiver results HTTP ${response.status}`);
  return response.json();
}
async function deliveries() {
  return (await results()).deliveries;
}
/** @param {string} label @param {number} timeoutMs @param {(records: DeliveryRecord[]) => boolean} done */
async function waitFor(label, timeoutMs, done) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Sequential polling of one receiver.
    if (done(await deliveries())) return true;
    // oxlint-disable-next-line no-await-in-loop -- Sequential polling of one receiver.
    await sleep(POLL_MS);
  }
  console.log(`Timed out waiting for ${label}.`);
  return false;
}
/** @param {DeliveryRecord} record */
const singleKey = (record) => record.presented === 1 && record.matchedKeys.join(",") === "0";
/** @param {DeliveryRecord} record */
const dualKey = (record) => record.presented === 2 && record.matchedKeys.join(",") === "0,1";
/** @param {DeliveryRecord[]} records */
const verifications = (records) => records.filter((record) => record.kind === "verification");

/** Wait until about 70 seconds before a five-minute Cron boundary. A rotation
 * made then keeps the previous secret until about four minutes after that
 * boundary, so the scheduled handler may spend most of that time on earlier
 * work before it signs the next delivery. */
async function alignBeforeCronTick() {
  const offset = Date.now() % CRON_PERIOD_MS;
  const target = CRON_PERIOD_MS - 70_000;
  await sleep((target - offset + CRON_PERIOD_MS) % CRON_PERIOD_MS);
}

const client = new Client({ name: "fumi-events-acceptance", version: "1" });
const transport = new StreamableHTTPClientTransport(new URL(`${fumiOrigin}/mcp`), {
  fetch: (url, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(accessHeaders)) headers.set(name, value);
    return fetch(url, { ...init, headers, redirect: "error" });
  },
});
/** @type {Map<string, string>} */
const subscriptions = new Map();
/** @param {string} name @param {string} secret */
async function subscribe(name, secret) {
  const result = await client.request(
    {
      method: "events/subscribe",
      params: { name, arguments: {}, delivery: { mode: "webhook", url: callback, secret } },
    },
    subscribeResult,
  );
  subscriptions.set(name, result.id);
}
/** @param {number} index @param {string} address */
async function send(index, address) {
  const result = await client.callTool({
    name: "send_email",
    arguments: {
      to: [address],
      from_address: address,
      subject: `fumi MCP Events acceptance ${index}`,
      payload: { text: `Synthetic MCP Events acceptance message ${index}.` },
      idempotency_key: `events-acceptance-${runKey}-${index}`,
    },
  });
  const state = result.structuredContent?.state ?? "unknown";
  report(`send ${index} state`, state);
  if (result.isError) throw new Error(`Send ${index} failed`);
}

let passed = false;
try {
  await client.connect(transport);
  const profile = await client.callTool({ name: "get_profile", arguments: {} });
  const address = profile.structuredContent?.from_addresses?.[0];
  if (!address) throw new Error("The acceptance principal has no sender address");
  console.log(`::add-mask::${address}`);

  const listed = await client.request({ method: "events/list", params: {} }, listResult);
  const available = NAMES.every((name) => listed.events.some((event) => event.name === name));
  report("events/list offers received, ready and send_status_changed", available);
  if (!available) throw new Error("Event scopes are missing");

  for (const name of NAMES) {
    // oxlint-disable-next-line no-await-in-loop -- Subscribe sequentially to share one verification.
    await subscribe(name, secrets[0]);
  }
  const verified = verifications(await deliveries()).some(singleKey);
  report("callback verification signed with the first secret", verified);

  await send(1, address);
  const firstSeen = new Set();
  const single = await waitFor("single-signature deliveries", 20 * 60_000, (records) => {
    for (const record of records)
      if (record.kind === "event" && singleKey(record) && record.name) firstSeen.add(record.name);
    return NAMES.every((name) => firstSeen.has(name));
  });
  for (const name of NAMES)
    report(`${name} delivered with one valid signature`, firstSeen.has(name));

  await alignBeforeCronTick();
  await send(2, address);
  // Compare by receiver record order, not by runner and Worker clocks.
  const before = await deliveries();
  const verifiedBefore = verifications(before).length;
  for (const name of NAMES) {
    // oxlint-disable-next-line no-await-in-loop -- Rotate each subscription in turn.
    await subscribe(name, secrets[1]);
  }
  const rotationVerified = verifications(await deliveries())
    .slice(verifiedBefore)
    .some((record) => record.presented === 1 && record.matchedKeys.join(",") === "1");
  report("rotation callback verification signed with the second secret", rotationVerified);
  const dualSeen = new Set();
  const dual = await waitFor("dual-signature delivery", 8 * 60_000, (records) => {
    for (const record of records.slice(before.length))
      if (record.kind === "event" && dualKey(record) && record.name) dualSeen.add(record.name);
    return dualSeen.has("email.send_status_changed");
  });
  for (const name of NAMES)
    report(`${name} delivered with both rotation signatures`, dualSeen.has(name));

  const all = await results();
  report("rejected deliveries", all.rejected);
  report("accepted event deliveries", all.deliveries.filter((r) => r.kind === "event").length);
  passed = verified && single && rotationVerified && dual;
} catch (error) {
  // SDK errors can include response bodies, and this log is public.
  report("aborted", error instanceof Error ? error.name : "unknown");
} finally {
  for (const [name, id] of subscriptions) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Best-effort cleanup of each subscription.
      await client.request({ method: "events/unsubscribe", params: { id } }, emptyResult);
      report(`${name} unsubscribed`, true);
    } catch {
      report(`${name} unsubscribed`, false);
    }
  }
  await client.close().catch(() => undefined);
  report("passed", passed);
  if (process.env["GITHUB_STEP_SUMMARY"])
    appendFileSync(process.env["GITHUB_STEP_SUMMARY"], `${summary.join("\n")}\n`);
}
if (!passed) process.exitCode = 1;
