import * as v from "valibot";
import type { RoutingMetadata, ShadowDecision } from "./routing.ts";
import { parseReceipt } from "./receipt-schema.ts";
import {
  notificationAdapterSchema,
  canonicalOfferJson,
  dispatchDigest,
  exchangeOffer,
  exchangeWebhook,
  readDispatchBytes,
} from "./plugin-offer.ts";
import type {
  OfferReceipt,
  OfferTransport,
  NotificationAdapter,
  RoutingOfferService,
} from "./plugin-offer.ts";
import { loadDispatchConfiguration } from "./routing-dispatch-config.ts";
import type { DispatchConfiguration, OfferField } from "./routing-dispatch-config.ts";

export interface RoutingDispatchSource {
  rawKey: string;
  rawSha256: string;
  extractionUpdatedAt: number;
  receivedAt: string | null;
  metadata: RoutingMetadata;
  metadataJson: string;
  bodyJsonKey: string;
  bodyTextKey: string | null;
  manifestKey: string;
  envelope: { from: string; to: string } | null;
}
export interface RoutingFallback {
  outcome: "review" | "ignore" | "hold";
  category: string | null;
  urgent: boolean;
  evidenceCode: string;
}
export interface RoutingDispatchRuntime {
  resolveFallback?(
    source: RoutingDispatchSource,
    decision: ShadowDecision,
  ): Promise<RoutingFallback>;
  gateNotification?(
    source: RoutingDispatchSource,
    resolution: RoutingFallback,
    operationId: string,
  ): Promise<{ outcome: "allow" | "ignore" | "hold"; evidenceCode: string }>;
  transport?: OfferTransport;
  now?: () => number;
}
export interface RoutingDispatchEnvironment {
  MAIL_ARCHIVE: R2Bucket;
  MAIL_CATALOG: D1Database;
  ROUTING_DISPATCH_AUTH?: string;
  ROUTING_DISPATCH_SERVICE?: Fetcher;
  ROUTING_DISPATCH_RPC?: RoutingOfferService;
}
declare global {
  interface Env {
    ROUTING_DISPATCH_AUTH?: string;
    ROUTING_DISPATCH_SERVICE?: Fetcher;
    ROUTING_DISPATCH_RPC?: RoutingOfferService;
  }
}
interface Control {
  revision: number;
  generation: number;
  configuration_sha256: string;
  destination_sha256: string;
  accepting: number;
  paused: number;
}
interface Outbox {
  operation_id: string;
  raw_key: string;
  lane: string;
  revision: number;
  generation: number;
  source_sha256: string;
  extraction_updated_at: number;
  manifest_key: string;
  target_id: string;
  adapter_json: string;
  credential_sha256: string | null;
  payload_json: string;
  request_sha256: string;
  grant_fields_json: string;
  state:
    | "ready"
    | "sending"
    | "retry"
    | "uncertain"
    | "handled"
    | "accepted"
    | "not_applicable"
    | "rejected"
    | "revoked"
    | "dead";
  attempts: number;
  attempt_expires_at: number;
  reconciliation_attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number;
  receipt_json: string | null;
  failure_code: string | null;
}
interface SourceRow {
  raw_key: string;
  raw_sha256: string;
  updated_at: number;
  metadata_json: string;
  attachment_count: number;
  body_json_key: string;
  body_text_key: string | null;
  manifest_key: string;
  received_at: string | null;
  receipt_snapshot: string | null;
}
type Session = D1DatabaseSession;
const LIMIT = 3;
const LEASE = 180_000;
const MAX_ATTEMPTS = 5;
const MAX_RECONCILIATIONS = 5;
const reasonPattern = /^[a-z][a-z0-9_]{0,63}$/;
const fieldText = v.pipe(v.string(), v.maxLength(4096));
const mailbox = v.object({ address: fieldText });
const metadataSchema = v.object({
  subject: v.nullable(fieldText),
  from: v.nullable(mailbox),
  to: v.pipe(v.array(mailbox), v.maxLength(32)),
});
const fallbackSchema = v.strictObject({
  outcome: v.picklist(["review", "ignore", "hold"]),
  category: v.nullable(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/))),
  urgent: v.boolean(),
  evidenceCode: v.pipe(v.string(), v.regex(reasonPattern)),
});
const gateSchema = v.strictObject({
  outcome: v.picklist(["allow", "ignore", "hold"]),
  evidenceCode: v.pipe(v.string(), v.regex(reasonPattern)),
});

