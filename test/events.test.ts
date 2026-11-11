import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
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
import type { MailPrincipal } from "../src/principal.ts";

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
  it("fails closed without exact admin origin and disables redirects", async () => {
    const send = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const http = createAllowlistedWebhookHttp(["https://receiver.example.com"], send);
    await expect(http.post("https://attacker.example.com", "{}", new Headers())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    await http.post(url, "{}", new Headers());
    expect(send).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ redirect: "error", method: "POST" }),
    );
    await expect(
      createAllowlistedWebhookHttp([], send).post(url, "{}", new Headers()),
    ).rejects.toThrow();
  });
  it("rejects malformed secrets before signing", async () => {
    await expect(signedHeaders("whsec_!", "id", "{}", "sub", now)).rejects.toThrow(
      "Invalid signing secret",
    );
  });
});
