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
function artifact(): Artifact {
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
async function withOwner(config: Artifact, fields: OfferField[] = ["subject"], version = "1.0.0") {
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
      failure_code: string | null;
    }>()
  ).results;
}
async function advance() {
  clock += 100_000;
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
  it("records ordinary webhook HTTP acceptance once without claiming provider delivery", async () => {
    const config = artifact();
    config.destination.adapter = {
      kind: "webhook",
      url: "https://notification.example.com/notify",
      authRef: "synthetic",
      timeoutMs: 1000,
    };
    await configure(config);
    await source();
    let calls = 0;
    const run: RoutingDispatchRuntime = {
      ...runtime({}),
      transport: {
        auth: { synthetic: "synthetic-webhook-auth-0000000" },
        fetch: async () => {
          calls++;
          return new Response(null, { status: 202 });
        },
      },
    };
    await repairRoutingDispatch(env, run);
    await advance();
    await repairRoutingDispatch(env, run);
    expect(calls).toBe(1);
    expect((await rows())[0]).toMatchObject({
      state: "accepted",
      failure_code: "http_acceptance_only",
    });
  });
  it("holds generic webhook ambiguity without reoffer or invented status polling", async () => {
    const config = artifact();
    config.destination.adapter = {
      kind: "webhook",
      url: "https://notification.example.com/notify",
      authRef: "synthetic",
      timeoutMs: 1000,
    };
    await configure(config);
    await source();
    let calls = 0;
    const run: RoutingDispatchRuntime = {
      ...runtime({}),
      transport: {
        auth: { synthetic: "synthetic-webhook-auth-0000000" },
        fetch: async () => {
          calls++;
          throw new Error("Synthetic lost response");
        },
      },
    };
    await repairRoutingDispatch(env, run);
    await advance();
    await repairRoutingDispatch(env, run);
    const row = (await rows())[0]!;
    expect(calls).toBe(1);
    expect(row.state).toBe("uncertain");
    await expect(
      recordRoutingDispatchReceipt(env.MAIL_CATALOG, {
        schemaVersion: 1,
        operationId: row.operation_id,
        requestSha256: row.request_sha256,
        result: "not_found",
      }),
    ).rejects.toThrow();
    await recordRoutingDispatchReceipt(env.MAIL_CATALOG, {
      schemaVersion: 1,
      operationId: row.operation_id,
      requestSha256: row.request_sha256,
      result: "handled",
    });
    expect((await rows())[0]).toMatchObject({
      state: "accepted",
      failure_code: "http_acceptance_only",
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
    config.destination.adapter = {
      kind: "webhook",
      url: "https://adapter.example.com/notify",
      authRef: "active",
      timeoutMs: 1000,
    };
    await configure(config);
    await source();
    const original = "synthetic-original-account-secret-0000";
    const auth: Record<string, string> = { active: original };
    let authorization: string | null = null;
    const run: RoutingDispatchRuntime = {
      ...runtime({}),
      transport: {
        auth,
        fetch: async (input, init) => {
          const request =
            input instanceof globalThis.Request ? input : new globalThis.Request(input, init);
          authorization = request.headers.get("Authorization");
          return new Response(null, { status: 202 });
        },
      },
      gateNotification: async () => {
        auth["active"] = "synthetic-replacement-account-secret-1111";
        return { outcome: "allow", evidenceCode: "synthetic_allowed" };
      },
    };
    await repairRoutingDispatch(env, run);
    expect(authorization).toBe(`Bearer ${original}`);
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
    first.setStatus("handled");
    await advance();
    await repairRoutingDispatch(env, run);
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
