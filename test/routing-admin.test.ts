import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleRoutingAdmin } from "../src/routing-admin-http.ts";
import { handleHttp } from "../src/http.ts";
import { routingRuntime } from "../src/routing-runtime.ts";

beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
const operator = { id: "synthetic-operator", scopes: ["mail:routing"], fromAddresses: [] };
const reader = { ...operator, scopes: ["mail:read"] };
const request = (action: string, method = "POST", body?: BodyInit) =>
  new Request(`https://mail.example.invalid/api/admin/routing/${action}`, {
    method,
    ...(body === undefined ? {} : { body }),
  });
describe("authenticated routing controls", () => {
  it("keeps every operation behind the dedicated operator grant", async () => {
    for (const action of ["activate", "drain", "reconcile", "receipt", "retry/mail_synthetic"]) {
      // oxlint-disable-next-line no-await-in-loop -- Verify the authorization boundary for each independent control.
      expect((await handleRoutingAdmin(request(action), env, reader)).status).toBe(403);
    }
  });
  it("accepts empty network POST streams but rejects input, query scope and incorrect methods", async () => {
    const empty = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    expect((await handleRoutingAdmin(request("drain", "POST", empty), env, operator)).status).toBe(
      200,
    );
    expect((await handleRoutingAdmin(request("drain", "POST", "x"), env, operator)).status).toBe(
      400,
    );
    expect(
      (await handleRoutingAdmin(request("activate?destination=mail"), env, operator)).status,
    ).toBe(400);
    expect((await handleRoutingAdmin(request("activate", "GET"), env, operator)).status).toBe(405);
    expect(await (await handleRoutingAdmin(request("activate"), env, operator)).json()).toEqual({
      status: "disabled",
    });
  });
  it("rejects malformed receipt evidence and missing retry sources", async () => {
    const receipt = new Request(request("receipt"), {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result: "handled", url: "https://untrusted.invalid" }),
    });
    expect((await handleRoutingAdmin(receipt, env, operator)).status).toBe(400);
    expect((await handleRoutingAdmin(request("retry/mail_missing"), env, operator)).status).toBe(
      404,
    );
  });
  it("mounts the same-origin and JWT guard before administrator handlers", async () => {
    expect((await handleHttp(request("drain"), env)).status).toBe(401);
    const cross = new Request(request("drain"), {
      headers: { origin: "https://untrusted.invalid" },
    });
    expect((await handleHttp(cross, env)).status).toBe(403);
  });
  it("connects unresolved classification to a disabled-by-default policy", async () => {
    const source = {
      rawKey: "synthetic",
      rawSha256: "a".repeat(64),
      manifestKey: "synthetic",
      extractionUpdatedAt: 1,
      receivedAt: null,
      metadata: {
        subject: "Synthetic",
        from: "sender@example.invalid",
        to: "receiver@example.invalid",
        hasAttachments: false,
      },
      metadataJson: "{}",
      bodyJsonKey: "synthetic",
      bodyTextKey: null,
      envelope: null,
    };
    const runtime = routingRuntime(env);
    expect(await runtime.resolveFallback!(source, {} as never)).toMatchObject({
      outcome: "hold",
      evidenceCode: "policy_not_configured",
    });
    expect(
      await runtime.gateNotification!(
        source,
        { outcome: "review", category: null, urgent: false, evidenceCode: "synthetic" },
        "operation",
      ),
    ).toEqual({ outcome: "hold", evidenceCode: "source_changed" });
  });
});