function transportFor(
  env: RoutingDispatchEnvironment,
  runtime: RoutingDispatchRuntime,
): OfferTransport {
  if (runtime.transport) return runtime.transport;
  let auth: Record<string, string> = {};
  try {
    const json = env.ROUTING_DISPATCH_AUTH ?? "{}";
    if (json.length <= 64 * 1024)
      auth = v.parse(v.record(v.string(), v.string()), JSON.parse(json) as unknown);
  } catch {
    /* Missing or malformed credentials fail closed. */
  }
  return {
    auth,
    services: env.ROUTING_DISPATCH_SERVICE ? { default: env.ROUTING_DISPATCH_SERVICE } : {},
    rpcServices: env.ROUTING_DISPATCH_RPC ? { default: env.ROUTING_DISPATCH_RPC } : {},
  };
}
function snapshotRuntime(
  env: RoutingDispatchEnvironment,
  runtime: RoutingDispatchRuntime,
): RoutingDispatchRuntime {
  const transport = transportFor(env, runtime);
  return {
    ...runtime,
    transport: {
      ...transport,
      auth: Object.freeze({ ...transport.auth }),
      ...(transport.services ? { services: Object.freeze({ ...transport.services }) } : {}),
      ...(transport.rpcServices
        ? { rpcServices: Object.freeze({ ...transport.rpcServices }) }
        : {}),
    },
  };
}
function ready(adapter: NotificationAdapter, transport: OfferTransport) {
  if (adapter.kind === "rpc") return !!transport.rpcServices?.[adapter.serviceRef];
  const secret = transport.auth[adapter.authRef];
  return (
    typeof secret === "string" &&
    secret.length >= 24 &&
    secret.length <= 4096 &&
    !/[\r\n]/.test(secret) &&
    (adapter.kind === "webhook"
      ? true
      : adapter.kind === "https"
        ? adapter.serviceRef === null
        : !!adapter.serviceRef && !!transport.services?.[adapter.serviceRef])
  );
}
async function credentialIdentity(
  adapter: NotificationAdapter,
  transport: OfferTransport,
): Promise<string | null> {
  if (adapter.kind === "rpc") return null;
  const secret = transport.auth[adapter.authRef];
  return secret ? dispatchDigest(JSON.stringify(["fumi-routing-credential-v1", secret])) : null;
}
async function bindDestinationIdentity(config: DispatchConfiguration, transport: OfferTransport) {
  if (config.artifact.destination.adapter.kind !== "rpc")
    config.destinationSha256 = await dispatchDigest(
      JSON.stringify([
        config.destinationSha256,
        await credentialIdentity(config.artifact.destination.adapter, transport),
      ]),
    );
}
async function boundedCallback<T>(pending: Promise<T>, deadlineMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Routing callback deadline")), deadlineMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export async function routingOperationId(rawKey: string, lane: string): Promise<string> {
  return dispatchDigest(JSON.stringify(["fumi-routing-v1", rawKey, lane]));
}

async function source(db: Session, rawKey: string): Promise<RoutingDispatchSource | null> {
  const row = await db
    .prepare(`SELECT e.raw_key,e.raw_sha256,e.updated_at,e.metadata_json,e.attachment_count,
    e.body_json_key,e.body_text_key,e.manifest_key,s.received_at,s.receipt_snapshot
    FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
    WHERE e.raw_key=? AND e.extractor_version='mime-v1' AND e.status='complete' AND s.raw_state='present'
    AND s.source_kind='email_routing' AND s.notify_events=1 AND s.raw_sha256=e.raw_sha256`)
    .bind(rawKey)
    .first<SourceRow>();
  if (!row || row.metadata_json.length > 32 * 1024) return null;
  try {
    const parsed = v.parse(metadataSchema, JSON.parse(row.metadata_json) as unknown);
    const metadata: RoutingMetadata = {
      subject: parsed.subject ?? "",
      from: parsed.from?.address ?? "",
      to: parsed.to.map((address) => address.address).join(","),
      hasAttachments: row.attachment_count > 0,
    };
    let envelope: RoutingDispatchSource["envelope"] = null;
    if (row.receipt_snapshot && row.receipt_snapshot.length <= 16 * 1024) {
      const receipt = parseReceipt(JSON.parse(row.receipt_snapshot) as unknown);
      if (
        receipt?.archive.status === "stored" &&
        receipt.archive.key === row.raw_key &&
        receipt.archive.sha256 === row.raw_sha256 &&
        receipt.receivedAt === row.received_at
      )
        envelope = receipt.envelope;
    }
    return {
      rawKey: row.raw_key,
      rawSha256: row.raw_sha256,
      extractionUpdatedAt: row.updated_at,
      receivedAt: row.received_at,
      metadata,
      metadataJson: row.metadata_json,
      bodyJsonKey: row.body_json_key,
      bodyTextKey: row.body_text_key,
      manifestKey: row.manifest_key,
      envelope,
    };
  } catch {
    return null;
  }
}
async function job(
  db: Session,
  item: RoutingDispatchSource,
  revision: number,
  state: string,
  reason: string | null,
  now: number,
  token: string,
) {
  await db
    .prepare(`UPDATE routing_dispatch_jobs SET source_sha256=?,extraction_updated_at=?,revision=?,state=?,
    failure_code=?,next_attempt_at=?,updated_at=? WHERE raw_key=? AND lease_token=?`)
    .bind(
      item.rawSha256,
      item.extractionUpdatedAt,
      revision,
      state,
      reason,
      now + 30_000,
      now,
      item.rawKey,
      token,
    )
    .run();
}

/** A newer desired revision closes offers before handoff. It cannot activate until
 * all prior in-flight/ambiguous outcomes have durable receipt reconciliation. */
async function observe(
  db: Session,
  config: DispatchConfiguration,
): Promise<"active" | "draining" | "paused" | "stale"> {
  const a = config.artifact;
  await db
    .prepare(`INSERT OR IGNORE INTO routing_dispatch_control(id,revision,generation,configuration_sha256,destination_sha256,accepting)
    VALUES(1,?,?,?,?,?)`)
    .bind(
      a.revision,
      a.generation,
      config.configurationSha256,
      config.destinationSha256,
      a.enabled ? 1 : 0,
    )
    .run();
  const current = await db
    .prepare("SELECT * FROM routing_dispatch_control WHERE id=1")
    .first<Control>();
  if (!current) throw new Error("Dispatch control unavailable");
  if (!a.enabled) {
    await db.prepare("UPDATE routing_dispatch_control SET accepting=0 WHERE id=1").run();
    return "paused";
  }
  if (
    a.revision < current.revision ||
    a.generation < current.generation ||
    (a.revision === current.revision &&
      config.configurationSha256 !== current.configuration_sha256) ||
    (a.generation === current.generation && config.destinationSha256 !== current.destination_sha256)
  )
    return "stale";
  if (a.revision > current.revision || !a.enabled) {
    await db.batch([
      db
        .prepare("UPDATE routing_dispatch_control SET accepting=0 WHERE id=1 AND revision<=?")
        .bind(a.revision),
      db
        .prepare(`UPDATE routing_dispatch_outbox SET state='revoked',failure_code='configuration_revoked',updated_at=?
        WHERE state IN ('ready','retry') AND revision<?`)
        .bind(Date.now(), a.revision),
    ]);
    await db
      .prepare(`UPDATE routing_dispatch_control SET revision=?,generation=?,configuration_sha256=?,destination_sha256=?,accepting=?
      WHERE id=1 AND revision<? AND NOT EXISTS(SELECT 1 FROM routing_dispatch_outbox WHERE state IN ('sending','uncertain'))`)
      .bind(
        a.revision,
        a.generation,
        config.configurationSha256,
        config.destinationSha256,
        a.enabled ? 1 : 0,
        a.revision,
      )
      .run();
  }
  const active = await db
    .prepare("SELECT * FROM routing_dispatch_control WHERE id=1")
    .first<Control>();
  if (active?.paused) return "paused";
  return active?.configuration_sha256 === config.configurationSha256 &&
    active.accepting &&
    a.enabled
    ? "active"
    : "draining";
}

