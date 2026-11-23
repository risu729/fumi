import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPATCH_CONFIG_KEY, loadDispatchConfiguration } from "../src/routing-dispatch-config.ts";
import type { DispatchConfiguration, OfferField } from "../src/routing-dispatch-config.ts";
import {
  canonicalOfferJson,
  dispatchDigest,
  exchangeOffer,
  readDispatchBytes,
} from "../src/plugin-offer.ts";
import type {
  OfferResult,
  PluginAdapter,
  PluginOfferRequest,
  RoutingOfferService,
} from "../src/plugin-offer.ts";
import {
  activateRoutingDispatch,
  dispatchRoutingSource,
  drainRoutingDispatch,
  recordRoutingDispatchReceipt,
  repairRoutingDispatch,
  routingDispatchStatus,
  routingOperationId,
} from "../src/routing-dispatch.ts";
import type { RoutingDispatchRuntime } from "../src/routing-dispatch.ts";
import { FULL_SCAN_INTERVAL } from "../src/scan-schedule.ts";

type Artifact = DispatchConfiguration["artifact"];
type Request = PluginOfferRequest & {
  requestSha256: string;
  attempt: { generation: number; expiresAt: number };
};
let clock = 0;
const rawSha = "a".repeat(64);
const rpcAdapter = (ref: string): PluginAdapter => ({
  kind: "rpc",
  serviceRef: ref,
  timeoutMs: 5000,
});
function artifact(): Artifact & { destination: NonNullable<Artifact["destination"]> } {
  return {
    schemaVersion: 1,
    revision: 1,
    generation: 1,
    enabled: true,
    routing: {
      configJson: JSON.stringify({
        schemaVersion: 1,
        adoptions: [],
        rules: [{ id: "synthetic-review", priority: 1, match: "true", outcome: "review" }],
        fallback: "unresolved",
      }),
      manifests: [],
    },
    destination: { id: "active-a", adapter: rpcAdapter("active-a"), offerFields: ["subject"] },
    owners: [],
  };
}
async function configure(config: Artifact) {
  await env.MAIL_ARCHIVE.put(DISPATCH_CONFIG_KEY, JSON.stringify(config));
}
async function withOwner<T extends Artifact>(
  config: T,
  fields: OfferField[] = ["subject"],
  version = "1.0.0",
) {
  const manifest = {
    schemaVersion: 1,
    pluginId: "synthetic-owner",
    version,
    protocol: "fumi-offer-v1",
    mode: "exclusive",
    inputFields: ["subject"],
    offerInputFields: fields,
    capabilities: ["offer"],
    match: 'subject.contains("確認")',
  };
  const json = JSON.stringify(manifest);
  const rules = JSON.parse(config.routing.configJson) as { adoptions: unknown[] };
  rules.adoptions = [
    {
      pluginId: manifest.pluginId,
      origin: "https://owner.example.com",
      version,
      manifestSha256: await dispatchDigest(json),
      enabled: true,
      priority: 1,
      inputFields: ["subject"],
      offerInputFields: fields,
      capabilities: ["offer"],
      handlerRef: "synthetic-owner",
      timeoutMs: 5000,
      onFailure: "hold",
    },
  ];
  config.routing.configJson = JSON.stringify(rules);
  config.routing.manifests = [{ json, authenticatedOrigin: "https://owner.example.com" }];
  config.owners = [
    { handlerRef: "synthetic-owner", adapter: rpcAdapter("owner"), offerFields: fields },
  ];
  return config;
}
async function source(
  index = 1,
  options: { historical?: boolean; subject?: string; invalidMetadata?: boolean } = {},
) {
  const id = `synthetic-${String(index).padStart(4, "0")}`;
  const rawKey = `ingest/2026-11-12/${id}/raw.eml`;
  const textKey = `derived/${id}/text`;
  const manifestKey = `derived/${id}/manifest`;
  const text = "合成の確認コード: 123456";
  const textSha = await dispatchDigest(text);
  await env.MAIL_ARCHIVE.put(textKey, text);
  await env.MAIL_ARCHIVE.put(
    manifestKey,
    JSON.stringify({
      rawSha256: rawSha,
      body: {
        text: { key: textKey, sha256: textSha, size: new TextEncoder().encode(text).byteLength },
      },
    }),
  );
  const receivedAt = "2026-11-12T00:00:00.000Z";
  const receipt = JSON.stringify({
    schemaVersion: 1,
    ingestId: id,
    receivedAt,
    envelope: { from: "smtp@example.invalid", to: "otp@example.invalid" },
    reportedRawSize: 100,
    archive: { status: "stored", key: rawKey, size: 100, sha256: rawSha },
    forward: { status: "forwarded" },
  });
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,
      received_at,receipt_snapshot,forward_status,raw_state,receipt_state,raw_sha256,observed_pass,observed_revision,notify_events)
      VALUES('email_routing','ingress-v1',?,?,?,?,?,'forwarded','present','valid',?,0,0,?)`).bind(
      id,
      rawKey,
      `${rawKey}.receipt`,
      receivedAt,
      receipt,
      rawSha,
      options.historical ? 0 : 1,
    ),
    env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,
      metadata_json,attachments_json,body_json_key,body_text_key,manifest_key,updated_at)
      VALUES(?,'mime-v1',?,100,?,'complete',?,'[]',?,?,?,1)`).bind(
      rawKey,
      rawSha,
      id,
      options.invalidMetadata
        ? "{"
        : JSON.stringify({
            subject: options.subject ?? "合成の確認",
            from: { address: "header@example.invalid" },
            to: [{ address: "spoofed@example.invalid" }],
          }),
      `${rawKey}.body`,
      textKey,
      manifestKey,
    ),
  ]);
  return { rawKey, textKey, manifestKey, text };
}
function service(result: OfferResult = "handled") {
  const requests: Request[] = [];
  const lookups: { operationId: string; requestSha256: string }[] = [];
  const replies = new Map<string, OfferResult>();
  let offerResult = result;
  let statusResult: OfferResult = "uncertain";
  const binding: RoutingOfferService = {
    async offer(request) {
      requests.push(request);
      expect(
        await dispatchDigest(
          canonicalOfferJson(
            (({ requestSha256: _hash, attempt: _attempt, ...body }) => body)(request),
          ),
        ),
      ).toBe(request.requestSha256);
      replies.set(request.operationId, offerResult);
      return {
        schemaVersion: 1,
        operationId: request.operationId,
        requestSha256: request.requestSha256,
        result: offerResult,
      };
    },
    async receipt(request) {
      lookups.push(request);
      return { ...request, result: statusResult };
    },
  };
  return {
    binding,
    requests,
    lookups,
    replies,
    setOffer: (value: OfferResult) => {
      offerResult = value;
    },
    setStatus: (value: OfferResult) => {
      statusResult = value;
    },
  };
}
function runtime(bindings: Record<string, RoutingOfferService>): RoutingDispatchRuntime {
  return {
    now: () => clock,
    transport: { auth: {}, rpcServices: bindings },
    gateNotification: async () => ({ outcome: "allow", evidenceCode: "synthetic_allowed" }),
  };
}
async function rows() {
  return (
    await env.MAIL_CATALOG.prepare("SELECT * FROM routing_dispatch_outbox ORDER BY lane").all<{
      operation_id: string;
      state: string;
      payload_json: string;
      request_sha256: string;
      target_id: string;
      generation: number;
      attempts: number;
      revision: number;
      failure_code: string | null;
    }>()
  ).results;
}
async function advance() {
  clock += 100_000;
}
const signingSecret = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
const otherSigningSecret = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))}`;
function webhookAdapter(url: string, authRef = "synthetic") {
  return { kind: "webhook" as const, url, authRef, timeoutMs: 1000 };
}
function webhookRuntime(
  auth: Record<string, string>,
  handle: (request: globalThis.Request) => Promise<Response>,
): RoutingDispatchRuntime {
  return {
    ...runtime({}),
    transport: {
      auth,
      fetch: async (input, init) =>
        handle(input instanceof globalThis.Request ? input : new globalThis.Request(input, init)),
    },
  };
}
/** Independent Standard Webhooks verification of one captured request. */
async function verifiedWebhook(request: globalThis.Request, secret: string, id: string) {
  expect(request.headers.get("webhook-id")).toBe(id);
  const timestamp = request.headers.get("webhook-timestamp")!;
  const body = await request.clone().text();
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${id}.${timestamp}.${body}`),
        ),
      ),
    ),
  );
  expect(request.headers.get("webhook-signature")).toBe(`v1,${expected}`);
  return body;
}

