import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleConnectorStage, CONNECTOR_STAGE_PATH } from "../src/gmail-connector-stage.ts";
import { createConnectorGmailTransport } from "../src/gmail-connector-transport.ts";
import { runGmailImportPage, startGmailImport } from "../src/gmail-import.ts";
import { handleHttp } from "../src/http.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const origin = "https://mail.example.test";
const cfg = {
  transport: "connector",
  importId: "synthetic-native-stage",
  expectedAccountHash: "a".repeat(64),
  scope: {
    accountNamespace: "synthetic-account",
    before: 1_800_000_000,
    after: 1_600_000_000,
    includeSpamTrash: false,
  },
};
const principal = { id: "user:operator", scopes: ["mail:import" as const], fromAddresses: [] };
const stageEnv = () => ({
  API_ORIGIN: origin,
  GMAIL_IMPORT_CONFIG: JSON.stringify(cfg),
  MAIL_ARCHIVE: env.MAIL_ARCHIVE,
});
const prefix = `imports/gmail-connector-v1/${cfg.importId}`;
const encode = (text: string) => new TextEncoder().encode(text);
const hash = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const raw = new Uint8Array([...encode("Subject: Synthetic 日本語\r\n\r\n"), 0, 255, 13, 10]);
async function entry(id = "abcd", bytes = raw) {
  return {
    id,
    threadId: `thread_${id}`,
    internalDate: "1700000000000",
    labelIds: ["SENT", "Label_1"],
    raw: btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
    rawSize: bytes.length,
    rawSha256: await hash(bytes),
  };
}
async function input(
  entries?: Awaited<ReturnType<typeof entry>>[],
  changes: Record<string, unknown> = {},
) {
  entries ??= [await entry()];
  return {
    schemaVersion: 1,
    importId: cfg.importId,
    accountHash: cfg.expectedAccountHash,
    scope: cfg.scope,
    entries,
    ...changes,
  };
}
async function request(value?: unknown, headers: Record<string, string> = {}) {
  value ??= await input();
  const body = JSON.stringify(value);
  return new Request(origin + CONNECTOR_STAGE_PATH, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "x-fumi-stage-sha256": await hash(encode(body)),
      ...headers,
    },
    body,
  });
}
const objects = async () => (await env.MAIL_ARCHIVE.list({ prefix })).objects;
beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  vi.useRealTimers();
  const existing = await objects();
  if (existing.length) await env.MAIL_ARCHIVE.delete(existing.map((object) => object.key));
  await env.MAIL_CATALOG.exec(
    "DELETE FROM gmail_import_items; DELETE FROM gmail_imports; DELETE FROM gmail_messages; DELETE FROM mail_extractions; DELETE FROM processing_jobs; DELETE FROM archive_sources; DELETE FROM mail_events;",
  );
});