export async function drainRoutingDispatch(database: D1Database): Promise<void> {
  await database
    .withSession("first-primary")
    .prepare("UPDATE routing_dispatch_control SET accepting=0,paused=1 WHERE id=1")
    .run();
}
export async function activateRoutingDispatch(
  env: RoutingDispatchEnvironment,
  runtime: RoutingDispatchRuntime = {},
): Promise<string> {
  const config = await loadDispatchConfiguration(env.MAIL_ARCHIVE);
  if (!config?.artifact.enabled) return "disabled";
  await bindDestinationIdentity(config, transportFor(env, runtime));
  const db = env.MAIL_CATALOG.withSession("first-primary");
  const state = await observe(db, config);
  if (state === "draining" || state === "stale") return state;
  const update = await db
    .prepare(`UPDATE routing_dispatch_control SET accepting=1,paused=0 WHERE id=1 AND configuration_sha256=?
    AND NOT EXISTS(SELECT 1 FROM routing_dispatch_outbox WHERE state IN ('sending','uncertain'))`)
    .bind(config.configurationSha256)
    .run();
  return update.meta.changes === 1 ? "active" : "draining";
}

async function saveReceipt(
  db: Session,
  row: Outbox,
  receipt: OfferReceipt,
  now: number,
  token?: string,
  httpAcceptance = false,
) {
  if (receipt.operationId !== row.operation_id || receipt.requestSha256 !== row.request_sha256)
    throw new Error("Receipt identity mismatch");
  let state: Outbox["state"] =
    receipt.result === "not_found" || receipt.result === "retryable_error"
      ? "retry"
      : receipt.result;
  if (httpAcceptance && state === "handled") state = "accepted";
  if (row.lane === "action" && receipt.result === "not_applicable") state = "rejected";
  if (state === "retry" && row.attempts >= MAX_ATTEMPTS) state = "dead";
  const failure =
    state === "dead"
      ? "retry_exhausted"
      : state === "rejected"
        ? "adapter_rejected"
        : state === "uncertain"
          ? "outcome_uncertain"
          : state === "accepted"
            ? "http_acceptance_only"
            : null;
  const result = await db
    .prepare(`UPDATE routing_dispatch_outbox SET state=?,receipt_json=?,failure_code=?,
    next_attempt_at=?,lease_token=NULL,lease_until=0,updated_at=? WHERE operation_id=? AND request_sha256=?
    ${token ? "AND lease_token=?" : "AND state='uncertain'"}`)
    .bind(
      state,
      JSON.stringify(receipt),
      failure,
      state === "uncertain"
        ? Math.max(row.attempt_expires_at + 1, now + Math.min(3_600_000, 1000 * 2 ** row.attempts))
        : now + Math.min(3_600_000, 1000 * 2 ** row.attempts),
      now,
      row.operation_id,
      row.request_sha256,
      ...(token ? [token] : []),
    )
    .run();
  return result.meta.changes === 1;
}

/** Administrative receipt recording requires authenticated operator wiring plus
 * externally verified owner evidence. It is not exposed to mail/model callers. */
export async function recordRoutingDispatchReceipt(
  database: D1Database,
  receipt: OfferReceipt,
): Promise<void> {
  const db = database.withSession("first-primary");
  const row = await db
    .prepare("SELECT * FROM routing_dispatch_outbox WHERE operation_id=? AND state='uncertain'")
    .bind(receipt.operationId)
    .first<Outbox>();
  if (
    !row ||
    !["handled", "not_applicable", "rejected", "not_found", "retryable_error"].includes(
      receipt.result,
    ) ||
    (["not_found", "retryable_error"].includes(receipt.result) &&
      row.attempt_expires_at > Date.now())
  )
    throw new Error("Invalid routing receipt");
  const adapter = v.parse(notificationAdapterSchema, JSON.parse(row.adapter_json) as unknown);
  if (adapter.kind === "webhook" && !["handled", "rejected"].includes(receipt.result))
    throw new Error("Webhook outcome requires verified evidence");
  if (!(await saveReceipt(db, row, receipt, Date.now(), undefined, adapter.kind === "webhook")))
    throw new Error("Routing receipt no longer current");
}

export async function routingDispatchStatus(database: D1Database) {
  const db = database.withSession("first-primary");
  const control = await db
    .prepare("SELECT revision,generation,accepting,paused FROM routing_dispatch_control WHERE id=1")
    .first();
  const counts = await db
    .prepare("SELECT state,COUNT(*) AS count FROM routing_dispatch_outbox GROUP BY state")
    .all<{ state: string; count: number }>();
  const held = await db
    .prepare(`SELECT operation_id,request_sha256,lane,generation,state,failure_code FROM routing_dispatch_outbox
    WHERE state IN ('dead','rejected','uncertain') ORDER BY updated_at,operation_id LIMIT 20`)
    .all();
  const heldJobs = await db
    .prepare(`SELECT raw_key,state,failure_code,revision FROM routing_dispatch_jobs
    WHERE state IN ('held','dead') ORDER BY updated_at,raw_key LIMIT 20`)
    .all();
  const jobCounts = await db
    .prepare(
      "SELECT state,failure_code,COUNT(*) AS count FROM routing_dispatch_jobs GROUP BY state,failure_code",
    )
    .all();
  return {
    control,
    counts: counts.results,
    held: held.results,
    heldJobs: heldJobs.results,
    jobCounts: jobCounts.results,
  };
}

