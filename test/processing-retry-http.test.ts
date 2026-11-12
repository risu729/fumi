import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { handleProcessingRetry } from "../src/processing-retry-http.ts";
import { handleHttp } from "../src/http.ts";
import {
  completeProcessing,
  processingInstanceId,
  readProcessingJob,
} from "../src/processing-jobs.ts";

const origin = "https://mail.example.invalid";
const id = "00000000-0000-4000-8000-000000000001";
const rawKey = `ingest/2026-11-10/${id}/raw.eml`;
const path = `/api/admin/archive/retry/mail_${id}`;
const operator = { id: "user:operator", scopes: ["mail:import" as const], fromAddresses: [] };
const workflow = () => ({
  createBatch: vi
    .fn()
    .mockImplementation(async ({ instances }: { instances: { id: string }[] }) => ({
      created: instances.map(({ id: instanceId }) => ({ id: instanceId })),
      errors: [],
    })),
  get: vi.fn().mockImplementation(async (instanceId: string) => ({
    status: async () => ({
      status: instanceId === processingInstanceId(rawKey) ? "errored" : "queued",
    }),
  })),
});
function post(body = '{"expectedAttempt":0}', changes: RequestInit = {}) {
  return new Request(origin + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body,
    ...changes,
  });
}
async function seed(state: "failed" | "pending" | "running" | "complete" = "failed") {
  await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,raw_state,receipt_state,observed_pass,observed_revision,notify_events)
    VALUES ('gmail','synthetic-account',?,?,?,'present','missing',0,0,0)`)
    .bind(id, rawKey, rawKey.replace("raw.eml", "receipt.json"))
    .run();
  await env.MAIL_CATALOG.prepare(`INSERT INTO processing_jobs (raw_key,pipeline_version,attempt,instance_id,state,created_at,updated_at,next_check_at,completed_at,failure_code)
    VALUES (?,'mime-v1',0,?,?,1,1,0,?,?)`)
    .bind(
      rawKey,
      processingInstanceId(rawKey),
      state,
      state === "complete" ? 1 : null,
      state === "failed" ? "catalog_failed" : null,
    )
    .run();
}
const job = () => readProcessingJob(env.MAIL_CATALOG.withSession("first-primary"), rawKey);
beforeAll(() => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.useRealTimers();
  await env.MAIL_CATALOG.exec(
    "DELETE FROM processing_jobs; DELETE FROM archive_sources; DELETE FROM mail_events;",
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("requires import permission and exact same-origin POST before consuming input", async () => {
  const binding = workflow(),
    settings = { ...env, MAIL_PROCESSING: binding };
  const untouched = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull: untouched }, { highWaterMark: 0 });
  expect(
    (
      await handleProcessingRetry(post("", { body: stream }), settings, {
        ...operator,
        scopes: ["mail:read"],
      })
    ).status,
  ).toBe(403);
  expect(untouched).not.toHaveBeenCalled();
  expect(
    (await handleProcessingRetry(post("", { method: "GET", body: null }), settings, operator))
      .status,
  ).toBe(405);
  await Promise.all(
    [null, "https://foreign.example.invalid"].map(async (selectedOrigin) => {
      const request = post();
      if (selectedOrigin === null) request.headers.delete("origin");
      else request.headers.set("origin", selectedOrigin);
      expect((await handleProcessingRetry(request, settings, operator)).status).toBe(403);
    }),
  );
  expect(
    (
      await handleProcessingRetry(
        new Request(origin + path + "/extra", { method: "POST" }),
        settings,
        operator,
      )
    ).status,
  ).toBe(404);
  expect(binding.get).not.toHaveBeenCalled();
  expect(binding.createBatch).not.toHaveBeenCalled();
});

it.each([
  "",
  "{",
  "null",
  "[]",
  "{}",
  '{"expectedAttempt":-1}',
  '{"expectedAttempt":0.1}',
  '{"expectedAttempt":"0"}',
  '{"expectedAttempt":9007199254740991}',
  '{"expectedAttempt":0,"rawKey":"untrusted"}',
  " ".repeat(129),
])("rejects malformed or unbounded retry input %j without effects", async (body) => {
  await seed();
  const binding = workflow();
  expect(
    (await handleProcessingRetry(post(body), { ...env, MAIL_PROCESSING: binding }, operator))
      .status,
  ).toBe(400);
  expect(await job()).toMatchObject({
    state: "failed",
    attempt: 0,
    failure_code: "catalog_failed",
  });
  expect(binding.get).not.toHaveBeenCalled();
});

it("rejects query, content encoding/type and advertised oversized input before reads", async () => {
  const binding = workflow(),
    settings = { ...env, MAIL_PROCESSING: binding };
  const query = new Request(origin + path + "?all=true", post());
  expect((await handleProcessingRetry(query, settings, operator)).status).toBe(400);
  await Promise.all(
    [
      ["content-length", "129"],
      ["content-length", "bad"],
      ["content-type", "text/plain"],
      ["content-encoding", "gzip"],
    ].map(async ([name, value]) => {
      const request = post();
      request.headers.set(name!, value!);
      expect((await handleProcessingRetry(request, settings, operator)).status).toBe(400);
    }),
  );
  expect(binding.get).not.toHaveBeenCalled();
});

it("bounds stalled and empty-chunk streams even when cancellation never resolves", async () => {
  const binding = workflow(),
    settings = { ...env, MAIL_PROCESSING: binding };
  vi.useFakeTimers();
  const stalled = new ReadableStream<Uint8Array>({ cancel: () => new Promise(() => {}) });
  const response = handleProcessingRetry(post("", { body: stalled }), settings, operator);
  await vi.advanceTimersByTimeAsync(1001);
  expect((await response).status).toBe(400);
  vi.useRealTimers();
  const empty = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array());
    },
    cancel: () => new Promise(() => {}),
  });
  expect((await handleProcessingRetry(post("", { body: empty }), settings, operator)).status).toBe(
    400,
  );
  expect(binding.get).not.toHaveBeenCalled();
});

it("requires an existing canonical present source with the selected external identity", async () => {
  const binding = workflow(),
    settings = { ...env, MAIL_PROCESSING: binding };
  expect((await handleProcessingRetry(post(), settings, operator)).status).toBe(404);
  await seed();
  await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_state='missing'").run();
  expect((await handleProcessingRetry(post(), settings, operator)).status).toBe(409);
  await env.MAIL_CATALOG.prepare(
    "UPDATE archive_sources SET raw_state='present',raw_key='untrusted/raw.eml'",
  ).run();
  expect((await handleProcessingRetry(post(), settings, operator)).status).toBe(409);
  expect(binding.get).not.toHaveBeenCalled();
});

it("rejects ambiguous catalog external identities before touching either failed job", async () => {
  await seed();
  await env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (source_kind,source_namespace,external_id,raw_key,receipt_key,raw_state,receipt_state,observed_pass,observed_revision,notify_events)
    VALUES ('gmail','other-synthetic-account',?,?,?,'present','missing',0,0,0)`)
    .bind(
      id,
      rawKey.replace("2026-11-10", "2026-11-11"),
      rawKey.replace("2026-11-10", "2026-11-11").replace("raw.eml", "receipt.json"),
    )
    .run();
  const binding = workflow();
  expect(
    (await handleProcessingRetry(post(), { ...env, MAIL_PROCESSING: binding }, operator)).status,
  ).toBe(409);
  expect(await job()).toMatchObject({ state: "failed", attempt: 0 });
  expect(binding.get).not.toHaveBeenCalled();
});