describe("native connector staging", () => {
  it("preserves exact binary bytes and immutable metadata, returns ordered receipts, and never imports or calls a network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network"));
    try {
      const entries = [await entry("bbbb"), await entry("aaaa")];
      const response = await handleConnectorStage(
        await request(await input(entries)),
        stageEnv(),
        principal,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const receipt = await response.json<{
        schemaVersion: number;
        requestSha256: string;
        staged: unknown[];
      }>();
      expect(Object.keys(receipt).sort()).toEqual(["requestSha256", "schemaVersion", "staged"]);
      expect(receipt.staged).toEqual(
        entries.map((value) => ({ id: value.id, size: raw.length, sha256: value.rawSha256 })),
      );
      await Promise.all(
        entries.map(async (value) => {
          const object = await env.MAIL_ARCHIVE.get(
            `${prefix}/raw/${value.id}/${value.rawSha256}.eml`,
          );
          expect(new Uint8Array(await object!.arrayBuffer())).toEqual(raw);
          expect(
            await (await env.MAIL_ARCHIVE.get(`${prefix}/messages/${value.id}.json`))!.text(),
          ).toBe(
            JSON.stringify({
              schemaVersion: 1,
              accountHash: cfg.expectedAccountHash,
              id: value.id,
              threadId: value.threadId,
              internalDate: value.internalDate,
              labelIds: value.labelIds,
              rawSize: raw.length,
              rawSha256: value.rawSha256,
            }),
          );
        }),
      );
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM archive_sources").first(),
      ).toEqual({ count: 0 });
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM processing_jobs").first(),
      ).toEqual({ count: 0 });
      expect(
        await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
      ).toEqual({ count: 0 });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it("supports exact retries and the unchanged historical page importer with notifications suppressed", async () => {
    const value = await input();
    expect((await handleConnectorStage(await request(value), stageEnv(), principal)).status).toBe(
      200,
    );
    expect((await handleConnectorStage(await request(value), stageEnv(), principal)).status).toBe(
      200,
    );
    expect(await objects()).toHaveLength(2);
    const page = {
      schemaVersion: 1,
      accountHash: cfg.expectedAccountHash,
      scope: cfg.scope,
      pageToken: null,
      messageIds: ["abcd"],
      nextPageToken: null,
    };
    const pageKey = await hash(encode(JSON.stringify(null)));
    await env.MAIL_ARCHIVE.put(`${prefix}/pages/${pageKey}.json`, JSON.stringify(page));
    await startGmailImport(env, cfg.importId, cfg.scope);
    // This fixture checks archive/provenance compatibility, not background MIME execution.
    const workflow = {
      createBatch: vi
        .fn()
        .mockImplementation(async ({ instances }: { instances: { id: string }[] }) => ({
          created: instances.map(({ id }) => ({ id })),
          errors: [],
        })),
      get: vi.fn().mockResolvedValue({ status: async () => ({ status: "queued" }) }),
    };
    expect(
      await runGmailImportPage(
        { ...env, MAIL_PROCESSING: workflow },
        createConnectorGmailTransport({ bucket: env.MAIL_ARCHIVE, ...cfg }),
        cfg.importId,
        cfg.scope,
      ),
    ).toEqual({ status: "complete", imported: 1 });
    expect(workflow.createBatch).toHaveBeenCalledTimes(1);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT source_kind,notify_events FROM archive_sources",
      ).first(),
    ).toEqual({ source_kind: "gmail", notify_events: 0 });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
    ).toEqual({ count: 0 });
  });

  it("atomically rejects concurrent changed metadata without overwriting the winner", async () => {
    const first = await input();
    const second = await input([{ ...(await entry()), threadId: "other_thread" }]);
    const replies = await Promise.all(
      [first, second].map(async (value) =>
        handleConnectorStage(await request(value), stageEnv(), principal),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
    const metadata = await (await env.MAIL_ARCHIVE.get(`${prefix}/messages/abcd.json`))!.json<{
      threadId: string;
    }>();
    expect(["thread_abcd", "other_thread"]).toContain(metadata.threadId);
    expect(
      (
        await handleConnectorStage(
          await request(metadata.threadId === "thread_abcd" ? first : second),
          stageEnv(),
          principal,
        )
      ).status,
    ).toBe(200);
  });

  it("validates every entry, request identity and complete scope before any write", async () => {
    const valid = await entry();
    const variants = [
      await input([valid, { ...(await entry("second")), rawSha256: "b".repeat(64) }]),
      await input([valid, { ...(await entry("second")), labelIds: ["TRASH"] }]),
      await input([valid, { ...(await entry("second")), internalDate: "1800000000000" }]),
      await input([valid, { ...(await entry("second")), internalDate: "1599999999999" }]),
      await input([valid, { ...(await entry("second")), raw: "AB" }]),
      await input([valid, { ...(await entry("second")), rawSize: 1 }]),
      await input([valid, { ...(await entry("second")), labelIds: ["SENT", "SENT"] }]),
      await input([valid, { ...(await entry("second")), id: "../escape" }]),
      await input([valid, valid]),
      await input([], {}),
      await input(Array.from({ length: 11 }, () => valid)),
      await input([valid], { accountHash: "b".repeat(64) }),
      await input([valid], { importId: "other" }),
      await input([valid], { scope: { ...cfg.scope, before: cfg.scope.before - 1 } }),
      await input([valid], { endpoint: "https://untrusted.example.test" }),
    ];
    for (const value of variants) {
      // oxlint-disable-next-line no-await-in-loop -- Each invalid full batch must make zero writes.
      const response = await handleConnectorStage(await request(value), stageEnv(), principal);
      expect(response.status).toBeGreaterThanOrEqual(400);
      // oxlint-disable-next-line no-await-in-loop -- Inspect persistence after each rejected batch.
      expect(await objects()).toHaveLength(0);
    }
    expect(
      (
        await handleConnectorStage(
          await request(await input(), { "x-fumi-stage-sha256": "b".repeat(64) }),
          stageEnv(),
          principal,
        )
      ).status,
    ).toBe(400);
    expect(await objects()).toHaveLength(0);
  });

  it("rejects missing grants, cross-origin and invalid configuration before reading request bytes", async () => {
    let reads = 0;
    const make = (originHeader = origin) =>
      new Request(origin + CONNECTOR_STAGE_PATH, {
        method: "POST",
        headers: {
          origin: originHeader,
          "content-type": "application/json",
          "x-fumi-stage-sha256": "a".repeat(64),
        },
        body: new ReadableStream(
          {
            pull() {
              reads++;
              return new Promise(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
      });
    expect(
      (await handleConnectorStage(make(), stageEnv(), { ...principal, scopes: [] })).status,
    ).toBe(403);
    expect(
      (await handleConnectorStage(make("https://other.example.test"), stageEnv(), principal))
        .status,
    ).toBe(403);
    expect(
      (
        await handleConnectorStage(
          make(),
          { ...stageEnv(), GMAIL_IMPORT_CONFIG: undefined },
          principal,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await handleConnectorStage(
          make(),
          { ...stageEnv(), GMAIL_IMPORT_CONFIG: JSON.stringify({ ...cfg, transport: "oauth" }) },
          principal,
        )
      ).status,
    ).toBe(503);
    expect(reads).toBe(0);
  });

  it("enforces exact URL, content type, identity header and actual/declared lengths", async () => {
    const base = await request();
    const query = new Request(base.url + "?scope=other", base);
    expect((await handleConnectorStage(query, stageEnv(), principal)).status).toBe(400);
    await Promise.all(
      [
        { "content-type": "text/plain" },
        { "content-encoding": "gzip" },
        { "x-fumi-stage-sha256": "invalid" },
        { "content-length": "1" },
        { "content-length": "2500001" },
      ].map(async (headers) => {
        expect(
          (await handleConnectorStage(await request(await input(), headers), stageEnv(), principal))
            .status,
        ).toBeGreaterThanOrEqual(400);
      }),
    );
    const oversized = new Request(origin + CONNECTOR_STAGE_PATH, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-fumi-stage-sha256": "a".repeat(64),
      },
      body: new Uint8Array(2_500_001),
    });
    expect((await handleConnectorStage(oversized, stageEnv(), principal)).status).toBe(413);
    expect(await objects()).toHaveLength(0);
  });

  it("bounds stalled and empty-byte request streams without waiting for cancellation", async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Request(origin + CONNECTOR_STAGE_PATH, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-fumi-stage-sha256": "a".repeat(64),
        },
        body: new ReadableStream({
          pull() {
            return new Promise(() => {});
          },
          cancel() {
            return new Promise(() => {});
          },
        }),
      });
      const pending = handleConnectorStage(stalled, stageEnv(), principal);
      await vi.advanceTimersByTimeAsync(15_001);
      expect((await pending).status).toBe(504);
      let chunks = 0;
      const empty = new Request(origin + CONNECTOR_STAGE_PATH, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-fumi-stage-sha256": "a".repeat(64),
        },
        body: new ReadableStream(
          {
            pull(controller) {
              chunks++;
              controller.enqueue(new Uint8Array());
            },
          },
          { highWaterMark: 0 },
        ),
      });
      expect((await handleConnectorStage(empty, stageEnv(), principal)).status).toBe(400);
      expect(chunks).toBe(8);
    } finally {
      vi.useRealTimers();
    }
    expect(await objects()).toHaveLength(0);
  });

  it("holds a corrupted raw or metadata object instead of overwriting or acknowledging it", async () => {
    const value = await entry();
    const key = `${prefix}/raw/abcd/${value.rawSha256}.eml`;
    await env.MAIL_ARCHIVE.put(
      key,
      raw.map((byte) => byte ^ 1),
    );
    expect((await handleConnectorStage(await request(), stageEnv(), principal)).status).toBe(409);
    expect(new Uint8Array(await (await env.MAIL_ARCHIVE.get(key))!.arrayBuffer())).toEqual(
      raw.map((byte) => byte ^ 1),
    );
    expect(await env.MAIL_ARCHIVE.get(`${prefix}/messages/abcd.json`)).toBeNull();
    await env.MAIL_ARCHIVE.delete(key);
    await env.MAIL_ARCHIVE.put(`${prefix}/messages/abcd.json`, "{}");
    expect((await handleConnectorStage(await request(), stageEnv(), principal)).status).toBe(409);
    expect(await (await env.MAIL_ARCHIVE.get(`${prefix}/messages/abcd.json`))!.text()).toBe("{}");
  });

  it("replays a partially committed batch without overwriting or acknowledging the failed attempt", async () => {
    let fail = true;
    let active = 0;
    let peak = 0;
    const bucket = {
      put: async (...args: Parameters<R2Bucket["put"]>) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (fail && args[0].endsWith("/messages/item_2.json"))
            throw new Error("Synthetic failure");
          return await env.MAIL_ARCHIVE.put(...args);
        } finally {
          active--;
        }
      },
      get: (key: string) => env.MAIL_ARCHIVE.get(key),
    } as unknown as R2Bucket;
    const entries = await Promise.all(
      Array.from({ length: 10 }, (_, index) => entry(`item_${index}`)),
    );
    const first = await handleConnectorStage(
      await request(await input(entries)),
      { ...stageEnv(), MAIL_ARCHIVE: bucket },
      principal,
    );
    expect(first.status).toBe(503);
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(5);
    expect((await objects()).length).toBeGreaterThan(0);
    fail = false;
    expect(
      (
        await handleConnectorStage(
          await request(await input(entries)),
          { ...stageEnv(), MAIL_ARCHIVE: bucket },
          principal,
        )
      ).status,
    ).toBe(200);
    expect(await objects()).toHaveLength(20);
  });

  it("bounds the R2 lookup deadline and disposes a late body without starting metadata writes", async () => {
    vi.useFakeTimers();
    try {
      let resolveGet: ((value: unknown) => void) | undefined;
      const put = vi.fn(async () => null);
      const bucket = {
        put,
        get: () =>
          new Promise((resolve) => {
            resolveGet = resolve;
          }),
      } as unknown as R2Bucket;
      const req = await request();
      const pending = handleConnectorStage(req, { ...stageEnv(), MAIL_ARCHIVE: bucket }, principal);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(30_001);
      expect((await pending).status).toBe(504);
      expect(put).toHaveBeenCalledTimes(1);
      let cancelled = false;
      resolveGet!({
        size: raw.length,
        body: new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(cancelled).toBe(true);
      expect(put).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mounts JWT, operator scope and explicit same-origin gates before staging", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "synthetic-stage-key";
    const issuer = "https://synthetic-stage.cloudflareaccess.com";
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) !== `${issuer}/cdn-cgi/access/certs`) throw new Error("Unexpected network");
      return Response.json({ keys: [jwk] });
    });
    const settings = {
      ...env,
      ...stageEnv(),
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "synthetic-stage-app",
      MAIL_GRANTS: JSON.stringify({
        "user:operator": { scopes: ["mail:import"], fromAddresses: [] },
        "user:reader": { scopes: ["mail:read"], fromAddresses: [] },
      }),
    };
    async function authenticated(subject: string, withOrigin = true) {
      const token = await new SignJWT({ type: "app", sub: subject })
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-stage-key" })
        .setIssuer(issuer)
        .setAudience(settings.ACCESS_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      const req = await request();
      req.headers.set("cf-access-jwt-assertion", token);
      if (!withOrigin) req.headers.delete("origin");
      return req;
    }
    try {
      expect((await handleHttp(await request(), settings)).status).toBe(401);
      expect((await handleHttp(await authenticated("reader"), settings)).status).toBe(403);
      expect((await handleHttp(await authenticated("operator", false), settings)).status).toBe(403);
      expect(await objects()).toHaveLength(0);
      expect((await handleHttp(await authenticated("operator"), settings)).status).toBe(200);
    } finally {
      network.mockRestore();
    }
  });
});