export async function reconcileRoutingDispatch(
  env: RoutingDispatchEnvironment,
  runtime: RoutingDispatchRuntime = {},
  rawKey?: string,
) {
  runtime = snapshotRuntime(env, runtime);
  const now = runtime.now?.() ?? Date.now();
  const db = env.MAIL_CATALOG.withSession("first-primary");
  const transport = transportFor(env, runtime);
  await db
    .prepare(`UPDATE routing_dispatch_outbox SET state='uncertain',failure_code='interrupted_attempt',lease_token=NULL,
    lease_until=0 WHERE operation_id IN (SELECT operation_id FROM routing_dispatch_outbox
      WHERE state='sending' AND lease_until<=? AND (? IS NULL OR raw_key=?) ORDER BY lease_until,operation_id LIMIT ?)`)
    .bind(now, rawKey ?? null, rawKey ?? null, LIMIT)
    .run();
  const rows = await db
    .prepare(`SELECT * FROM routing_dispatch_outbox WHERE state='uncertain' AND lease_until<=?
    AND next_attempt_at<=? AND attempt_expires_at<=? AND reconciliation_attempts<? AND (? IS NULL OR raw_key=?)
    ORDER BY next_attempt_at,operation_id LIMIT ?`)
    .bind(now, now, now, MAX_RECONCILIATIONS, rawKey ?? null, rawKey ?? null, LIMIT)
    .all<Outbox>();
  let checked = 0;
  for (const row of rows.results) {
    const adapter = v.parse(notificationAdapterSchema, JSON.parse(row.adapter_json) as unknown);
    if (adapter.kind === "webhook") {
      // oxlint-disable-next-line no-await-in-loop -- Generic providers have no status contract and require verified manual reconciliation.
      await db
        .prepare(
          "UPDATE routing_dispatch_outbox SET failure_code='manual_reconciliation_required',next_attempt_at=? WHERE operation_id=? AND state='uncertain'",
        )
        .bind(Number.MAX_SAFE_INTEGER, row.operation_id)
        .run();
      continue;
    }
    if (!ready(adapter, transport)) continue;
    // The old operation must be queried using its original account credential,
    // never a new token repurposed under the same reference.
    // oxlint-disable-next-line no-await-in-loop -- At most three local credential fingerprints per reconciliation.
    if ((await credentialIdentity(adapter, transport)) !== row.credential_sha256) {
      // oxlint-disable-next-line no-await-in-loop -- Fail closed without sending even an identity/hash status request.
      await db
        .prepare(
          "UPDATE routing_dispatch_outbox SET failure_code='credentials_changed',next_attempt_at=? WHERE operation_id=? AND state='uncertain'",
        )
        .bind(now + 60_000, row.operation_id)
        .run();
      continue;
    }
    const token = crypto.randomUUID();
    // oxlint-disable-next-line no-await-in-loop -- Sequential leases cap reconciliation fan-out.
    const lease = await db
      .prepare(`UPDATE routing_dispatch_outbox SET lease_token=?,lease_until=?,reconciliation_attempts=reconciliation_attempts+1
      WHERE operation_id=? AND state='uncertain' AND lease_until<=?`)
      .bind(token, now + 30_000, row.operation_id, now)
      .run();
    if (lease.meta.changes !== 1) continue;
    checked++;
    // Status carries only stable operation identity and request hash, never new mail fields.
    // oxlint-disable-next-line no-await-in-loop -- One authenticated, bounded status call per lease.
    const receipt = await exchangeOffer(
      adapter,
      transport,
      row.operation_id,
      row.request_sha256,
      "",
      true,
    );
    // oxlint-disable-next-line no-await-in-loop -- Persist each result before advancing the bounded batch.
    await saveReceipt(db, row, receipt, now, token);
    if (receipt.result === "uncertain") {
      // oxlint-disable-next-line no-await-in-loop -- Exhausted ambiguity remains quarantined and blocks target handoff.
      await db
        .prepare(
          `UPDATE routing_dispatch_outbox SET failure_code=?,next_attempt_at=? WHERE operation_id=? AND state='uncertain'`,
        )
        .bind(
          row.reconciliation_attempts + 1 >= MAX_RECONCILIATIONS
            ? "reconciliation_exhausted"
            : "outcome_uncertain",
          row.reconciliation_attempts + 1 >= MAX_RECONCILIATIONS
            ? Number.MAX_SAFE_INTEGER
            : now + 60_000,
          row.operation_id,
        )
        .run();
    }
  }
  return { checked };
}

