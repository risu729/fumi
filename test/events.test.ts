import { env } from "cloudflare:workers";
import { applyD1Migrations, createScheduledController } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eventStatement } from "../src/event-store.ts";
import { handleEventRequest } from "../src/mcp-events.ts";
import {
  createAllowlistedWebhookHttp,
  deliverEvents,
  signedHeaders,
  validateCallback,
  type EventRuntime,
} from "../src/event-delivery.ts";
import { eventRuntime } from "../src/event-runtime.ts";
import { handleHttp } from "../src/http.ts";
import type { MailPrincipal } from "../src/principal.ts";
import worker from "../src/index.ts";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const principal: MailPrincipal = {
  id: "owner",
  scopes: ["mail:read", "mail:send", "mail:events"],
  fromAddresses: [],
};
const secret = `whsec_${btoa("a".repeat(32))}`;
const url = "https://receiver.example.com/callback";
let now = Date.parse("2026-11-11T12:00:00Z");
let delivered: { body: Record<string, unknown>; headers: Headers }[];
let status: number;
let allowed: boolean;
let runtime: EventRuntime;
async function subscribe(args: Record<string, unknown> = {}, user = principal) {
  return handleEventRequest(
    env.MAIL_CATALOG,
    user,
    "events/subscribe",
    { name: "email.received", delivery: { mode: "webhook", url, secret }, ...args },
    runtime,
  );
}
async function append(
  id: string,
  name: "email.received" | "email.send_status_changed" = "email.received",
  owner?: string,
) {
  await eventStatement(env.MAIL_CATALOG.withSession("first-primary"), {
    id,
    name,
    data: name === "email.received" ? { ingestId: id } : { operationId: id, status: "accepted" },
    occurredAt: new Date(now).toISOString(),
    ...(owner ? { principalId: owner } : {}),
  }).run();
}
beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.MAIL_CATALOG.batch(
    ["event_subscriptions", "mail_events", "event_callback_verifications"].map((table) =>
      env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`),
    ),
  );
  now = Date.parse("2026-11-11T12:00:00Z");
  delivered = [];
  status = 204;
  allowed = true;
  runtime = {
    now: () => now,
    authorize: async () => allowed,
    http: {
      async post(_url, body, headers) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        delivered.push({ body: parsed, headers });
        if (parsed["type"] === "verification")
          return Response.json({ challenge: parsed["challenge"] });
        return new Response(null, { status });
      },
    },
  };
});
describe("durable MCP Events", () => {
  it("accepts documented unsubscribe identity and bounds requested lifetimes", async () => {
    const subscription = await subscribe({ ttlMs: 120_000 });
    expect(subscription["refreshBefore"]).toBe(new Date(now + 120_000).toISOString());
    expect((await subscribe({ ttlMs: null }))["refreshBefore"]).toBe(
      new Date(now + 86_400_000).toISOString(),
    );
    expect((await subscribe({ ttlMs: 1 }))["refreshBefore"]).toBe(
      new Date(now + 60_000).toISOString(),
    );
    const identity = { name: "email.received", arguments: {}, delivery: { mode: "webhook", url } };
    await handleEventRequest(
      env.MAIL_CATALOG,
      { ...principal, id: "someone-else" },
      "events/unsubscribe",
      identity,
      runtime,
    );
    await append("still-active");
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 1 });
    await handleEventRequest(env.MAIL_CATALOG, principal, "events/unsubscribe", identity, runtime);
    await handleEventRequest(env.MAIL_CATALOG, principal, "events/unsubscribe", identity, runtime);
    await append("after-stop");
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 0 });
  });
  it("rotates signing keys with a bounded dual-signature window", async () => {
    const subscription = await subscribe();
    const replacement = `whsec_${btoa("b".repeat(32))}`;
    await subscribe({ delivery: { mode: "webhook", url, secret: replacement } });
    await append("rotated-event");
    await deliverEvents(env.MAIL_CATALOG, runtime);
    const first = delivered.at(-1)!;
    const oldHeaders = await signedHeaders(
      secret,
      "rotated-event",
      JSON.stringify(first.body),
      String(subscription["id"]),
      now,
    );
    const newHeaders = await signedHeaders(
      replacement,
      "rotated-event",
      JSON.stringify(first.body),
      String(subscription["id"]),
      now,
    );
    expect(first.headers.get("webhook-signature")).toBe(
      `${newHeaders.get("webhook-signature")} ${oldHeaders.get("webhook-signature")}`,
    );
    now += 300_001;
    await append("after-rotation");
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered.at(-1)!.headers.get("webhook-signature")!.split(" ")).toHaveLength(1);
  });
  it("rotates bounded dispatch fairly across subscriptions with continuing traffic", async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        subscribe({
          delivery: { mode: "webhook", url: `${url}/${index}`, secret },
        }),
      ),
    );
    delivered = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      now += 1000;
      // oxlint-disable-next-line no-await-in-loop -- Simulate consecutive scheduled runs with fresh traffic.
      await append(`continuous-${cycle}`);
      // oxlint-disable-next-line no-await-in-loop -- Bounded dispatcher gets another scheduling turn.
      await deliverEvents(env.MAIL_CATALOG, runtime, 2);
    }
    expect(new Set(delivered.map((item) => item.headers.get("X-MCP-Subscription-Id"))).size).toBe(
      5,
    );
  });
  it("verifies signed challenges and signs exact delivery bytes using Standard Webhooks", async () => {
    const subscription = await subscribe();
    expect(delivered[0]?.body["type"]).toBe("verification");
    await append("event-a");
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 1 });
    const delivery = delivered[1];
    expect(delivery?.body).toMatchObject({
      eventId: "event-a",
      name: "email.received",
      data: { ingestId: "event-a" },
    });
    const body = JSON.stringify(delivery?.body);
    const signature = delivery?.headers.get("webhook-signature")?.slice(3);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("a".repeat(32)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(atob(signature ?? ""), (c) => c.charCodeAt(0)),
        new TextEncoder().encode(`event-a.${Math.floor(now / 1000)}.${body}`),
      ),
    ).toBe(true);
    expect(delivery?.headers.get("X-MCP-Subscription-Id")).toBe(subscription["id"]);
    expect(body).not.toContain(secret);
  });
  it("creates deterministic identities, caches verification, and excludes historical rows", async () => {
    await append("historical");
    const first = await subscribe();
    const second = await subscribe();
    expect(second["id"]).toBe(first["id"]);
    expect(delivered).toHaveLength(1);
    await append("new-event");
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered.map(({ body }) => body["eventId"]).filter(Boolean)).toEqual(["new-event"]);
  });
  it("rejects failed challenges before activation and returns no callback secrets", async () => {
    runtime.http.post = async () => Response.json({ challenge: "wrong" });
    await expect(subscribe()).rejects.toMatchObject({
      code: -32015,
      data: { reason: "challenge_failed" },
    });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM event_subscriptions").first(
        "count",
      ),
    ).toBe(0);
  });
  it("filters discovery and subscription methods by principal and rejects unknown filter fields", async () => {
    const readOnly = { ...principal, scopes: ["mail:read", "mail:events"] };
    const list = await handleEventRequest(env.MAIL_CATALOG, readOnly, "events/list", {}, runtime);
    expect(JSON.stringify(list)).not.toContain("email.send_status_changed");
    await expect(subscribe({ name: "email.send_status_changed" }, readOnly)).rejects.toMatchObject({
      code: -32001,
    });
    await expect(subscribe({ arguments: { secret: "bad" } })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(subscribe({ arguments: { operationId: "op" } })).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      subscribe({ delivery: { mode: "webhook", url, secret: "whsec_YQ==" } }),
    ).rejects.toMatchObject({ code: -32602 });
  });
  it("isolates principal subscriptions and outbound event records", async () => {
    const mine = await subscribe({ name: "email.send_status_changed" });
    const other = { ...principal, id: "another-owner" };
    const theirs = await subscribe({ name: "email.send_status_changed" }, other);
    expect(mine["id"]).not.toBe(theirs["id"]);
    await handleEventRequest(
      env.MAIL_CATALOG,
      other,
      "events/unsubscribe",
      { id: mine["id"] },
      runtime,
    );
    await append("outbound-owner", "email.send_status_changed", principal.id);
    await deliverEvents(env.MAIL_CATALOG, runtime);
    const notices = delivered.filter(({ body }) => body["eventId"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.headers.get("X-MCP-Subscription-Id")).toBe(mine["id"]);
  });
  it("does not skip failed events and retries with stable IDs and fresh signatures", async () => {
    await subscribe();
    await append("first");
    await append("second");
    status = 503;
    await deliverEvents(env.MAIL_CATALOG, runtime);
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered).toHaveLength(2);
    now += 1001;
    status = 204;
    await deliverEvents(env.MAIL_CATALOG, runtime);
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered.map(({ body }) => body["eventId"]).filter(Boolean)).toEqual([
      "first",
      "first",
      "second",
    ]);
    expect(delivered[1]?.headers.get("webhook-signature")).not.toBe(
      delivered[2]?.headers.get("webhook-signature"),
    );
  });
  it("replays from a saved cursor on refresh without skipping pending events", async () => {
    const subscription = await subscribe();
    await append("first");
    await append("second");
    await deliverEvents(env.MAIL_CATALOG, runtime);
    await expect(subscribe({ cursor: `${subscription["id"]}:999999` })).rejects.toMatchObject({
      code: -32602,
    });
    await subscribe({ cursor: subscription["cursor"] });
    await deliverEvents(env.MAIL_CATALOG, runtime);
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered.map(({ body }) => body["eventId"]).filter(Boolean)).toEqual([
      "first",
      "first",
      "second",
    ]);
  });
  it("deduplicates transactional event IDs and rejects content leakage", async () => {
    await subscribe();
    await append("once");
    await append("once");
    await deliverEvents(env.MAIL_CATALOG, runtime);
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered.filter(({ body }) => body["eventId"])).toHaveLength(1);
    expect(() =>
      eventStatement(env.MAIL_CATALOG.withSession("first-primary"), {
        id: "bad",
        name: "email.received",
        data: { ingestId: "id", body: "private" } as never,
        occurredAt: new Date(now).toISOString(),
      }),
    ).toThrow("Invalid mail event");
  });
  it.each([410, 413])(
    "stops on HTTP %s without advancing the failed cursor",
    async (responseStatus) => {
      const subscription = await subscribe();
      await append("first");
      status = responseStatus;
      await deliverEvents(env.MAIL_CATALOG, runtime);
      now += 100_000;
      await deliverEvents(env.MAIL_CATALOG, runtime);
      expect(delivered.filter(({ body }) => body["eventId"])).toHaveLength(1);
      const row = await env.MAIL_CATALOG.prepare(
        "SELECT state,signing_secret,cursor FROM event_subscriptions WHERE id=?",
      )
        .bind(subscription["id"])
        .first();
      expect(row).toMatchObject({ state: "stopped", signing_secret: "" });
      expect(`${subscription["id"]}:${row?.["cursor"]}`).toBe(subscription["cursor"]);
    },
  );
  it("stops expired, revoked, and idempotently unsubscribed subscriptions", async () => {
    const subscription = await subscribe();
    await append("first");
    now += 86_400_001;
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered).toHaveLength(1);
    await subscribe();
    allowed = false;
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered).toHaveLength(2);
    allowed = true;
    await subscribe();
    for (let index = 0; index < 2; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- Verify sequential idempotent unsubscribe retries.
      await handleEventRequest(
        env.MAIL_CATALOG,
        principal,
        "events/unsubscribe",
        { id: subscription["id"] },
        runtime,
      );
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered).toHaveLength(2);
  });
  it("counts only live subscriptions toward the per-principal limit", async () => {
    const subscribeTo = (ingestId: string) => subscribe({ arguments: { ingestId } });
    for (let index = 0; index < 100; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- Fill the limit with distinct identities.
      await subscribeTo(`filled-${index}`);
    await expect(subscribeTo("over-limit")).rejects.toMatchObject({ code: -32001 });
    // Expired and stopped rows stay stored for refresh, but no longer hold a slot.
    now += 86_400_001;
    expect((await subscribeTo("after-expiry"))["id"]).toMatch(/^sub_/);
    for (let index = 1; index < 100; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- Fill the limit again with live identities.
      await subscribeTo(`refilled-${index}`);
    await expect(subscribeTo("over-limit-again")).rejects.toMatchObject({ code: -32001 });
    // Reviving an expired identity takes a new slot, so it cannot exceed the limit.
    await expect(subscribeTo("filled-0")).rejects.toMatchObject({ code: -32001 });
    const live = await subscribeTo("refilled-1");
    await handleEventRequest(
      env.MAIL_CATALOG,
      principal,
      "events/unsubscribe",
      { id: live["id"] },
      runtime,
    );
    expect((await subscribeTo("filled-0"))["id"]).toMatch(/^sub_/);
    // Refreshing a live subscription never counts against its own slot.
    expect((await subscribeTo("filled-0"))["id"]).toMatch(/^sub_/);
    expect(
      await env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS count FROM event_subscriptions WHERE state='active' AND expires_at>?",
      )
        .bind(now)
        .first("count"),
    ).toBe(100);
  });
  it("rejects a write that would exceed the limit after a concurrent request took the last slot", async () => {
    const subscribeTo = (ingestId: string, fill: string) =>
      subscribe({
        arguments: { ingestId },
        delivery: { mode: "webhook", url, secret: `whsec_${btoa(fill.repeat(32))}` },
      });
    const insertLive = (id: string, expiresAt = now + 60_000) =>
      env.MAIL_CATALOG.prepare(
        "INSERT INTO event_subscriptions (id,principal_id,name,arguments_json,callback_url,signing_secret,expires_at,start_sequence,cursor,state) VALUES (?,?,'email.received','{}',?,?,?,0,0,'active')",
      )
        .bind(id, principal.id, url, secret, expiresAt)
        .run();
    const liveCount = () =>
      env.MAIL_CATALOG.prepare(
        "SELECT COUNT(*) AS count FROM event_subscriptions WHERE state='active' AND expires_at>?",
      )
        .bind(now)
        .first("count");
    const expired = await subscribeTo("expired", "a");
    await env.MAIL_CATALOG.prepare("UPDATE event_subscriptions SET expires_at=? WHERE id=?")
      .bind(now - 1, expired["id"])
      .run();
    for (let index = 0; index < 99; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- Fill all but the last slot.
      await insertLive(`sub_filled_${index}`);
    // The concurrent request takes the last slot after this request's limit check,
    // while this request's callback is being verified.
    const { post } = runtime.http;
    let racer = 0;
    runtime.http = {
      async post(target, body, headers) {
        if ((JSON.parse(body) as Record<string, unknown>)["type"] === "verification") {
          racer += 1;
          await insertLive(`sub_racer_${racer}`);
        }
        return post(target, body, headers);
      },
    };
    await expect(subscribeTo("new", "b")).rejects.toMatchObject({
      code: -32015,
      data: { reason: "conflict" },
    });
    expect(await liveCount()).toBe(100);
    await env.MAIL_CATALOG.prepare("DELETE FROM event_subscriptions WHERE id=?")
      .bind(`sub_racer_${racer}`)
      .run();
    await expect(subscribeTo("expired", "c")).rejects.toMatchObject({
      code: -32015,
      data: { reason: "conflict" },
    });
    expect(await liveCount()).toBe(100);
  });
  it("matches resource filters and never advances past a delayed earlier event", async () => {
    await subscribe({ arguments: { ingestId: "target" } });
    await append("unmatched");
    await append("target");
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(
      delivered.filter(({ body }) => body["eventId"]).map(({ body }) => body["eventId"]),
    ).toEqual(["target"]);
  });
  it("bounds retry attempts and fences concurrent delivery workers", async () => {
    await subscribe();
    await append("retry-id");
    status = 503;
    await Promise.all([
      deliverEvents(env.MAIL_CATALOG, runtime),
      deliverEvents(env.MAIL_CATALOG, runtime),
    ]);
    expect(delivered.filter(({ body }) => body["eventId"])).toHaveLength(1);
    for (let attempt = 1; attempt < 9; attempt += 1) {
      now += 3_600_001;
      // oxlint-disable-next-line no-await-in-loop -- Advance the durable retry schedule through exhaustion.
      await deliverEvents(env.MAIL_CATALOG, runtime);
    }
    expect(delivered.filter(({ body }) => body["eventId"])).toHaveLength(8);
    expect(
      new Set(delivered.filter(({ body }) => body["eventId"]).map(({ body }) => body["eventId"])),
    ).toEqual(new Set(["retry-id"]));
  });
  async function subscribeTargets(count: number): Promise<string[]> {
    const targets = Array.from({ length: count }, (_, index) => `${url}/${index}`);
    for (const target of targets)
      // oxlint-disable-next-line no-await-in-loop -- Create the synthetic subscriptions one by one.
      await subscribe({ delivery: { mode: "webhook", url: target, secret } });
    return targets;
  }
  it("leases each subscription from the time it is reached, not from the batch start", async () => {
    await subscribeTargets(2);
    await append("shared");
    const posts: string[] = [];
    let overlapping = false;
    runtime.http.post = async (target) => {
      posts.push(target);
      // The first POST takes longer than a lease; the second overlaps a new scheduled run.
      if (posts.length === 1) now += 90_000;
      else if (!overlapping) {
        overlapping = true;
        await deliverEvents(env.MAIL_CATALOG, runtime);
      }
      return new Response(null, { status: 204 });
    };
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(posts).toHaveLength(2);
    expect(new Set(posts).size).toBe(2);
  });
  it("re-reads a subscription when leasing it, so an overlapping run cannot resend its event", async () => {
    await subscribeTargets(2);
    await append("shared");
    const posts: string[] = [];
    let overlapping = false;
    runtime.http.post = async (target) => {
      posts.push(target);
      // While the first POST is in flight, another run delivers the second subscription.
      if (!overlapping) {
        overlapping = true;
        await deliverEvents(env.MAIL_CATALOG, runtime);
      }
      return new Response(null, { status: 204 });
    };
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(posts).toHaveLength(2);
    expect(new Set(posts).size).toBe(2);
  });
  it("honours a retry backoff another run set after this run selected the subscription", async () => {
    await subscribeTargets(2);
    await append("shared");
    const posts: string[] = [];
    let overlapping = false;
    runtime.http.post = async (target) => {
      posts.push(target);
      if (!overlapping) {
        overlapping = true;
        status = 503;
        await deliverEvents(env.MAIL_CATALOG, runtime);
        status = 204;
      }
      return new Response(null, { status });
    };
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(posts).toHaveLength(2);
  });
  it("schedules a retry backoff from when the failed POST ends", async () => {
    const subscription = await subscribe();
    await append("slow-failure");
    const started = now;
    runtime.http.post = async () => {
      now += 5_000;
      return new Response(null, { status: 503 });
    };
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT next_attempt_at FROM event_subscriptions WHERE id=?")
        .bind(subscription["id"])
        .first("next_attempt_at"),
    ).toBe(started + 5_000 + 1_000);
  });
  it("does not POST with a lease that expired before the request could finish", async () => {
    await subscribe();
    await append("late");
    const authorize = runtime.authorize;
    runtime.authorize = async (...args) => {
      now += 50_001;
      return authorize(...args);
    };
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(delivered.filter(({ body }) => body["eventId"])).toHaveLength(0);
    runtime.authorize = authorize;
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 1 });
    expect(delivered.filter(({ body }) => body["eventId"])).toHaveLength(1);
  });
  it("counts the lease recheck's own latency before starting a POST", async () => {
    // Each query advances the clock when it returns, as a slow D1 round trip would.
    const slow = {
      withSession() {
        const session = env.MAIL_CATALOG.withSession("first-primary");
        return {
          prepare: (sql: string) => ({
            bind(...values: unknown[]) {
              const bound = session.prepare(sql).bind(...values);
              const later = async <T>(result: Promise<T>) => {
                const value = await result;
                now += 1_500;
                return value;
              };
              return {
                first: (column?: string) => later(column ? bound.first(column) : bound.first()),
                run: () => later(bound.run()),
                all: () => later(bound.all()),
              };
            },
          }),
        };
      },
    } as unknown as D1Database;
    const subscription = await subscribe();
    await append("slow-database");
    const authorize = runtime.authorize;
    runtime.authorize = async (...args) => {
      now += 46_000;
      return authorize(...args);
    };
    const remaining: number[] = [];
    runtime.http.post = async () => {
      const leaseUntil = await env.MAIL_CATALOG.prepare(
        "SELECT lease_until FROM event_subscriptions WHERE id=?",
      )
        .bind(subscription["id"])
        .first<number>("lease_until");
      remaining.push(leaseUntil! - now);
      return new Response(null, { status: 204 });
    };
    await deliverEvents(slow, runtime);
    runtime.authorize = authorize;
    await deliverEvents(slow, runtime);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBeGreaterThan(10_000);
  });
  it("stops leasing further subscriptions once the run's time budget is spent", async () => {
    const targets = await subscribeTargets(3);
    await append("shared");
    const posts: string[] = [];
    runtime.http.post = async (target) => {
      posts.push(target);
      now += 120_001;
      return new Response(null, { status: 204 });
    };
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 2 });
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 1 });
    expect(new Set(posts)).toEqual(new Set(targets));
  });
});
describe("scheduled stage isolation", () => {
  it("delivers MCP Events when outbound reconciliation fails in the same run", async () => {
    now = Date.now();
    const owner = { ...principal, id: "user:owner" };
    await subscribe({}, owner);
    await append("isolated-event");
    const withSession = env.MAIL_CATALOG.withSession.bind(env.MAIL_CATALOG);
    // A transient D1 failure in outbound receipt reconciliation only.
    const sessions = vi.spyOn(env.MAIL_CATALOG, "withSession").mockImplementation((constraint) => {
      const session = withSession(constraint);
      const prepare = session.prepare.bind(session);
      return Object.assign(session, {
        prepare(query: string) {
          if (query.includes("FROM outbound_operations WHERE state IN"))
            throw new Error("synthetic transient D1 failure for private-recipient@example.invalid");
          return prepare(query);
        },
      });
    });
    const posts: string[] = [];
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (target) => {
      posts.push(String(target));
      return new Response(null, { status: 204 });
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        worker.scheduled(createScheduledController(), {
          ...env,
          MAIL_GRANTS: JSON.stringify({
            "user:owner": { scopes: principal.scopes, fromAddresses: [] },
          }),
          WEBHOOK_ORIGINS: '["https://receiver.example.com"]',
        }),
      ).rejects.toThrow("Archive reconciliation did not complete");
      expect(posts).toEqual([url]);
      expect(errors).toHaveBeenCalledWith(
        JSON.stringify({ event: "outbound_reconcile", status: "deferred" }),
      );
      expect(errors).not.toHaveBeenCalledWith(
        JSON.stringify({ event: "event_delivery", status: "deferred" }),
      );
      expect(logs).toHaveBeenCalledWith(JSON.stringify({ event: "event_delivery", attempted: 1 }));
      expect(JSON.stringify([errors.mock.calls, logs.mock.calls])).not.toContain("example.invalid");
    } finally {
      sessions.mockRestore();
      send.mockRestore();
      errors.mockRestore();
      logs.mockRestore();
    }
  });
});
describe("webhook origin configuration", () => {
  it.each([
    '["https://receiver.example.com","https://receiver.example.com/path"]',
    '["https://receiver.example.com","http://other.example.com"]',
    '["https://receiver.example.com",1]',
    '{"origin":"https://receiver.example.com"}',
    "https://receiver.example.com",
    JSON.stringify(Array.from({ length: 11 }, () => "https://receiver.example.com")),
  ])("fails closed for events only when WEBHOOK_ORIGINS is %s", async (value) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.spyOn(globalThis, "fetch");
    try {
      const configured = eventRuntime({
        ...env,
        MAIL_GRANTS: JSON.stringify({
          "user:owner": { scopes: principal.scopes, fromAddresses: [] },
        }),
        WEBHOOK_ORIGINS: value,
      });
      expect(errors).toHaveBeenCalledWith(
        JSON.stringify({ event: "webhook_origins", status: "invalid" }),
      );
      expect(JSON.stringify(errors.mock.calls)).not.toContain("receiver.example.com");
      // No entry is trusted, including the valid-looking ones.
      await expect(configured.http.post(url, "{}", new Headers())).rejects.toThrow(
        "webhook_origins_invalid",
      );
      await expect(
        handleEventRequest(
          env.MAIL_CATALOG,
          { ...principal, id: "user:owner" },
          "events/subscribe",
          { name: "email.received", delivery: { mode: "webhook", url, secret } },
          configured,
        ),
      ).rejects.toMatchObject({ code: -32015 });
      const subscription = await subscribe();
      await append("pending");
      // Scheduled delivery leases nothing, so no subscription spends a retry on it.
      await expect(deliverEvents(env.MAIL_CATALOG, configured)).rejects.toThrow(
        "webhook_origins_invalid",
      );
      expect(
        await env.MAIL_CATALOG.prepare(
          "SELECT attempts,lease_until,lease_token FROM event_subscriptions WHERE id=?",
        )
          .bind(subscription["id"])
          .first(),
      ).toEqual({ attempts: 0, lease_until: 0, lease_token: null });
      expect(send).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      send.mockRestore();
    }
  });
  it("serves MCP requests while WEBHOOK_ORIGINS is invalid", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const keys = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(keys.publicKey);
    jwk.kid = "synthetic-events-config";
    const issuer = "https://synthetic-events.cloudflareaccess.com";
    const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (target) => {
      if (String(target) !== `${issuer}/cdn-cgi/access/certs`)
        throw new Error("Unexpected network");
      return Response.json({ keys: [jwk] });
    });
    try {
      const settings = {
        ...env,
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: "synthetic-events",
        MAIL_GRANTS: JSON.stringify({
          "user:owner": { scopes: ["mail:read", "mail:events"], fromAddresses: [] },
        }),
        WEBHOOK_ORIGINS: '["https://receiver.example.com/path"]',
      };
      const response = await handleHttp(
        new Request(`${env.API_ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "cf-access-jwt-assertion": await new SignJWT({ type: "app", sub: "owner" })
              .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
              .setIssuer(issuer)
              .setAudience(settings.ACCESS_AUDIENCE)
              .setIssuedAt()
              .setExpirationTime("5m")
              .sign(keys.privateKey),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "synthetic", version: "1" },
            },
          }),
        }),
        settings,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"result"');
    } finally {
      errors.mockRestore();
      send.mockRestore();
    }
  });
});
describe("callback egress policy", () => {
  it.each([
    "http://receiver.example.com",
    "https://user:pass@receiver.example.com",
    "https://receiver.example.com/#secret",
    "https://127.0.0.1",
    "https://[::1]",
    "https://2130706433",
    "https://localhost",
    "https://foo.local",
    "https://foo.internal",
    "https://receiver.example.com:8443",
  ])("rejects unsafe callback %s", (value) => {
    expect(() => validateCallback(value)).toThrow();
  });
  /** A fetch stand-in that applies workerd's own Request option checks, which reject
   * `redirect: "error"`, and answers the parsed request. */
  function runtimeFetch(answer: (request: Request) => Response | Promise<Response>) {
    const requests: Request[] = [];
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return answer(request);
    }) as unknown as typeof fetch;
    return { requests, send };
  }
  /** A redirect whose body records whether it was cancelled, and can refuse to cancel. */
  function redirectTo(code: number, cancelRejects = false) {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        state.cancelled = true;
        if (cancelRejects) throw new Error("synthetic cancel failure");
      },
    });
    const response = new Response(code === 304 ? null : body, {
      status: code,
      headers: { Location: "https://attacker.example.com/collect" },
    });
    return { response, state };
  }
  it("fails closed without exact admin origin and posts with the runtime's manual redirect mode", async () => {
    const { requests, send } = runtimeFetch(() => new Response(null, { status: 204 }));
    const http = createAllowlistedWebhookHttp(["https://receiver.example.com"], send);
    await expect(http.post("https://attacker.example.com", "{}", new Headers())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    const response = await http.post(url, '{"a":1}', new Headers({ "webhook-id": "synthetic" }));
    expect(response.status).toBe(204);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(url);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.redirect).toBe("manual");
    expect(requests[0]?.headers.get("webhook-id")).toBe("synthetic");
    expect(await requests[0]?.text()).toBe('{"a":1}');
    await expect(
      createAllowlistedWebhookHttp([], send).post(url, "{}", new Headers()),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it.each([300, 301, 302, 303, 304, 307, 308])(
    "refuses a %i redirect, cancels its body, and never follows it",
    async (code) => {
      const redirect = redirectTo(code);
      const { requests, send } = runtimeFetch(() => redirect.response);
      const http = createAllowlistedWebhookHttp(["https://receiver.example.com"], send);
      await expect(http.post(url, "{}", new Headers())).rejects.toThrow(
        "Callback redirect refused",
      );
      expect(requests.map((request) => request.url)).toEqual([url]);
      if (code !== 304) expect(redirect.state.cancelled).toBe(true);
    },
  );
  it("refuses a redirect even when cancelling its body fails", async () => {
    const redirect = redirectTo(302, true);
    const { send } = runtimeFetch(() => redirect.response);
    const http = createAllowlistedWebhookHttp(["https://receiver.example.com"], send);
    await expect(http.post(url, "{}", new Headers())).rejects.toThrow("Callback redirect refused");
    expect(redirect.state.cancelled).toBe(true);
  });
  it("verifies a callback through the allowlisted adapter and fails verification on a redirect", async () => {
    let redirecting = true;
    const { requests, send } = runtimeFetch(async (request) => {
      if (redirecting) return redirectTo(307).response;
      const parsed = (await request.json()) as Record<string, unknown>;
      return Response.json({ challenge: parsed["challenge"] });
    });
    runtime.http = createAllowlistedWebhookHttp(["https://receiver.example.com"], send);
    await expect(subscribe()).rejects.toMatchObject({
      code: -32015,
      data: { reason: "challenge_failed" },
    });
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM event_subscriptions").first(
        "count",
      ),
    ).toBe(0);
    redirecting = false;
    await subscribe();
    expect(requests.map((request) => [request.url, request.redirect])).toEqual([
      [url, "manual"],
      [url, "manual"],
    ]);
  });
  it("retries a redirected delivery like other non-2xx responses, without advancing the cursor", async () => {
    let redirecting = true;
    const { requests, send } = runtimeFetch(async (request) => {
      const parsed = (await request.json()) as Record<string, unknown>;
      if (parsed["type"] === "verification")
        return Response.json({ challenge: parsed["challenge"] });
      return redirecting ? redirectTo(308).response : new Response(null, { status: 204 });
    });
    runtime.http = createAllowlistedWebhookHttp(["https://receiver.example.com"], send);
    const subscription = await subscribe();
    await append("redirected");
    const started = now;
    expect(await deliverEvents(env.MAIL_CATALOG, runtime)).toEqual({ attempted: 1 });
    const row = () =>
      env.MAIL_CATALOG.prepare(
        "SELECT state,cursor,attempts,next_attempt_at,lease_token FROM event_subscriptions WHERE id=?",
      )
        .bind(subscription["id"])
        .first();
    expect(await row()).toEqual({
      state: "active",
      cursor: 0,
      attempts: 1,
      next_attempt_at: started + 1_000,
      lease_token: null,
    });
    now += 1_001;
    redirecting = false;
    await deliverEvents(env.MAIL_CATALOG, runtime);
    expect(await row()).toMatchObject({ state: "active", attempts: 0 });
    expect(requests.map((request) => request.url)).toEqual([url, url, url]);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
  });
  it("rejects malformed secrets before signing", async () => {
    await expect(signedHeaders("whsec_!", "id", "{}", "sub", now)).rejects.toThrow(
      "Invalid signing secret",
    );
  });
});
