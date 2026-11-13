import { describe, expect, it } from "vitest";
import { signedHeaders } from "../src/event-delivery.ts";
import {
  handleReceiver,
  type DeliveryRecord,
  type DeliveryStore,
} from "../tools/events-receiver/receiver.ts";
import { parseSecrets } from "../tools/events-receiver/verify.ts";

const first = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(1)))}`;
const second = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(2)))}`;
const other = `whsec_${btoa(String.fromCharCode(...new Uint8Array(32).fill(3)))}`;
const token = "t".repeat(40);
const config = { SIGNING_SECRETS: JSON.stringify([first, second]), READ_TOKEN: token };
const now = Date.UTC(2026, 10, 13, 6, 0, 0);
const url = "https://receiver.example.invalid/events";

function memoryStore(): DeliveryStore & { records: DeliveryRecord[] } {
  const records: DeliveryRecord[] = [];
  return {
    records,
    record: async (record) => {
      records.push(record);
    },
    list: async () => records,
  };
}
async function post(body: string, headers: Headers, store: DeliveryStore, at = now) {
  return handleReceiver(new Request(url, { method: "POST", body, headers }), config, store, at);
}
function eventBody(eventId: string) {
  return JSON.stringify({
    eventId,
    name: "email.send_status_changed",
    timestamp: new Date(now).toISOString(),
    data: { operationId: "synthetic-operation", status: "accepted" },
    cursor: "sub_synthetic:1",
  });
}

describe("temporary MCP Events receiver", () => {
  it("answers callback verification signed by fumi", async () => {
    const store = memoryStore();
    const body = JSON.stringify({ type: "verification", challenge: "synthetic-challenge" });
    const headers = await signedHeaders(second, "verification_1", body, "sub_synthetic", now);
    const response = await post(body, headers, store);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "synthetic-challenge" });
    expect(store.records).toEqual([
      expect.objectContaining({
        eventId: "verification_1",
        kind: "verification",
        presented: 1,
        matchedKeys: [1],
        accepted: true,
      }),
    ]);
  });

  it("records which keys signed a single and a rotation delivery", async () => {
    const store = memoryStore();
    const body = eventBody("send:op:accepted");
    const single = await signedHeaders(first, "send:op:accepted", body, "sub_synthetic", now);
    expect((await post(body, single, store)).status).toBe(204);
    // Mirror deliverOne: the new-key signature first, then the previous key.
    const rotated = await signedHeaders(second, "send:op:accepted", body, "sub_synthetic", now);
    const previous = await signedHeaders(first, "send:op:accepted", body, "sub_synthetic", now);
    rotated.set(
      "webhook-signature",
      `${rotated.get("webhook-signature")} ${previous.get("webhook-signature")}`,
    );
    expect((await post(body, rotated, store)).status).toBe(204);
    expect(store.records.map((r) => [r.name, r.presented, r.matchedKeys, r.accepted])).toEqual([
      ["email.send_status_changed", 1, [0], true],
      ["email.send_status_changed", 2, [0, 1], true],
    ]);
    expect(JSON.stringify(store.records)).not.toContain("synthetic-operation");
  });

  it("rejects unknown keys, stale timestamps and mismatched event IDs", async () => {
    const store = memoryStore();
    const body = eventBody("received:a");
    const wrong = await signedHeaders(other, "received:a", body, "sub_synthetic", now);
    expect((await post(body, wrong, store)).status).toBe(401);
    const stale = await signedHeaders(first, "received:a", body, "sub_synthetic", now - 600_000);
    expect((await post(body, stale, store)).status).toBe(401);
    const mismatch = await signedHeaders(first, "received:b", body, "sub_synthetic", now);
    expect((await post(body, mismatch, store)).status).toBe(400);
    expect(store.records.map((r) => [r.accepted, r.matchedKeys])).toEqual([
      [false, []],
      [false, []],
    ]);
  });

  it("bounds the body and protects results with the read token", async () => {
    const store = memoryStore();
    const big = "x".repeat(262_145);
    const headers = await signedHeaders(first, "received:a", big, "sub_synthetic", now);
    expect((await post(big, headers, store)).status).toBe(413);
    const read = (authorization?: string) =>
      handleReceiver(
        new Request("https://receiver.example.invalid/results", {
          headers: authorization ? { Authorization: authorization } : {},
        }),
        config,
        store,
        now,
      );
    expect((await read()).status).toBe(401);
    expect((await read("Bearer wrong")).status).toBe(401);
    const response = await read(`Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deliveries: [] });
  });

  it("requires one or two valid configured secrets", () => {
    expect(parseSecrets(JSON.stringify([first]))).toEqual([first]);
    expect(() => parseSecrets("[]")).toThrow();
    expect(() => parseSecrets(JSON.stringify([first, second, other]))).toThrow();
    expect(() => parseSecrets(JSON.stringify(["whsec_short"]))).toThrow();
  });
});