async function projectedInput(
  env: RoutingDispatchEnvironment,
  item: RoutingDispatchSource,
  fields: readonly OfferField[],
) {
  const input: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === "envelope") {
      if (!item.envelope || !item.receivedAt) throw new Error("Trusted envelope unavailable");
      input[field] = { ...item.envelope, receivedAt: item.receivedAt };
    } else if (field !== "text") input[field] = item.metadata[field];
  }
  if (fields.includes("text")) {
    if (!item.bodyTextKey) throw new Error("Granted text unavailable");
    const manifestObject = await env.MAIL_ARCHIVE.get(item.manifestKey);
    if (!manifestObject || manifestObject.size > 128 * 1024) {
      if (manifestObject)
        await Promise.race([
          manifestObject.body.cancel().catch(() => undefined),
          Promise.resolve(),
        ]);
      throw new Error("Granted text unavailable");
    }
    const referenceSchema = v.object({
      rawSha256: v.literal(item.rawSha256),
      body: v.object({
        text: v.object({
          key: v.literal(item.bodyTextKey),
          sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
          size: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(16 * 1024)),
        }),
      }),
    });
    const manifest = v.parse(
      referenceSchema,
      JSON.parse(await readDispatchBytes(manifestObject.body, 128 * 1024, 5000)) as unknown,
    );
    const object = await env.MAIL_ARCHIVE.get(item.bodyTextKey);
    if (!object || object.size !== manifest.body.text.size) {
      if (object)
        await Promise.race([object.body.cancel().catch(() => undefined), Promise.resolve()]);
      throw new Error("Granted text unavailable");
    }
    const text = await readDispatchBytes(object.body, 16 * 1024, 5000);
    if ((await dispatchDigest(text)) !== manifest.body.text.sha256)
      throw new Error("Granted text unavailable");
    input["text"] = text;
  }
  return input;
}

async function currentFence(
  env: RoutingDispatchEnvironment,
  db: Session,
  config: DispatchConfiguration,
  token: string,
  item: RoutingDispatchSource,
) {
  const current = await loadDispatchConfiguration(env.MAIL_ARCHIVE);
  if (!current?.artifact.enabled || current.configurationSha256 !== config.configurationSha256)
    return false;
  return !!(await db
    .prepare(`SELECT 1 FROM routing_dispatch_control c JOIN mail_extractions e ON e.raw_key=?
    JOIN routing_dispatch_jobs j ON j.raw_key=e.raw_key
    JOIN archive_sources s ON s.raw_key=e.raw_key WHERE c.id=1 AND c.accepting=1 AND c.paused=0
    AND c.configuration_sha256=? AND j.lease_token=? AND j.lease_until>?
    AND e.extractor_version='mime-v1' AND e.status='complete' AND e.raw_sha256=? AND e.updated_at=? AND e.manifest_key=?
    AND s.source_kind='email_routing' AND s.notify_events=1 AND s.raw_state='present' AND s.raw_sha256=e.raw_sha256`)
    .bind(
      item.rawKey,
      config.configurationSha256,
      token,
      Date.now(),
      item.rawSha256,
      item.extractionUpdatedAt,
      item.manifestKey,
    )
    .first());
}