it.each(["pending", "running", "complete"] as const)("never retries a %s ledger", async (state) => {
  await seed(state);
  const binding = workflow();
  expect(
    (await handleProcessingRetry(post(), { ...env, MAIL_PROCESSING: binding }, operator)).status,
  ).toBe(409);
  expect(await job()).toMatchObject({ state, attempt: 0 });
  expect(binding.get).not.toHaveBeenCalled();
});

it("holds stale attempts, unconfirmed terminal status and unavailable status without resetting failure", async () => {
  await seed();
  const binding = workflow(),
    settings = { ...env, MAIL_PROCESSING: binding };
  expect(
    (await handleProcessingRetry(post('{"expectedAttempt":1}'), settings, operator)).status,
  ).toBe(409);
  expect(binding.get).not.toHaveBeenCalled();
  binding.get.mockResolvedValue({ status: async () => ({ status: "running" }) });
  expect((await handleProcessingRetry(post(), settings, operator)).status).toBe(409);
  binding.get.mockRejectedValue(new Error("private service diagnostic"));
  const response = await handleProcessingRetry(post(), settings, operator);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "processing_retry_unavailable" } });
  expect(await job()).toMatchObject({
    state: "failed",
    attempt: 0,
    failure_code: "catalog_failed",
  });
  expect(binding.createBatch).not.toHaveBeenCalled();
});