// Run `inject` once, just before (or with `after`, just after) the first statement
// whose SQL starts with `prefix` runs, to model a concurrent worker's write.
function raceOnce(prefix: string, inject: () => Promise<unknown>, after = false) {
  let raced = false;
  const session = (inner: D1DatabaseSession) =>
    new Proxy(inner, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (raced || !sql.startsWith(prefix)) return statement;
          raced = true;
          return {
            bind: (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  if (!after) await inject();
                  const result = await bound.run();
                  if (after) await inject();
                  return result;
                },
              };
            },
          };
        };
      },
    });
  const catalog = new Proxy(env.MAIL_CATALOG, {
    get(target, property) {
      if (property === "withSession")
        return (constraint?: D1SessionConstraint) => session(target.withSession(constraint));
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { catalog, raced: () => raced };
}
async function insertRow(row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await env.MAIL_CATALOG.prepare(
    `INSERT INTO routing_dispatch_outbox(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  )
    .bind(...columns.map((column) => row[column]))
    .run();
}

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  clock = Date.now();
  await env.MAIL_ARCHIVE.delete(DISPATCH_CONFIG_KEY);
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare("DELETE FROM routing_dispatch_outbox"),
    env.MAIL_CATALOG.prepare("DELETE FROM routing_dispatch_jobs"),
    env.MAIL_CATALOG.prepare("DELETE FROM routing_dispatch_control"),
    env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions"),
    env.MAIL_CATALOG.prepare("DELETE FROM archive_sources"),
  ]);
});

describe("durable routing dispatch in workerd", () => {
  it.each(["uncertain", "handled"] as const)(
    "never looks up or re-offers an old %s claim on a changed native RPC target",
    async (outcome) => {
      const config: Artifact = await withOwner(artifact());
      config.destination = null;
      config.owners[0]!.adapter = rpcAdapter("default");
      await configure(config);
      await source();
      const oldOwner = service(outcome),
        newOwner = service("not_applicable");
      newOwner.setStatus("not_found");
      const run: RoutingDispatchRuntime = {
        now: () => clock,
        resolveFallback: vi.fn(),
        gateNotification: vi.fn(),
      };
      const oldEnvironment = {
        MAIL_ARCHIVE: env.MAIL_ARCHIVE,
        MAIL_CATALOG: env.MAIL_CATALOG,
        ROUTING_DISPATCH_RPC: oldOwner.binding,
        ROUTING_DISPATCH_RPC_IDENTITY: JSON.stringify(["synthetic-old-owner", "Offer"]),
      };
      await repairRoutingDispatch(oldEnvironment, run);
      await advance();
      await repairRoutingDispatch(
        {
          ...oldEnvironment,
          ROUTING_DISPATCH_RPC: newOwner.binding,
          ROUTING_DISPATCH_RPC_IDENTITY: JSON.stringify(["synthetic-new-owner", "Offer"]),
        },
        run,
      );
      expect(oldOwner.requests).toHaveLength(1);
      expect(oldOwner.lookups).toHaveLength(0);
      expect(newOwner.lookups).toHaveLength(0);
      expect(newOwner.requests).toHaveLength(0);
      expect((await rows()).map((row) => row.state)).toEqual([outcome]);
      expect(run.resolveFallback).not.toHaveBeenCalled();
      expect(run.gateNotification).not.toHaveBeenCalled();
      if (outcome === "uncertain")
        expect(
          await env.MAIL_CATALOG.prepare(
            "SELECT failure_code FROM routing_dispatch_outbox",
          ).first(),
        ).toEqual({ failure_code: "credentials_changed" });
    },
  );
  it("maps only the native default RPC capability to an explicitly configured owner", async () => {
    const config: Artifact = await withOwner(artifact());
    config.destination = null;
    config.owners[0]!.adapter = rpcAdapter("default");
    await configure(config);
    await source();
    const owner = service();
    await repairRoutingDispatch({
      MAIL_ARCHIVE: env.MAIL_ARCHIVE,
      MAIL_CATALOG: env.MAIL_CATALOG,
      ROUTING_DISPATCH_RPC: owner.binding,
    });
    expect(owner.requests).toHaveLength(1);
    expect((await rows()).map((row) => row.state)).toEqual(["handled"]);
  });
  it("handles an adopted owner with no destination and never re-offers its durable claim", async () => {
    const config: Artifact = await withOwner(artifact());
    config.destination = null;
    await configure(config);
    const item = await source();
    const owner = service();
    const run = runtime({ owner: owner.binding });
    run.resolveFallback = vi.fn();
    run.gateNotification = vi.fn();
    const fetch = vi.fn();
    run.transport!.fetch = fetch;
    expect(await activateRoutingDispatch(env, run)).toBe("active");
    expect((await routingDispatchStatus(env.MAIL_CATALOG)).mode).toBe("owner_only");
    await dispatchRoutingSource(env, item.rawKey, run);
    config.revision = 2;
    await withOwner(config, ["subject"], "2.0.0");
    await configure(config);
    await repairRoutingDispatch(env, run);
    expect(owner.requests).toHaveLength(1);
    expect((await rows()).map((row) => row.state)).toEqual(["handled"]);
    expect(run.resolveFallback).not.toHaveBeenCalled();
    expect(run.gateNotification).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["declined", "unmatched"] as const)(
    "holds %s owner-only mail before classification or webhook work",
    async (kind) => {
      const config: Artifact = await withOwner(artifact());
      config.destination = null;
      const routing = JSON.parse(config.routing.configJson);
      routing.rules = [];
      routing.fallback = "unresolved";
      config.routing.configJson = JSON.stringify(routing);
      await configure(config);
      const item = await source(1, {
        subject: kind === "declined" ? "合成の確認" : "unrelated message",
      });
      const owner = service("not_applicable"),
        unused = service();
      const run = runtime({ owner: owner.binding, "active-a": unused.binding });
      run.resolveFallback = vi.fn();
      run.gateNotification = vi.fn();
      run.transport!.fetch = vi.fn();
      await dispatchRoutingSource(env, item.rawKey, run);
      await advance();
      await repairRoutingDispatch(env, run);
      expect(owner.requests).toHaveLength(kind === "declined" ? 1 : 0);
      expect(unused.requests).toHaveLength(0);
      expect(run.resolveFallback).not.toHaveBeenCalled();
      expect(run.gateNotification).not.toHaveBeenCalled();
      expect(run.transport!.fetch).not.toHaveBeenCalled();
      expect((await rows()).every((row) => row.state === "not_applicable")).toBe(true);
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT state,failure_code FROM routing_dispatch_jobs WHERE raw_key=?",
        )
          .bind(item.rawKey)
          .first(),
      ).toEqual({ state: "held", failure_code: "notification_not_configured" });
    },
  );
  it("keeps an uncertain owner exclusive through an owner-only revision and later handled receipt", async () => {
    const config: Artifact = await withOwner(artifact());
    config.destination = null;
    await configure(config);
    await source();
    const owner = service("uncertain"),
      run = runtime({ owner: owner.binding });
    await repairRoutingDispatch(env, run);
    config.revision = 2;
    await withOwner(config, ["subject"], "2.0.0");
    await configure(config);
    await advance();
    expect((await repairRoutingDispatch(env, run)).status).toBe("draining");
    expect(owner.requests).toHaveLength(1);
    expect((await rows())[0]!.state).toBe("uncertain");
    owner.setStatus("handled");
    await advance();
    await repairRoutingDispatch(env, run);
    expect(owner.requests).toHaveLength(1);
    expect((await rows())[0]!.state).toBe("handled");
    expect((await routingDispatchStatus(env.MAIL_CATALOG)).mode).toBe("owner_only");
  });
  it("does not hand a prior uncertain notification to an owner when removing the destination", async () => {
    const config: Artifact = artifact();
    await configure(config);
    await source();
    const destination = service("uncertain"),
      owner = service();
    const run = runtime({ "active-a": destination.binding, owner: owner.binding });
    await repairRoutingDispatch(env, run);
    config.destination = null;
    config.revision = 2;
    config.generation = 2;
    await withOwner(config);
    await configure(config);
    await advance();
    expect((await repairRoutingDispatch(env, run)).status).toBe("draining");
    expect(owner.requests).toHaveLength(0);
    destination.setStatus("handled");
    await advance();
    await repairRoutingDispatch(env, run);
    expect(owner.requests).toHaveLength(0);
    expect(destination.requests).toHaveLength(1);
    expect((await rows())[0]!.state).toBe("handled");
    expect((await routingDispatchStatus(env.MAIL_CATALOG)).mode).toBe("owner_only");
  });
  it("requires a new generation before enabling a previously absent notification destination", async () => {
    const config: Artifact = await withOwner(artifact());
    config.destination = null;
    await configure(config);
    await source();
    const owner = service("not_applicable"),
      destination = service(),
      run = runtime({ owner: owner.binding, "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    config.destination = artifact().destination;
    config.revision = 2;
    await configure(config);
    expect((await repairRoutingDispatch(env, run)).status).toBe("stale");
    expect(destination.requests).toHaveLength(0);
    config.generation = 2;
    await configure(config);
    await repairRoutingDispatch(env, run);
    expect(owner.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(1);
    expect((await routingDispatchStatus(env.MAIL_CATALOG)).mode).toBe("configured_destination");
  });
  it("requires an explicit destination field instead of silently choosing owner-only mode", async () => {
    const { destination: _destination, ...missing } = artifact();
    await env.MAIL_ARCHIVE.put(DISPATCH_CONFIG_KEY, JSON.stringify(missing));
    await expect(loadDispatchConfiguration(env.MAIL_ARCHIVE)).rejects.toThrow();
  });
  it("is absent-config disabled and cannot create or send historical notifications", async () => {
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    await source(1, { historical: true });
    expect(await repairRoutingDispatch(env, run)).toEqual({ status: "disabled", processed: 0 });
    await configure(artifact());
    expect((await repairRoutingDispatch(env, run)).processed).toBe(0);
    expect(await rows()).toEqual([]);
    expect(destination.requests).toHaveLength(0);
  });
  it("sends one frozen operation to the sole active target and survives config upgrades", async () => {
    const config = artifact();
    await configure(config);
    const item = await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    await dispatchRoutingSource(env, item.rawKey, run);
    expect(destination.requests).toHaveLength(1);
    const request = destination.requests[0]!;
    expect(request.operationId).toBe(await routingOperationId(item.rawKey, "action"));
    expect(request.input).toEqual({ subject: "合成の確認" });
    expect(request.messageId).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain(item.rawKey);
    expect(request.classification).toMatchObject({
      outcome: "review",
      category: null,
      urgent: false,
    });
    expect(request.attempt.generation).toBe(1);
    config.revision = 2;
    await configure(config);
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect((await rows())[0]?.state).toBe("handled");
  });
  it("reads only due jobs between full scheduled passes", async () => {
    await env.MAIL_CATALOG.prepare("DELETE FROM catalog_scans").run();
    const config = artifact();
    await configure(config);
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    const scheduled = () => repairRoutingDispatch(env, run, undefined, true);
    const first = await source(1);
    expect((await scheduled()).processed).toBe(1);
    // A source the MIME Workflow did not dispatch waits for the next full pass.
    await source(2);
    expect((await scheduled()).processed).toBe(0);
    await env.MAIL_CATALOG.prepare(
      "UPDATE routing_dispatch_jobs SET state='waiting',next_attempt_at=? WHERE raw_key=?",
    )
      .bind(clock, first.rawKey)
      .run();
    expect((await scheduled()).processed).toBe(1);
    expect(destination.requests).toHaveLength(1);
    clock += FULL_SCAN_INTERVAL;
    expect((await scheduled()).processed).toBe(1);
    expect(destination.requests).toHaveLength(2);
    await source(3);
    config.revision = 2;
    await configure(config);
    // A new configuration revision makes the next pass full.
    expect((await scheduled()).processed).toBe(3);
    expect(destination.requests).toHaveLength(3);
  });
  it("an unrelated OTP owner's not_applicable result falls through to ordinary routing", async () => {
    await configure(await withOwner(artifact()));
    await source();
    const owner = service("not_applicable"),
      destination = service();
    await repairRoutingDispatch(
      env,
      runtime({ owner: owner.binding, "active-a": destination.binding }),
    );
    expect(owner.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(1);
    expect((await rows()).map((row) => row.state)).toEqual(["handled", "not_applicable"]);
  });
  it("a handled owner suppresses ordinary action and is not replayed after manifest upgrade", async () => {
    const config = await withOwner(artifact());
    await configure(config);
    await source();
    const owner = service(),
      destination = service();
    const run = runtime({ owner: owner.binding, "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    config.revision = 2;
    await withOwner(config, ["subject"], "2.0.0");
    await configure(config);
    await repairRoutingDispatch(env, run);
    expect(owner.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);
  });
  it.each(["handled", "uncertain"] as const)(
    "never discloses a prior %s ordinary action to a newly adopted owner",
    async (result) => {
      const config = artifact();
      await configure(config);
      await source();
      const destination = service(result),
        owner = service();
      const run = runtime({ "active-a": destination.binding, owner: owner.binding });
      await repairRoutingDispatch(env, run);
      config.revision = 2;
      await withOwner(config);
      await configure(config);
      await advance();
      await repairRoutingDispatch(env, run);
      expect(owner.requests).toHaveLength(0);
      expect(destination.requests).toHaveLength(1);
    },
  );
  it("terminal policy ignore stops Cron polling until explicit targeted reconsideration", async () => {
    await configure(artifact());
    const item = await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    let gates = 0;
    run.gateNotification = async () => {
      gates++;
      return { outcome: "ignore", evidenceCode: "acknowledged_case" };
    };
    await repairRoutingDispatch(env, run);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(gates).toBe(1);
    expect(destination.requests).toHaveLength(0);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT state,failure_code FROM routing_dispatch_jobs WHERE raw_key=?",
      )
        .bind(item.rawKey)
        .first(),
    ).toEqual({ state: "ignored", failure_code: "acknowledged_case" });
    run.gateNotification = async () => ({
      outcome: "allow",
      evidenceCode: "operator_reconsidered",
    });
    await repairRoutingDispatch(env, run, item.rawKey);
    expect(destination.requests).toHaveLength(1);
  });
  it("rejects ambiguous enabled handler references before any disclosure", async () => {
    const config = await withOwner(artifact());
    const routing = JSON.parse(config.routing.configJson) as {
      adoptions: Record<string, unknown>[];
    };
    const otherManifest = {
      ...(JSON.parse(config.routing.manifests[0]!.json) as Record<string, unknown>),
      pluginId: "other-owner",
    };
    const json = JSON.stringify(otherManifest);
    routing.adoptions.push({
      ...routing.adoptions[0],
      pluginId: "other-owner",
      manifestSha256: await dispatchDigest(json),
    });
    config.routing.configJson = JSON.stringify(routing);
    config.routing.manifests.push({ json, authenticatedOrigin: "https://owner.example.com" });
    await configure(config);
    await expect(loadDispatchConfiguration(env.MAIL_ARCHIVE)).rejects.toThrow();
  });
  it("signs one accepted webhook with identifiers and classification only", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const sent: globalThis.Request[] = [];
    const run = webhookRuntime({ synthetic: signingSecret }, async (request) => {
      sent.push(request);
      return new Response(null, { status: 202 });
    });
    await repairRoutingDispatch(env, run);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(sent).toHaveLength(1);
    const row = (await rows())[0]!;
    expect(row).toMatchObject({ state: "accepted", failure_code: "http_acceptance_only" });
    const body = await verifiedWebhook(sent[0]!, signingSecret, row.operation_id);
    expect(body).toBe(row.payload_json);
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).toMatchObject({
      kind: "notification",
      messageId: "mail_synthetic-0001",
      input: {},
    });
    expect(body).not.toContain("合成");
    expect(sent[0]!.headers.get("Authorization")).toBeNull();
  });
  it("resends a failed webhook with the same id and body until accepted", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const sent: globalThis.Request[] = [];
    let status = 503;
    const run = webhookRuntime({ synthetic: signingSecret }, async (request) => {
      sent.push(request);
      if (status === 0) throw new Error("Synthetic lost response");
      return new Response(null, { status });
    });
    await repairRoutingDispatch(env, run);
    expect((await rows())[0]).toMatchObject({
      state: "retry",
      attempts: 1,
      failure_code: "webhook_not_accepted",
    });
    status = 0;
    await advance();
    await repairRoutingDispatch(env, run);
    expect((await rows())[0]).toMatchObject({ state: "retry", attempts: 2 });
    status = 200;
    clock += 300_000;
    await repairRoutingDispatch(env, run);
    const row = (await rows())[0]!;
    expect(row).toMatchObject({ state: "accepted", attempts: 3 });
    expect(sent).toHaveLength(3);
    const bodies = await Promise.all(
      sent.map((request) => verifiedWebhook(request, signingSecret, row.operation_id)),
    );
    expect(new Set(bodies)).toEqual(new Set([row.payload_json]));
  });
  it("ends an unaccepted webhook dead after the attempt budget", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    let calls = 0;
    const run = webhookRuntime({ synthetic: signingSecret }, async () => {
      calls++;
      return new Response(null, { status: 500 });
    });
    for (let index = 0; index < 7; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Sequential repairs model successive cron runs.
      await repairRoutingDispatch(env, run);
      clock += 3_700_000;
    }
    expect(calls).toBe(5);
    expect((await rows())[0]).toMatchObject({
      state: "dead",
      attempts: 5,
      failure_code: "retry_exhausted",
    });
  });
  it("retries an interrupted webhook attempt instead of holding it uncertain", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    let accept = false;
    let calls = 0;
    const run = webhookRuntime({ synthetic: signingSecret }, async () => {
      calls++;
      return new Response(null, { status: accept ? 204 : 500 });
    });
    await repairRoutingDispatch(env, run);
    await env.MAIL_CATALOG.prepare(
      "UPDATE routing_dispatch_outbox SET state='sending',lease_token='lost',lease_until=1 WHERE state='retry'",
    ).run();
    accept = true;
    clock += 600_000;
    await repairRoutingDispatch(env, run);
    expect(calls).toBe(2);
    expect((await rows())[0]).toMatchObject({ state: "accepted", attempts: 2 });
  });
  it("keeps an attempted webhook on its destination across a rule revision", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const hosts: string[] = [];
    let status = 500;
    const run = webhookRuntime({ synthetic: signingSecret }, async (request) => {
      hosts.push(new URL(request.url).host);
      return new Response(null, { status });
    });
    await repairRoutingDispatch(env, run);
    config.revision = 2;
    await configure(config);
    status = 200;
    clock += 600_000;
    await repairRoutingDispatch(env, run);
    expect(hosts).toEqual(["notification.example.com", "notification.example.com"]);
    expect((await rows())[0]).toMatchObject({ state: "accepted", attempts: 2 });
  });
  it("never re-targets an attempted webhook to a new destination generation", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://old.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const hosts: string[] = [];
    const run = webhookRuntime({ synthetic: signingSecret }, async (request) => {
      hosts.push(new URL(request.url).host);
      return new Response(null, { status: 500 });
    });
    await repairRoutingDispatch(env, run);
    config.revision = 2;
    config.generation = 2;
    config.destination.adapter = webhookAdapter("https://new.example.com/notify");
    await configure(config);
    clock += 600_000;
    await repairRoutingDispatch(env, run);
    clock += 600_000;
    await repairRoutingDispatch(env, run);
    expect(hosts).toEqual(["old.example.com"]);
    expect((await rows())[0]).toMatchObject({
      state: "dead",
      failure_code: "destination_changed",
    });
  });
  it("ends an attempted webhook that reaches retry after a newer generation activated", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://old.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const hosts: string[] = [];
    const run = webhookRuntime({ synthetic: signingSecret }, async (request) => {
      hosts.push(new URL(request.url).host);
      return new Response(null, { status: 500 });
    });
    await repairRoutingDispatch(env, run);
    // Model the race: the observation that activates generation 2 does not see the
    // row as retry, and the old attempt's result lands as retry afterwards.
    await env.MAIL_CATALOG.prepare("UPDATE routing_dispatch_outbox SET state='accepted'").run();
    config.revision = 2;
    config.generation = 2;
    config.destination.adapter = webhookAdapter("https://new.example.com/notify");
    await configure(config);
    await repairRoutingDispatch(env, run);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT generation FROM routing_dispatch_control").first(),
    ).toEqual({ generation: 2 });
    await env.MAIL_CATALOG.prepare("UPDATE routing_dispatch_outbox SET state='retry'").run();
    clock += 600_000;
    await repairRoutingDispatch(env, run);
    expect(hosts).toEqual(["old.example.com"]);
    expect((await rows())[0]).toMatchObject({
      state: "dead",
      generation: 1,
      failure_code: "destination_changed",
    });
  });
  it("rebuilds a never-attempted webhook row for a new destination generation", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://old.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const hosts: string[] = [];
    const run = webhookRuntime({ synthetic: signingSecret }, async (request) => {
      hosts.push(new URL(request.url).host);
      return new Response(null, { status: 202 });
    });
    let gate = false;
    run.gateNotification = async () =>
      gate
        ? { outcome: "allow", evidenceCode: "synthetic_allow" }
        : { outcome: "hold", evidenceCode: "synthetic_hold" };
    await repairRoutingDispatch(env, run);
    expect((await rows())[0]).toMatchObject({ state: "ready", attempts: 0 });
    config.revision = 2;
    config.generation = 2;
    config.destination.adapter = webhookAdapter("https://new.example.com/notify");
    await configure(config);
    gate = true;
    await advance();
    await repairRoutingDispatch(env, run);
    expect(hosts).toEqual(["new.example.com"]);
    expect((await rows())[0]).toMatchObject({ state: "accepted", generation: 2 });
  });
  it("rejects mail field grants on a generic webhook destination", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = ["subject"];
    await configure(config);
    await expect(loadDispatchConfiguration(env.MAIL_ARCHIVE)).rejects.toThrow();
  });
  it("holds a webhook whose secret is not a whsec signing secret", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://notification.example.com/notify");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    let calls = 0;
    const run = webhookRuntime({ synthetic: "synthetic-webhook-auth-0000000" }, async () => {
      calls++;
      return new Response(null, { status: 202 });
    });
    await repairRoutingDispatch(env, run);
    expect(calls).toBe(0);
    expect(await rows()).toHaveLength(0);
  });
  // A reference names only an entry the trusted map defines itself. `constructor`
  // passes the reference syntax but is an inherited Object.prototype member.
  it.each(["missing", "constructor"])(
    "holds an owner whose RPC serviceRef %s has no mapped service, before any offer",
    async (ref) => {
      const config: Artifact = await withOwner(artifact());
      config.destination = null;
      config.owners[0]!.adapter = rpcAdapter(ref);
      await configure(config);
      const item = await source();
      const owner = service();
      await repairRoutingDispatch(env, runtime({ owner: owner.binding }));
      expect(owner.requests).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT state,failure_code FROM routing_dispatch_jobs WHERE raw_key=?",
        )
          .bind(item.rawKey)
          .first(),
      ).toEqual({ state: "waiting", failure_code: "owner_pending" });
    },
  );
  it.each([
    { authRef: "active", serviceRef: "missing" },
    { authRef: "active", serviceRef: "constructor" },
    { authRef: "constructor", serviceRef: "default" },
  ])(
    "holds a service destination (authRef $authRef, serviceRef $serviceRef) with an unmapped reference",
    async (refs) => {
      const config = artifact();
      config.destination.adapter = {
        kind: "service",
        offerUrl: "https://adapter.example.com/offer",
        statusUrl: "https://adapter.example.com/status",
        ...refs,
        timeoutMs: 1000,
      };
      await configure(config);
      await source();
      const fetch = vi.fn(async () => new Response(null, { status: 500 }));
      const run: RoutingDispatchRuntime = {
        ...runtime({}),
        transport: {
          auth: { active: "synthetic-service-account-secret-0000" },
          services: { default: { fetch } },
        },
      };
      await repairRoutingDispatch(env, run);
      expect(fetch).not.toHaveBeenCalled();
      expect(await rows()).toHaveLength(0);
    },
  );
  it("does not bind an inherited RPC identity into the destination generation", async () => {
    const config = artifact();
    config.destination.adapter = rpcAdapter("constructor");
    await configure(config);
    const run = runtime({});
    run.transport!.rpcIdentities = { default: "synthetic-identity" };
    expect(await activateRoutingDispatch(env, run)).toBe("active");
    // Without a mapped identity the generation is the configured destination alone.
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT destination_sha256 FROM routing_dispatch_control",
      ).first(),
    ).toEqual({
      destination_sha256: (await loadDispatchConfiguration(env.MAIL_ARCHIVE))!.destinationSha256,
    });
  });
  it("cannot reconcile old-endpoint uncertainty through a replaced credential reference", async () => {
    const config = artifact();
    config.destination.adapter = {
      kind: "https",
      offerUrl: "https://adapter.example.com/offer",
      statusUrl: "https://adapter.example.com/status",
      authRef: "active",
      serviceRef: null,
      timeoutMs: 1000,
    };
    await configure(config);
    await source();
    const auth: Record<string, string> = { active: "synthetic-original-account-secret-0000" };
    let offers = 0;
    let statuses = 0;
    const run: RoutingDispatchRuntime = {
      ...runtime({}),
      transport: {
        auth,
        fetch: async (input) => {
          const request = input as globalThis.Request;
          if (new URL(request.url).pathname === "/status") statuses++;
          else offers++;
          return Response.json({
            schemaVersion: 1,
            operationId: request.headers.get("Idempotency-Key"),
            requestSha256: request.headers.get("X-Fumi-Request-Sha256"),
            result: new URL(request.url).pathname === "/status" ? "not_found" : "uncertain",
          });
        },
      },
    };
    await repairRoutingDispatch(env, run);
    auth["active"] = "synthetic-replacement-account-secret-1111";
    await advance();
    expect((await repairRoutingDispatch(env, run)).status).toBe("stale");
    expect(offers).toBe(1);
    expect(statuses).toBe(0);
    expect((await rows())[0]?.failure_code).toBe("credentials_changed");
    config.revision = 2;
    config.generation = 2;
    await configure(config);
    await advance();
    expect((await repairRoutingDispatch(env, run)).status).toBe("draining");
    expect(statuses).toBe(0);
    expect(offers).toBe(1);
  });
  it("keeps an immutable per-invocation credential snapshot across asynchronous gates", async () => {
    const config = artifact();
    config.destination.adapter = webhookAdapter("https://adapter.example.com/notify", "active");
    config.destination.offerFields = [];
    await configure(config);
    await source();
    const auth: Record<string, string> = { active: signingSecret };
    let sent: globalThis.Request | undefined;
    const run: RoutingDispatchRuntime = {
      ...webhookRuntime(auth, async (request) => {
        sent = request;
        return new Response(null, { status: 202 });
      }),
      gateNotification: async () => {
        auth["active"] = otherSigningSecret;
        return { outcome: "allow", evidenceCode: "synthetic_allowed" };
      },
    };
    await repairRoutingDispatch(env, run);
    const row = (await rows())[0]!;
    await verifiedWebhook(sent!, signingSecret, row.operation_id);
  });
  it("reconciles with a retained old-endpoint credential before activating a distinct new endpoint", async () => {
    const config = artifact();
    config.destination.adapter = {
      kind: "https",
      offerUrl: "https://adapter.example.com/offer",
      statusUrl: "https://adapter.example.com/status",
      authRef: "account-a",
      serviceRef: null,
      timeoutMs: 1000,
    };
    await configure(config);
    await source();
    const oldSecret = "synthetic-original-account-secret-0000",
      newSecret = "synthetic-next-account-secret-1111111";
    const calls: { path: string; authorization: string | null }[] = [];
    const run: RoutingDispatchRuntime = {
      ...runtime({}),
      transport: {
        auth: { "account-a": oldSecret, "account-b": newSecret },
        fetch: async (input, init) => {
          const request =
            input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
          const path = new URL(request.url).pathname;
          const authorization = request.headers.get("Authorization");
          calls.push({ path, authorization });
          return Response.json({
            schemaVersion: 1,
            operationId: request.headers.get("Idempotency-Key"),
            requestSha256: request.headers.get("X-Fumi-Request-Sha256"),
            result:
              path === "/status" || authorization === `Bearer ${newSecret}`
                ? "handled"
                : "uncertain",
          });
        },
      },
    };
    await repairRoutingDispatch(env, run);
    config.revision = 2;
    config.generation = 2;
    config.destination = {
      ...config.destination,
      id: "active-b",
      adapter: {
        kind: "https",
        offerUrl: "https://adapter.example.com/offer",
        statusUrl: "https://adapter.example.com/status",
        authRef: "account-b",
        serviceRef: null,
        timeoutMs: 1000,
      },
    };
    await configure(config);
    await source(2);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(calls.filter((call) => call.path === "/status")).toEqual([
      { path: "/status", authorization: `Bearer ${oldSecret}` },
    ]);
    expect(
      calls.filter(
        (call) => call.path === "/offer" && call.authorization === `Bearer ${newSecret}`,
      ),
    ).toHaveLength(1);
  });
  it("revoked adoption prevents any later owner offer while preserving safe fallback", async () => {
    const config = await withOwner(artifact());
    await configure(config);
    await source();
    const owner = service("retryable_error"),
      destination = service();
    const run = runtime({ owner: owner.binding, "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    const routing = JSON.parse(config.routing.configJson) as { adoptions: { enabled: boolean }[] };
    routing.adoptions[0]!.enabled = false;
    config.routing.configJson = JSON.stringify(routing);
    config.owners = [];
    config.revision = 2;
    await configure(config);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(owner.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(1);
  });
  it("two concurrent repairs cannot send the same logical operation twice", async () => {
    await configure(artifact());
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    await Promise.all([repairRoutingDispatch(env, run), repairRoutingDispatch(env, run)]);
    expect(destination.requests).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });
  it("a timed-out owner never falls through to an ordinary notification", async () => {
    const config = await withOwner(artifact());
    config.owners[0]!.adapter = { kind: "rpc", serviceRef: "owner", timeoutMs: 5 };
    await configure(config);
    await source();
    const destination = service();
    const owner: RoutingOfferService = {
      offer: () => new Promise(() => undefined),
      receipt: async (request) => ({ ...request, result: "uncertain" }),
    };
    await repairRoutingDispatch(env, runtime({ owner, "active-a": destination.binding }));
    expect(destination.requests).toHaveLength(0);
    expect((await rows())[0]?.state).toBe("uncertain");
  });
  it("passes only explicitly adopted trusted-envelope/text inputs with derivative hash verification", async () => {
    await configure(await withOwner(artifact(), ["subject", "envelope", "text"]));
    const item = await source();
    const owner = service();
    await repairRoutingDispatch(env, runtime({ owner: owner.binding }));
    expect(owner.requests[0]?.input).toEqual({
      subject: "合成の確認",
      text: item.text,
      envelope: {
        from: "smtp@example.invalid",
        to: "otp@example.invalid",
        receivedAt: "2026-11-12T00:00:00.000Z",
      },
    });
    expect(owner.requests[0]?.input).not.toHaveProperty("to");
  });
  it("holds modified derivative text and never discloses it", async () => {
    await configure(await withOwner(artifact(), ["subject", "text"]));
    const item = await source();
    await env.MAIL_ARCHIVE.put(item.textKey, "altered");
    const owner = service();
    await repairRoutingDispatch(env, runtime({ owner: owner.binding }));
    expect(owner.requests).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
  it("holds ambiguity and reconciles before any fallback", async () => {
    await configure(await withOwner(artifact()));
    await source();
    const owner = service("uncertain"),
      destination = service();
    const run = runtime({ owner: owner.binding, "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
    await advance();
    owner.setStatus("handled");
    await repairRoutingDispatch(env, run);
    expect(owner.lookups).toHaveLength(1);
    expect(owner.requests).toHaveLength(1);
    expect(destination.requests).toHaveLength(0);
    expect((await rows())[0]?.state).toBe("handled");
  });
  it("blocks replacement destination activation until the old ambiguous action is reconciled", async () => {
    const config = artifact();
    await configure(config);
    await source();
    const first = service("uncertain"),
      second = service();
    const run = runtime({ "active-a": first.binding, "active-b": second.binding });
    await repairRoutingDispatch(env, run);
    config.revision = 2;
    config.generation = 2;
    config.destination = { ...config.destination, id: "active-b", adapter: rpcAdapter("active-b") };
    await configure(config);
    await source(2);
    await advance();
    expect((await repairRoutingDispatch(env, run)).status).toBe("draining");
    expect(second.requests).toHaveLength(0);
    const control = async () =>
      env.MAIL_CATALOG.prepare(
        "SELECT revision,generation,accepting FROM routing_dispatch_control WHERE id=1",
      ).first();
    // The old revision stops accepting claims while the handoff drains.
    expect(await control()).toEqual({ revision: 1, generation: 1, accepting: 0 });
    first.setStatus("handled");
    await advance();
    await repairRoutingDispatch(env, run);
    expect(await control()).toEqual({ revision: 2, generation: 2, accepting: 1 });
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.attempt.generation).toBe(2);
  });
  it("expired old-generation attempts cannot commit after a target handoff", async () => {
    const config = artifact();
    config.destination.adapter = { kind: "rpc", serviceRef: "active-a", timeoutMs: 5 };
    await configure(config);
    await source();
    let stale: Request | undefined;
    let release: (() => void) | undefined;
    let oldCommits = 0;
    const first: RoutingOfferService = {
      offer: async (request) => {
        stale = request;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (Date.now() < request.attempt.expiresAt) oldCommits++;
        return {
          schemaVersion: 1,
          operationId: request.operationId,
          requestSha256: request.requestSha256,
          result: "retryable_error",
        };
      },
      receipt: async (request) => ({ ...request, result: "not_found" }),
    };
    const second = service();
    const run = runtime({ "active-a": first, "active-b": second.binding });
    await repairRoutingDispatch(env, run);
    expect(stale).toBeDefined();
    config.revision = 2;
    config.generation = 2;
    config.destination = { ...config.destination, id: "active-b", adapter: rpcAdapter("active-b") };
    await configure(config);
    await advance();
    await repairRoutingDispatch(env, run);
    release?.();
    await Promise.resolve();
    expect(oldCommits).toBe(0);
    expect(second.requests).toHaveLength(1);
  });
  it("rejects stale revisions and a destination change without a generation increase", async () => {
    const config = artifact();
    await configure(config);
    await repairRoutingDispatch(env);
    config.revision = 2;
    config.destination.id = "active-b";
    await configure(config);
    expect((await repairRoutingDispatch(env)).status).toBe("stale");
    config.revision = 1;
    await configure(config);
    expect((await repairRoutingDispatch(env)).status).toBe("stale");
  });
  it("cannot activate a same-generation destination change after a concurrent activation", async () => {
    await configure(artifact());
    await repairRoutingDispatch(env);
    const first = artifact();
    first.revision = 2;
    first.generation = 2;
    first.destination.id = "active-b";
    const second = artifact();
    second.revision = 3;
    second.generation = 2;
    second.destination.id = "active-c";
    await configure(second);
    let interleaved = false;
    // Hold this worker's activation statement until another worker, which read
    // the artifact with revision 2, has activated it.
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const catalog = {
      withSession: () => ({
        batch: session.batch.bind(session),
        prepare(query: string) {
          const statement = session.prepare(query);
          if (!query.startsWith("UPDATE routing_dispatch_control SET revision=")) return statement;
          return {
            bind: (...values: unknown[]) => ({
              async run() {
                if (!interleaved) {
                  interleaved = true;
                  await configure(first);
                  expect(await activateRoutingDispatch(env)).toBe("active");
                }
                return statement.bind(...values).run();
              },
            }),
          };
        },
      }),
    } as unknown as D1Database;
    expect(
      (await repairRoutingDispatch({ MAIL_ARCHIVE: env.MAIL_ARCHIVE, MAIL_CATALOG: catalog }))
        .status,
    ).toBe("stale");
    expect(interleaved).toBe(true);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT revision,generation FROM routing_dispatch_control WHERE id=1",
      ).first(),
    ).toEqual({ revision: 2, generation: 2 });
  });
  it("leaves acceptance open when a concurrent worker activated first", async () => {
    await configure(artifact());
    await repairRoutingDispatch(env);
    let interleaved = false;
    // Hold this worker's pre-activation batch until another worker, which read
    // `winner`, has activated it; this worker still holds `stored`.
    const race = async (winner: Artifact, stored: Artifact) => {
      interleaved = false;
      const session = env.MAIL_CATALOG.withSession("first-primary");
      const catalog = {
        withSession: () => ({
          prepare: session.prepare.bind(session),
          async batch(statements: D1PreparedStatement[]) {
            if (!interleaved) {
              interleaved = true;
              await configure(winner);
              expect(await activateRoutingDispatch(env)).toBe("active");
              await configure(stored);
            }
            return session.batch(statements);
          },
        }),
      } as unknown as D1Database;
      await configure(stored);
      const { status } = await repairRoutingDispatch({
        MAIL_ARCHIVE: env.MAIL_ARCHIVE,
        MAIL_CATALOG: catalog,
      });
      expect(interleaved).toBe(true);
      return status;
    };
    const control = async () =>
      env.MAIL_CATALOG.prepare(
        "SELECT revision,generation,accepting FROM routing_dispatch_control WHERE id=1",
      ).first();
    const same = artifact();
    same.revision = 2;
    expect(await race(same, same)).not.toBe("draining");
    expect(await control()).toEqual({ revision: 2, generation: 1, accepting: 1 });
    const winner = artifact();
    winner.revision = 3;
    winner.generation = 2;
    winner.destination.id = "active-b";
    const loser = artifact();
    loser.revision = 4;
    loser.generation = 2;
    loser.destination.id = "active-c";
    expect(await race(winner, loser)).toBe("stale");
    expect(await control()).toEqual({ revision: 3, generation: 2, accepting: 1 });
  });
  it("revocation during asynchronous gating prevents the pending notification", async () => {
    const config = artifact();
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    run.gateNotification = async () => {
      config.revision = 2;
      config.enabled = false;
      await configure(config);
      return { outcome: "allow", evidenceCode: "synthetic_allowed" };
    };
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
  });
  it("source provenance changes during gating prevent dispatch", async () => {
    await configure(artifact());
    const item = await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    run.gateNotification = async () => {
      await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET notify_events=0 WHERE raw_key=?")
        .bind(item.rawKey)
        .run();
      return { outcome: "allow", evidenceCode: "synthetic_allowed" };
    };
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
  });
  it("does not replay a changed source revision under a frozen request identity", async () => {
    await configure(artifact());
    const item = await source();
    const destination = service("retryable_error");
    const run = runtime({ "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    await env.MAIL_CATALOG.prepare("UPDATE mail_extractions SET updated_at=2 WHERE raw_key=?")
      .bind(item.rawKey)
      .run();
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    const record = await env.MAIL_CATALOG.prepare(
      "SELECT extraction_updated_at,state FROM routing_dispatch_jobs WHERE raw_key=?",
    )
      .bind(item.rawKey)
      .first();
    expect(record).toMatchObject({ extraction_updated_at: 2, state: "waiting" });
  });
  it("retries a guaranteed-no-effect owner error with the same id/hash then dead-letters", async () => {
    await configure(await withOwner(artifact()));
    await source();
    const owner = service("retryable_error");
    const run = runtime({ owner: owner.binding });
    for (let index = 0; index < 6; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Drive sequential retry generations and durable state.
      await repairRoutingDispatch(env, run);
      clock += 100_000;
    }
    expect(owner.requests).toHaveLength(5);
    expect(new Set(owner.requests.map((request) => request.operationId)).size).toBe(1);
    expect(new Set(owner.requests.map((request) => request.requestSha256)).size).toBe(1);
    expect((await rows())[0]?.state).toBe("dead");
    expect((await routingDispatchStatus(env.MAIL_CATALOG)).held).toHaveLength(1);
  });
  it("quarantines repeated unknown status and allows verified administrative receipt reconciliation", async () => {
    await configure(artifact());
    await source();
    const destination = service("uncertain");
    const run = runtime({ "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    for (let index = 0; index < 6; index++) {
      clock += 100_000;
      // oxlint-disable-next-line no-await-in-loop -- Sequential status budget exhaustion.
      await repairRoutingDispatch(env, run);
    }
    expect(destination.lookups).toHaveLength(5);
    const row = (await rows())[0]!;
    expect(row.failure_code).toBe("reconciliation_exhausted");
    await recordRoutingDispatchReceipt(env.MAIL_CATALOG, {
      schemaVersion: 1,
      operationId: row.operation_id,
      requestSha256: row.request_sha256,
      result: "handled",
    });
    expect((await rows())[0]?.state).toBe("handled");
  });
  it("administrative drain blocks new offers until explicit activation", async () => {
    await configure(artifact());
    await repairRoutingDispatch(env);
    await drainRoutingDispatch(env.MAIL_CATALOG);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    expect((await repairRoutingDispatch(env, run)).status).toBe("paused");
    expect(destination.requests).toHaveLength(0);
    expect(await activateRoutingDispatch(env)).toBe("active");
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
  });
  it("makes the first scheduled pass after a drain full", async () => {
    await env.MAIL_CATALOG.prepare("DELETE FROM catalog_scans").run();
    await configure(artifact());
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    const scheduled = () => repairRoutingDispatch(env, run, undefined, true);
    expect((await scheduled()).processed).toBe(0);
    await drainRoutingDispatch(env.MAIL_CATALOG);
    await source();
    expect((await scheduled()).status).toBe("paused");
    expect(await activateRoutingDispatch(env)).toBe("active");
    expect((await scheduled()).processed).toBe(1);
    expect(destination.requests).toHaveLength(1);
  });
  it("only one concurrent administrative receipt can resolve an uncertain operation", async () => {
    await configure(artifact());
    await source();
    const destination = service("uncertain");
    await repairRoutingDispatch(env, runtime({ "active-a": destination.binding }));
    const row = (await rows())[0]!;
    const identity = {
      schemaVersion: 1 as const,
      operationId: row.operation_id,
      requestSha256: row.request_sha256,
    };
    const results = await Promise.allSettled([
      recordRoutingDispatchReceipt(env.MAIL_CATALOG, { ...identity, result: "handled" }),
      recordRoutingDispatchReceipt(env.MAIL_CATALOG, { ...identity, result: "rejected" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["handled", "rejected"]).toContain((await rows())[0]?.state);
  });
  it("records a re-extracted invalid source against its new extraction and backs off", async () => {
    await configure(artifact());
    const { rawKey } = await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET metadata_json='{',updated_at=2 WHERE raw_key=?",
    )
      .bind(rawKey)
      .run();
    const job = async () =>
      env.MAIL_CATALOG.prepare(
        "SELECT source_sha256,extraction_updated_at,revision,state,failure_code,updated_at FROM routing_dispatch_jobs",
      ).first();
    await repairRoutingDispatch(env, run);
    const held = {
      source_sha256: rawSha,
      extraction_updated_at: 2,
      revision: 1,
      state: "held",
      failure_code: "invalid_source",
      updated_at: clock,
    };
    expect(await job()).toEqual(held);
    clock += 1000;
    await repairRoutingDispatch(env, run);
    expect(await job()).toEqual(held);
    expect(destination.requests).toHaveLength(1);
  });
  it("bounds work and lets malformed metadata yield to later sources", async () => {
    await configure(artifact());
    await source(1, { invalidMetadata: true });
    await source(2, { invalidMetadata: true });
    await source(3, { invalidMetadata: true });
    await source(4);
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    await repairRoutingDispatch(env, run);
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
  });
  it("unresolved classification can only choose generic classifications and is gated again before action", async () => {
    const config = artifact();
    config.routing.configJson = JSON.stringify({
      schemaVersion: 1,
      adoptions: [],
      rules: [],
      fallback: "unresolved",
    });
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    let gates = 0;
    run.resolveFallback = async () => ({
      outcome: "review",
      category: "security",
      urgent: true,
      evidenceCode: "synthetic_classified",
    });
    run.gateNotification = async () => {
      gates++;
      return { outcome: "allow", evidenceCode: "synthetic_allowed" };
    };
    await repairRoutingDispatch(env, run);
    expect(destination.requests[0]).toMatchObject({
      classification: { outcome: "review", category: "security", urgent: true },
    });
    expect(gates).toBe(2);
  });
  it("holds ordinary notifications when no trusted gate has been provided", async () => {
    await configure(artifact());
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    delete run.gateNotification;
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
  });
  it("rebuilds a never-attempted notification after its classification changes", async () => {
    const config = artifact();
    config.routing.configJson = JSON.stringify({
      schemaVersion: 1,
      adoptions: [],
      rules: [],
      fallback: "unresolved",
    });
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    let category = "billing";
    run.resolveFallback = async () => ({
      outcome: "review",
      category,
      urgent: false,
      evidenceCode: "synthetic_classified",
    });
    let gate: "hold" | "allow" = "hold";
    run.gateNotification = async () => ({ outcome: gate, evidenceCode: "synthetic_gate" });
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([["ready", 0]]);
    // A later policy revision reclassifies the unsent mail before the gate allows it.
    category = "finance";
    gate = "allow";
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect(destination.requests[0]?.classification).toMatchObject({ category: "finance" });
    expect((await rows())[0]?.state).toBe("handled");
  });
  it("claims only the exact payload it read when another worker rebuilds the row", async () => {
    const config = artifact();
    config.routing.configJson = JSON.stringify({
      schemaVersion: 1,
      adoptions: [],
      rules: [],
      fallback: "unresolved",
    });
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    run.resolveFallback = async () => ({
      outcome: "review",
      category: "billing",
      urgent: false,
      evidenceCode: "synthetic_classified",
    });
    let rebuilt = false;
    run.gateNotification = async () => {
      if (!rebuilt) {
        // A worker whose source lease expired classifies differently and rebuilds
        // the never-attempted row between this worker's read and its claim.
        rebuilt = true;
        const [row] = await rows();
        const body = JSON.parse(row!.payload_json) as { classification: { category: string } };
        body.classification.category = "finance";
        const json = canonicalOfferJson(body);
        await env.MAIL_CATALOG.prepare(
          "UPDATE routing_dispatch_outbox SET payload_json=?,request_sha256=? WHERE operation_id=?",
        )
          .bind(json, await dispatchDigest(json), row!.operation_id)
          .run();
      }
      return { outcome: "allow", evidenceCode: "synthetic_gate" };
    };
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([["ready", 0]]);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect(destination.requests[0]?.classification).toMatchObject({ category: "billing" });
    const [row] = await rows();
    expect(row?.state).toBe("handled");
    expect(row?.request_sha256).toBe(destination.requests[0]?.requestSha256);
  });
  it("holds a notification whose insert lost to another worker's differently classified row", async () => {
    const config = artifact();
    config.routing.configJson = JSON.stringify({
      schemaVersion: 1,
      adoptions: [],
      rules: [],
      fallback: "unresolved",
    });
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    let category = "billing";
    run.resolveFallback = async () => ({
      outcome: "review",
      category,
      urgent: false,
      evidenceCode: "synthetic_classified",
    });
    let gate: "hold" | "allow" = "hold";
    run.gateNotification = async () => ({ outcome: gate, evidenceCode: "synthetic_gate" });
    // Record the row a worker with the older "billing" classification writes.
    await repairRoutingDispatch(env, run);
    const [stale] = await env.MAIL_CATALOG.prepare("SELECT * FROM routing_dispatch_outbox")
      .all<Record<string, unknown>>()
      .then((result) => result.results);
    await env.MAIL_CATALOG.prepare("DELETE FROM routing_dispatch_outbox").run();
    // This worker classifies as "finance". Between its read (no row) and its insert,
    // a worker whose source lease expired inserts the stale "billing" row.
    category = "finance";
    gate = "allow";
    const race = raceOnce("INSERT OR IGNORE INTO routing_dispatch_outbox", () => insertRow(stale!));
    await advance();
    await repairRoutingDispatch(
      { MAIL_ARCHIVE: env.MAIL_ARCHIVE, MAIL_CATALOG: race.catalog },
      run,
    );
    expect(race.raced()).toBe(true);
    expect(destination.requests).toHaveLength(0);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([["ready", 0]]);
    // The next pass rebuilds the never-attempted row from the current decision.
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect(destination.requests[0]?.classification).toMatchObject({ category: "finance" });
    expect((await rows())[0]?.state).toBe("handled");
  });
  it("holds a row another worker reinserted after this worker deleted it for a rebuild", async () => {
    const config = artifact();
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    let gate: "hold" | "allow" = "hold";
    run.gateNotification = async () => ({ outcome: gate, evidenceCode: "synthetic_gate" });
    await repairRoutingDispatch(env, run);
    const [stale] = await env.MAIL_CATALOG.prepare("SELECT * FROM routing_dispatch_outbox")
      .all<Record<string, unknown>>()
      .then((result) => result.results);
    expect(stale?.["revision"]).toBe(1);
    // Revision 2 makes the never-attempted row rebuild. Right after this worker deletes
    // it, a worker still on revision 1 whose source lease expired inserts it again.
    config.revision = 2;
    await configure(config);
    gate = "allow";
    const race = raceOnce(
      "DELETE FROM routing_dispatch_outbox WHERE operation_id=? AND attempts=0",
      () => insertRow(stale!),
      true,
    );
    await advance();
    await repairRoutingDispatch(
      { MAIL_ARCHIVE: env.MAIL_ARCHIVE, MAIL_CATALOG: race.catalog },
      run,
    );
    expect(race.raced()).toBe(true);
    expect(destination.requests).toHaveLength(0);
    expect((await rows()).map((row) => [row.state, row.attempts, row.revision])).toEqual([
      ["ready", 0, 1],
    ]);
    // The next pass rebuilds the row under revision 2 and sends it.
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect((await rows()).map((row) => [row.state, row.revision])).toEqual([["handled", 2]]);
  });
  it("claims only the source identity it read when a rebuild keeps the same payload", async () => {
    await configure(artifact());
    await source();
    const destination = service("retryable_error");
    const run = runtime({ "active-a": destination.binding });
    let rebuilt = false;
    run.gateNotification = async () => {
      if (!rebuilt) {
        // A worker whose source lease expired read an older extraction of the same
        // raw message. Its rebuild yields identical payload bytes but records the
        // older extraction identity on the never-attempted row.
        rebuilt = true;
        await env.MAIL_CATALOG.prepare(
          "UPDATE routing_dispatch_outbox SET extraction_updated_at=0",
        ).run();
      }
      return { outcome: "allow", evidenceCode: "synthetic_gate" };
    };
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([["ready", 0]]);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([["retry", 1]]);
    destination.setOffer("handled");
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(2);
    expect(destination.requests[1]?.requestSha256).toBe(destination.requests[0]?.requestSha256);
    expect((await rows())[0]?.state).toBe("handled");
  });
  it("keeps an attempted notification frozen when its classification changes", async () => {
    const config = artifact();
    config.routing.configJson = JSON.stringify({
      schemaVersion: 1,
      adoptions: [],
      rules: [],
      fallback: "unresolved",
    });
    await configure(config);
    await source();
    const destination = service("retryable_error");
    const run = runtime({ "active-a": destination.binding });
    let category = "billing";
    run.resolveFallback = async () => ({
      outcome: "review",
      category,
      urgent: false,
      evidenceCode: "synthetic_classified",
    });
    await repairRoutingDispatch(env, run);
    category = "finance";
    destination.setOffer("handled");
    await advance();
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(1);
    expect((await rows()).map((row) => [row.state, row.attempts])).toEqual([["retry", 1]]);
  });
  it.each([
    { category: "https://attacker.example.com/webhook" },
    { category: null, target: "desk" },
  ])("holds classifier output that attempts destination selection %#", async (extra) => {
    const config = artifact();
    config.routing.configJson = JSON.stringify({
      schemaVersion: 1,
      adoptions: [],
      rules: [],
      fallback: "unresolved",
    });
    await configure(config);
    await source();
    const destination = service();
    const run = runtime({ "active-a": destination.binding });
    run.resolveFallback = async () => ({
      outcome: "review",
      urgent: false,
      evidenceCode: "synthetic_classified",
      ...extra,
    });
    await repairRoutingDispatch(env, run);
    expect(destination.requests).toHaveLength(0);
  });
  it("rejects payload grants not explicitly requested and adopted", async () => {
    const config = await withOwner(artifact());
    config.owners[0]!.offerFields.push("text");
    await configure(config);
    await expect(loadDispatchConfiguration(env.MAIL_ARCHIVE)).rejects.toThrow();
  });
});

describe("authenticated fixed adapter protocol in workerd", () => {
  it("bounds immediately resolved empty chunks even when their microtasks starve the timer", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array());
      },
      cancel,
    });
    await expect(readDispatchBytes(body, 0, 1000)).rejects.toThrow("Bounded stream stalled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  const adapter: PluginAdapter = {
    kind: "https",
    offerUrl: "https://adapter.example.com/offer",
    statusUrl: "https://adapter.example.com/status",
    authRef: "synthetic",
    serviceRef: null,
    timeoutMs: 100,
  };
  const identity = { operationId: "a".repeat(64), requestSha256: "b".repeat(64) };
  it("rejects redirects without forwarding mail/auth and never infers success from a status", async () => {
    const send = vi.fn(async (input: RequestInfo | URL) => {
      const request = input as globalThis.Request;
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("Authorization")).toMatch(/^Bearer /);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example.com" },
      });
    });
    const receipt = await exchangeOffer(
      adapter,
      { auth: { synthetic: "synthetic-auth-value-00000000" }, fetch: send },
      identity.operationId,
      identity.requestSha256,
      "{}",
      false,
    );
    expect(receipt.result).toBe("uncertain");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["malformed", "wrong_identity", "oversized", "status_not_found"])(
    "holds %s responses without fallback",
    async (kind) => {
      const response =
        kind === "malformed"
          ? "{"
          : kind === "oversized"
            ? "a".repeat(4097)
            : JSON.stringify({
                schemaVersion: 1,
                ...identity,
                ...(kind === "wrong_identity" ? { operationId: "c".repeat(64) } : {}),
                result: kind === "status_not_found" ? "not_found" : "handled",
              });
      const receipt = await exchangeOffer(
        adapter,
        {
          auth: { synthetic: "synthetic-auth-value-00000000" },
          fetch: async () => new Response(response),
        },
        identity.operationId,
        identity.requestSha256,
        "{}",
        false,
      );
      expect(receipt.result).toBe("uncertain");
    },
  );
  it("bounds a stalled RPC call and leaves the outcome uncertain", async () => {
    const stalled: RoutingOfferService = {
      offer: () => new Promise(() => undefined),
      receipt: () => new Promise(() => undefined),
    };
    const receipt = await exchangeOffer(
      { kind: "rpc", serviceRef: "owner", timeoutMs: 5 },
      { auth: {}, rpcServices: { owner: stalled } },
      identity.operationId,
      identity.requestSha256,
      "{}",
      false,
    );
    expect(receipt.result).toBe("uncertain");
  });
});