async function attempt(
  env: RoutingDispatchEnvironment,
  db: Session,
  config: DispatchConfiguration,
  globalToken: string,
  item: RoutingDispatchSource,
  lane: string,
  targetId: string,
  adapter: NotificationAdapter,
  fields: OfferField[],
  payloadExtra: Record<string, unknown>,
  runtime: RoutingDispatchRuntime,
  budget: { remaining: number },
  resolution?: RoutingFallback,
): Promise<Outbox["state"] | "held" | { state: "ignored"; evidenceCode: string }> {
  const operationId = await routingOperationId(item.rawKey, lane);
  let row = await db
    .prepare("SELECT * FROM routing_dispatch_outbox WHERE operation_id=?")
    .bind(operationId)
    .first<Outbox>();
  if (row && ["handled", "accepted", "not_applicable", "rejected", "dead"].includes(row.state))
    return row.state;
  if (row?.state === "uncertain" || row?.state === "sending") return row.state;
  if (
    row &&
    row.attempts === 0 &&
    (row.revision !== config.artifact.revision ||
      row.source_sha256 !== item.rawSha256 ||
      row.extraction_updated_at !== item.extractionUpdatedAt ||
      row.manifest_key !== item.manifestKey)
  ) {
    await db
      .prepare(
        "DELETE FROM routing_dispatch_outbox WHERE operation_id=? AND attempts=0 AND state IN ('ready','revoked')",
      )
      .bind(operationId)
      .run();
    row = await db
      .prepare("SELECT * FROM routing_dispatch_outbox WHERE operation_id=?")
      .bind(operationId)
      .first<Outbox>();
  }
  if (
    row &&
    (row.source_sha256 !== item.rawSha256 ||
      row.extraction_updated_at !== item.extractionUpdatedAt ||
      row.manifest_key !== item.manifestKey)
  )
    return "held";
  const now = runtime.now?.() ?? Date.now();
  if (row && row.next_attempt_at > now && row.state !== "revoked") return row.state;
  const transport = transportFor(env, runtime);
  if (!ready(adapter, transport)) return "held";
  const fingerprint = await credentialIdentity(adapter, transport);
  if (row && row.credential_sha256 !== fingerprint) {
    const noEffect = row.receipt_json
      ? (JSON.parse(row.receipt_json) as { result?: string }).result
      : null;
    if (
      !(
        row.state === "revoked" &&
        row.generation < config.artifact.generation &&
        (noEffect === "retryable_error" || noEffect === "not_found")
      )
    )
      return "held";
  }
  if (row && JSON.stringify(fields) !== row.grant_fields_json) return "held";
  if (row && lane === "action" && resolution) {
    const frozen = JSON.parse(row.payload_json) as {
      classification?: { category: string | null; urgent: boolean };
    };
    if (
      !frozen.classification ||
      frozen.classification.category !== resolution.category ||
      frozen.classification.urgent !== resolution.urgent
    )
      return "held";
  }
  if (!row) {
    const input = await projectedInput(env, item, fields);
    const body = canonicalOfferJson({
      schemaVersion: 1,
      kind: lane === "action" ? "notification" : "owner",
      operationId,
      source: {
        eventId: await dispatchDigest(JSON.stringify(["fumi-event-v1", item.rawKey])),
        rawSha256: item.rawSha256,
        receivedAt: item.receivedAt,
      },
      ...payloadExtra,
      input,
    });
    if (new TextEncoder().encode(body).byteLength > 32 * 1024) return "held";
    const hash = await dispatchDigest(body);
    await db
      .prepare(`INSERT OR IGNORE INTO routing_dispatch_outbox(operation_id,raw_key,lane,revision,generation,source_sha256,
      extraction_updated_at,manifest_key,target_id,adapter_json,credential_sha256,payload_json,request_sha256,grant_fields_json,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?)`)
      .bind(
        operationId,
        item.rawKey,
        lane,
        config.artifact.revision,
        config.artifact.generation,
        item.rawSha256,
        item.extractionUpdatedAt,
        item.manifestKey,
        targetId,
        JSON.stringify(adapter),
        fingerprint,
        body,
        hash,
        JSON.stringify(fields),
        now,
        now,
      )
      .run();
    row = await db
      .prepare("SELECT * FROM routing_dispatch_outbox WHERE operation_id=?")
      .bind(operationId)
      .first<Outbox>();
  }
  if (!row) return "held";
  const ignore = async (evidenceCode: string) => {
    await db
      .prepare(`UPDATE routing_dispatch_outbox SET state='revoked',failure_code=?,updated_at=?
      WHERE operation_id=? AND state IN ('ready','retry','revoked')`)
      .bind(evidenceCode, now, operationId)
      .run();
    return { state: "ignored" as const, evidenceCode };
  };
  if (lane === "action") {
    if (!resolution || !runtime.gateNotification) return "held";
    const gate = v.parse(
      gateSchema,
      await boundedCallback(runtime.gateNotification(item, resolution, operationId)),
    );
    if (gate.outcome === "ignore") return ignore(gate.evidenceCode);
    if (gate.outcome !== "allow") return "held";
  }
  if (budget.remaining <= 0 || !(await currentFence(env, db, config, globalToken, item)))
    return "held";
  if (lane === "action" && resolution && runtime.gateNotification) {
    const gate = v.parse(
      gateSchema,
      await boundedCallback(runtime.gateNotification(item, resolution, operationId)),
    );
    if (gate.outcome === "ignore") return ignore(gate.evidenceCode);
    if (gate.outcome !== "allow") return "held";
  }
  const token = crypto.randomUUID();
  const attemptExpiresAt = Date.now() + adapter.timeoutMs;
  const claimed = await db
    .prepare(`UPDATE routing_dispatch_outbox SET state='sending',lease_token=?,lease_until=?,attempts=attempts+1,attempt_expires_at=?,
    revision=?,generation=?,target_id=?,adapter_json=?,credential_sha256=?,updated_at=? WHERE operation_id=? AND state IN ('ready','retry','revoked')
    AND attempts<? AND EXISTS(SELECT 1 FROM routing_dispatch_control c JOIN routing_dispatch_jobs j ON j.raw_key=?
      JOIN mail_extractions e ON e.raw_key=j.raw_key JOIN archive_sources s ON s.raw_key=e.raw_key
      WHERE c.id=1 AND c.accepting=1 AND c.paused=0 AND j.lease_token=? AND c.configuration_sha256=? AND j.lease_until>?
      AND e.extractor_version='mime-v1' AND e.status='complete' AND e.raw_sha256=? AND e.updated_at=? AND e.manifest_key=?
      AND s.source_kind='email_routing' AND s.notify_events=1 AND s.raw_state='present' AND s.raw_sha256=e.raw_sha256)`)
    .bind(
      token,
      Date.now() + 30_000,
      attemptExpiresAt,
      config.artifact.revision,
      config.artifact.generation,
      targetId,
      JSON.stringify(adapter),
      fingerprint,
      now,
      operationId,
      MAX_ATTEMPTS,
      item.rawKey,
      globalToken,
      config.configurationSha256,
      Date.now(),
      item.rawSha256,
      item.extractionUpdatedAt,
      item.manifestKey,
    )
    .run();
  if (claimed.meta.changes !== 1) return "held";
  budget.remaining--;
  if (adapter.kind === "webhook") {
    const state = await exchangeWebhook(
      adapter,
      transport,
      operationId,
      row.request_sha256,
      row.payload_json,
    );
    await db
      .prepare(`UPDATE routing_dispatch_outbox SET state=?,failure_code=?,lease_token=NULL,lease_until=0,updated_at=?,next_attempt_at=?
      WHERE operation_id=? AND lease_token=? AND state='sending'`)
      .bind(
        state,
        state === "accepted" ? "http_acceptance_only" : "manual_reconciliation_required",
        Date.now(),
        state === "uncertain" ? Number.MAX_SAFE_INTEGER : now,
        operationId,
        token,
      )
      .run();
    return state;
  }
  // No configuration, authorization or data lookup is started after this claim.
  // Interruption or missing acknowledgement leaves the durable sending row uncertain.
  const receipt = await exchangeOffer(
    adapter,
    transport,
    operationId,
    row.request_sha256,
    row.payload_json,
    false,
    { generation: config.artifact.generation, expiresAt: attemptExpiresAt },
  );
  await saveReceipt(
    db,
    { ...row, attempts: row.attempts + 1, attempt_expires_at: attemptExpiresAt },
    receipt,
    now,
    token,
  );
  return lane === "action" && receipt.result === "not_applicable"
    ? "rejected"
    : receipt.result === "retryable_error"
      ? row.attempts + 1 >= MAX_ATTEMPTS
        ? "dead"
        : "retry"
      : receipt.result === "not_found"
        ? "uncertain"
        : receipt.result;
}