it("accepts one concurrent retry, preserves historical provenance and never replays the old attempt", async () => {
  await seed();
  const originalSource = await env.MAIL_CATALOG.prepare("SELECT * FROM archive_sources").first();
  const binding = workflow(),
    settings = { ...env, MAIL_PROCESSING: binding };
  const responses = await Promise.all([
    handleProcessingRetry(post(), settings, operator),
    handleProcessingRetry(post(), settings, operator),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
  expect(await responses.find((response) => response.status === 202)!.json()).toEqual({
    status: "accepted",
    attempt: 1,
  });
  expect(binding.createBatch).toHaveBeenCalledTimes(1);
  expect(binding.createBatch.mock.calls[0]![0].instances).toEqual([
    {
      id: processingInstanceId(rawKey, 1),
      params: { rawKey, pipelineVersion: "mime-v1", attempt: 1 },
    },
  ]);
  expect(await job()).toMatchObject({ state: "pending", attempt: 1, failure_code: null });
  expect((await handleProcessingRetry(post(), settings, operator)).status).toBe(409);
  expect(binding.createBatch).toHaveBeenCalledTimes(1);
  await completeProcessing(env.MAIL_CATALOG.withSession("first-primary"), {
    rawKey,
    pipelineVersion: "mime-v1",
    attempt: 1,
  });
  expect(await env.MAIL_CATALOG.prepare("SELECT * FROM archive_sources").first()).toEqual(
    originalSource,
  );
  expect(
    await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
  ).toEqual({ count: 0 });
});

it("keeps an accepted unavailable start durable for bounded scheduled repair", async () => {
  await seed();
  const binding = workflow();
  binding.createBatch.mockRejectedValue(new Error("unavailable"));
  expect(
    (await handleProcessingRetry(post(), { ...env, MAIL_PROCESSING: binding }, operator)).status,
  ).toBe(202);
  expect(await job()).toMatchObject({
    state: "pending",
    attempt: 1,
    failure_code: "dispatch_unavailable",
    dispatched_at: null,
  });
});

it("mounts Access JWT, same-origin and import-scope gates before selecting or retrying", async () => {
  await seed();
  const keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  jwk.kid = "synthetic-processing-retry";
  const issuer = "https://synthetic-retry.cloudflareaccess.com";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url) !== `${issuer}/cdn-cgi/access/certs`) throw new Error("Unexpected network");
    return Response.json({ keys: [jwk] });
  });
  const binding = workflow();
  const mountedWorkflow = new Proxy(env.MAIL_PROCESSING, {
    get(target, property, receiver) {
      if (property === "createBatch") return binding.createBatch;
      if (property === "get") return binding.get;
      return Reflect.get(target, property, receiver);
    },
  });
  const settings = {
    ...env,
    MAIL_PROCESSING: mountedWorkflow,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "synthetic-retry",
    MAIL_GRANTS: JSON.stringify({
      "user:operator": { scopes: ["mail:import"], fromAddresses: [] },
      "user:reader": { scopes: ["mail:read"], fromAddresses: [] },
    }),
  };
  async function authenticated(subject: string) {
    const request = post();
    request.headers.set(
      "cf-access-jwt-assertion",
      await new SignJWT({ type: "app", sub: subject })
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-processing-retry" })
        .setIssuer(issuer)
        .setAudience(settings.ACCESS_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey),
    );
    return request;
  }
  expect((await handleHttp(post(), settings)).status).toBe(401);
  expect((await handleHttp(await authenticated("reader"), settings)).status).toBe(403);
  const missingOrigin = await authenticated("operator");
  missingOrigin.headers.delete("origin");
  expect((await handleHttp(missingOrigin, settings)).status).toBe(403);
  const foreignOrigin = await authenticated("operator");
  foreignOrigin.headers.set("origin", "https://foreign.example.invalid");
  expect((await handleHttp(foreignOrigin, settings)).status).toBe(403);
  expect(await job()).toMatchObject({ state: "failed", attempt: 0 });
  expect(binding.get).not.toHaveBeenCalled();
  const accepted = await handleHttp(await authenticated("operator"), settings);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(binding.createBatch).toHaveBeenCalledTimes(1);
});