async function routeOne(
  env: RoutingDispatchEnvironment,
  db: Session,
  config: DispatchConfiguration,
  token: string,
  item: RoutingDispatchSource,
  runtime: RoutingDispatchRuntime,
  budget: { remaining: number },
) {
  const decision = config.router.evaluate(item.metadata, "live");
  const now = runtime.now?.() ?? Date.now();
  const prior = await db
    .prepare(`SELECT state FROM routing_dispatch_outbox WHERE raw_key=?
    AND (state IN ('handled','accepted','sending','uncertain') OR (lane!='action' AND state IN ('rejected','dead')))
    ORDER BY CASE WHEN state IN ('handled','accepted') THEN 0 ELSE 1 END LIMIT 1`)
    .bind(item.rawKey)
    .first<{ state: string }>();
  if (prior) {
    await job(
      db,
      item,
      config.artifact.revision,
      ["handled", "accepted"].includes(prior.state) ? "complete" : "held",
      "prior_routing_outcome",
      now,
      token,
    );
    return;
  }
  if (decision.status !== "shadow") {
    await job(db, item, config.artifact.revision, "held", "invalid_metadata", now, token);
    return;
  }
  for (const candidate of decision.candidates) {
    if (candidate.mode !== "exclusive") continue;
    const adoption = config.adoptions.find(
      (entry) => entry.pluginId === candidate.pluginId && entry.enabled,
    );
    const owner = config.artifact.owners.find((entry) => entry.handlerRef === adoption?.handlerRef);
    // An unprovisioned/revoked owner cannot receive data. No old attempt is allowed to fall through if ambiguous.
    if (!owner) {
      // oxlint-disable-next-line no-await-in-loop -- Check durable ambiguity before skipping a revoked owner.
      const previous = await db
        .prepare("SELECT state FROM routing_dispatch_outbox WHERE raw_key=? AND lane=?")
        .bind(item.rawKey, `owner:${candidate.pluginId}`)
        .first<{ state: string }>();
      if (previous && ["sending", "uncertain", "handled"].includes(previous.state)) {
        // oxlint-disable-next-line no-await-in-loop -- Preserve the exclusive lane on durable or ambiguous claims.
        await job(
          db,
          item,
          config.artifact.revision,
          previous.state === "handled" ? "complete" : "held",
          "owner_revoked",
          now,
          token,
        );
        return;
      }
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- Only the current exclusive owner may act before fallback.
    const state = await attempt(
      env,
      db,
      config,
      token,
      item,
      `owner:${candidate.pluginId}`,
      candidate.pluginId,
      owner.adapter,
      owner.offerFields,
      {
        pluginId: candidate.pluginId,
        manifestVersion: candidate.manifestVersion,
        manifestSha256: candidate.manifestSha256,
      },
      runtime,
      budget,
    );
    if (typeof state !== "string") {
      // oxlint-disable-next-line no-await-in-loop -- Fail closed if an unexpected owner result requests policy suppression.
      await job(db, item, config.artifact.revision, "ignored", state.evidenceCode, now, token);
      return;
    }
    if (state === "not_applicable") continue;
    // oxlint-disable-next-line no-await-in-loop -- Persist the lane outcome before another scheduled attempt.
    await job(
      db,
      item,
      config.artifact.revision,
      state === "handled" ? "complete" : ["dead", "rejected"].includes(state) ? "dead" : "waiting",
      state === "handled" ? null : state === "uncertain" ? "owner_uncertain" : "owner_pending",
      now,
      token,
    );
    return;
  }
  // A removed matcher cannot bypass an old claim. Consult all prior exclusive offers.
  const blocking = await db
    .prepare(`SELECT state FROM routing_dispatch_outbox WHERE raw_key=? AND lane!='action'
    AND state IN ('sending','uncertain','handled','rejected','dead') LIMIT 1`)
    .bind(item.rawKey)
    .first<{ state: string }>();
  if (blocking) {
    await job(
      db,
      item,
      config.artifact.revision,
      blocking.state === "handled" ? "complete" : "held",
      "prior_owner_claim",
      now,
      token,
    );
    return;
  }
  let resolution: RoutingFallback =
    decision.fallback.outcome === "review"
      ? {
          outcome: "review",
          category: decision.fallback.category ?? null,
          urgent: decision.fallback.urgent ?? false,
          evidenceCode: "static_rule",
        }
      : {
          outcome: decision.fallback.outcome === "ignore" ? "ignore" : "hold",
          category: null,
          urgent: false,
          evidenceCode: "static_rule",
        };
  if (decision.fallback.outcome === "unresolved" && runtime.resolveFallback)
    resolution = v.parse(
      fallbackSchema,
      await boundedCallback(runtime.resolveFallback(item, decision), 45_000),
    );
  if (resolution.outcome !== "review") {
    await job(
      db,
      item,
      config.artifact.revision,
      resolution.outcome === "ignore" ? "ignored" : "held",
      resolution.evidenceCode,
      now,
      token,
    );
    return;
  }
  const state = await attempt(
    env,
    db,
    config,
    token,
    item,
    "action",
    config.artifact.destination.id,
    config.artifact.destination.adapter,
    config.artifact.destination.offerFields,
    {
      classification: {
        outcome: "review",
        category: resolution.category,
        urgent: resolution.urgent,
        evidenceCode: resolution.evidenceCode,
      },
    },
    runtime,
    budget,
    resolution,
  );
  if (typeof state !== "string") {
    await job(db, item, config.artifact.revision, "ignored", state.evidenceCode, now, token);
    return;
  }
  await job(
    db,
    item,
    config.artifact.revision,
    ["handled", "accepted"].includes(state)
      ? "complete"
      : ["dead", "rejected"].includes(state)
        ? "dead"
        : "waiting",
    ["handled", "accepted"].includes(state) ? null : "notification_pending",
    now,
    token,
  );
}

/** Scheduler mount: absent/disabled private configuration never starts external IO. */
export async function repairRoutingDispatch(
  env: RoutingDispatchEnvironment,
  runtime: RoutingDispatchRuntime = {},
  rawKey?: string,
) {
  runtime = snapshotRuntime(env, runtime);
  let config: DispatchConfiguration | null;
  try {
    config = await loadDispatchConfiguration(env.MAIL_ARCHIVE);
  } catch {
    return { status: "invalid_config", processed: 0 };
  }
  if (!config) return { status: "disabled", processed: 0 };
  await bindDestinationIdentity(config, transportFor(env, runtime));
  const db = env.MAIL_CATALOG.withSession("first-primary");
  const state = await observe(db, config);
  if (!config.artifact.enabled) return { status: "disabled", processed: 0 };
  await reconcileRoutingDispatch(env, runtime, rawKey);
  const active = state === "draining" ? await observe(db, config) : state;
  if (active !== "active") return { status: active, processed: 0 };
  const now = runtime.now?.() ?? Date.now();
  let processed = 0;
  const budget = { remaining: LIMIT };
  const rows = await db
    .prepare(`SELECT e.raw_key,e.raw_sha256,e.updated_at FROM mail_extractions e JOIN archive_sources s ON s.raw_key=e.raw_key
      LEFT JOIN routing_dispatch_jobs j ON j.raw_key=e.raw_key
      WHERE e.extractor_version='mime-v1' AND e.status='complete' AND s.raw_state='present'
      AND s.source_kind='email_routing' AND s.notify_events=1 AND s.raw_sha256=e.raw_sha256
      AND (? IS NULL OR e.raw_key=?) AND COALESCE(j.lease_until,0)<=?
      AND (j.raw_key IS NULL OR j.source_sha256!=e.raw_sha256 OR j.extraction_updated_at!=e.updated_at OR j.revision<?
        OR (j.state IN ('waiting','held') AND (? IS NOT NULL OR j.next_attempt_at<=?))
        OR (? IS NOT NULL AND j.state='ignored'))
      ORDER BY COALESCE(j.next_attempt_at,0),e.raw_key LIMIT ?`)
    .bind(
      rawKey ?? null,
      rawKey ?? null,
      Date.now(),
      config.artifact.revision,
      rawKey ?? null,
      now,
      rawKey ?? null,
      LIMIT,
    )
    .all<{ raw_key: string; raw_sha256: string; updated_at: number }>();
  for (const row of rows.results) {
    // oxlint-disable-next-line no-await-in-loop -- Per-source leases and a three-source batch bound scheduled work.
    const item = await source(db, row.raw_key);
    if (!item) {
      // oxlint-disable-next-line no-await-in-loop -- Persist fixed failures so malformed metadata cannot starve later sources.
      await db
        .prepare(`INSERT INTO routing_dispatch_jobs(raw_key,source_sha256,extraction_updated_at,revision,state,failure_code,next_attempt_at,updated_at)
          VALUES(?,?,?,?,'held','invalid_source',?,?) ON CONFLICT(raw_key) DO UPDATE SET
          state='held',failure_code='invalid_source',next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
          WHERE routing_dispatch_jobs.lease_until<=?`)
        .bind(
          row.raw_key,
          row.raw_sha256,
          row.updated_at,
          config.artifact.revision,
          now + 60_000,
          now,
          Date.now(),
        )
        .run();
      continue;
    }
    const token = crypto.randomUUID();
    // oxlint-disable-next-line no-await-in-loop -- Per-source leases allow urgent owners to avoid unrelated classifier work.
    await db
      .prepare(`INSERT OR IGNORE INTO routing_dispatch_jobs(raw_key,source_sha256,extraction_updated_at,revision,state,updated_at)
        VALUES(?,?,?,?,'waiting',?)`)
      .bind(item.rawKey, item.rawSha256, item.extractionUpdatedAt, config.artifact.revision, now)
      .run();
    // oxlint-disable-next-line no-await-in-loop -- Compare-and-set before any asynchronous classification or adapter work.
    const lease = await db
      .prepare(
        `UPDATE routing_dispatch_jobs SET lease_token=?,lease_until=? WHERE raw_key=? AND lease_until<=?`,
      )
      .bind(token, Date.now() + LEASE, item.rawKey, Date.now())
      .run();
    if (lease.meta.changes !== 1) continue;
    processed++;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Complete each lane's durable decision before advancing.
      await routeOne(env, db, config, token, item, runtime, budget);
    } catch {
      // oxlint-disable-next-line no-await-in-loop -- Poison metadata cannot starve later sources.
      await job(db, item, config.artifact.revision, "held", "processing_unavailable", now, token);
    } finally {
      // oxlint-disable-next-line no-await-in-loop -- Release only the exact acquired source lease.
      await db
        .prepare(
          "UPDATE routing_dispatch_jobs SET lease_token=NULL,lease_until=0 WHERE raw_key=? AND lease_token=?",
        )
        .bind(item.rawKey, token)
        .run();
    }
  }
  return { status: "complete", processed };
}

/** Immediate MIME-completion hook. Short, bounded retries run independently of the
 * five-minute repair cadence; status reconciliation still precedes uncertain work. */
export async function dispatchRoutingSource(
  env: RoutingDispatchEnvironment,
  rawKey: string,
  runtime: RoutingDispatchRuntime = {},
) {
  let result = await repairRoutingDispatch(env, runtime, rawKey);
  for (const delay of [2000, 4000]) {
    if (result.status !== "complete") break;
    const db = env.MAIL_CATALOG.withSession("first-primary");
    // oxlint-disable-next-line no-await-in-loop -- At most two brief retries for transient owner-request creation races.
    const retry = await db
      .prepare(
        `SELECT 1 FROM routing_dispatch_outbox WHERE raw_key=? AND state='retry' AND attempts<?`,
      )
      .bind(rawKey, MAX_ATTEMPTS)
      .first();
    if (!retry) break;
    // oxlint-disable-next-line no-await-in-loop -- The total retry delay is six seconds, with no detached work.
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    // oxlint-disable-next-line no-await-in-loop -- Retry the same durable operation/body, never blind replay of uncertainty.
    result = await repairRoutingDispatch(env, runtime, rawKey);
  }
  return result;
}
