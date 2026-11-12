import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as v from "valibot";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { dispatchMailTool, handleMcp, type McpEnvironment } from "../src/mcp.ts";
import { bridge, toolSchemas } from "../src/mcp-schemas.ts";
import type { MailPrincipal } from "../src/principal.ts";

const reader: MailPrincipal = { id: "synthetic-reader", scopes: ["mail:read"], fromAddresses: [] };
const mailer: MailPrincipal = {
  id: "synthetic-mailer",
  scopes: ["mail:read", "mail:draft", "mail:send"],
  fromAddresses: ["sender@example.invalid"],
};
const context = () => ({
  ...env,
  EMAIL: {
    send: vi.fn(async () => ({ messageId: "synthetic-provider-id" })),
  } as unknown as SendEmail,
});
async function clientFor(principal = reader, contextOverride?: McpEnvironment) {
  const contextValue = contextOverride ?? context();
  const requests: Request[] = [];
  const client = new Client({ name: "synthetic-agent", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("https://fumi.example.invalid/mcp"), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requests.push(request.clone());
      return handleMcp(request, contextValue, principal);
    },
  });
  await client.connect(transport);
  return { client, requests };
}
beforeAll(async () => {
  await applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS);
});
describe("official MCP HTTP transport", () => {
  it("negotiates the SDK protocol and executes a tool through its real client", async () => {
    const { client, requests } = await clientFor();
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("read_email");
      expect(tools.tools.map((t) => t.name)).not.toContain("send_email");
      expect(tools.tools.find((t) => t.name === "get_mail_health")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      const health = await client.callTool({ name: "get_mail_health", arguments: {} });
      expect(health.isError).not.toBe(true);
      expect(health.structuredContent).toMatchObject({ archive_completeness: "unknown" });
      expect(
        tools.tools.find((t) => t.name === "read_email")?.inputSchema["additionalProperties"],
      ).toBe(false);
      const response = await client.callTool({ name: "get_profile", arguments: {} });
      expect(response.structuredContent).toMatchObject({
        principal_id: reader.id,
        scopes: ["mail:read"],
      });
      expect(requests.some((r) => r.headers.has("MCP-Protocol-Version"))).toBe(true);
    } finally {
      await client.close();
    }
  });
  it("rejects unknown arguments and unsupported queries with closed errors", async () => {
    const { client } = await clientFor();
    try {
      const malformed = await client.callTool({
        name: "read_email",
        arguments: { message_id: "do-not-echo-secret", url: "https://do-not-fetch.invalid" },
      });
      expect(malformed.isError).toBe(true);
      expect(JSON.stringify(malformed)).not.toContain("do-not-echo-secret");
      const query = await client.callTool({
        name: "search_emails",
        arguments: { query: "newer_than:7d" },
      });
      expect(query).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "unsupported_query" } },
      });
    } finally {
      await client.close();
    }
  });
  it("does not authorize a hidden write through direct dispatch", async () => {
    await expect(
      dispatchMailTool("send_email", {}, context(), reader, "https://fumi.example.invalid"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("creates reviews and revision-patches drafts over the SDK without sending", async () => {
    const ctx = context();
    const { client } = await clientFor(mailer, ctx);
    try {
      const saved = await client.callTool({
        name: "create_draft",
        arguments: {
          from_address: mailer.fromAddresses[0],
          to: ["recipient@example.invalid"],
          subject: "Synthetic",
          payload: { text: "Synthetic content" },
        },
      });
      expect(saved.isError).not.toBe(true);
      const draft = saved.structuredContent as { draft_id: string; revision: number };
      expect(draft.revision).toBe(1);
      const updated = await client.callTool({
        name: "update_draft",
        arguments: { draft_id: draft.draft_id, expected_revision: 1, subject: "Updated" },
      });
      expect(updated.structuredContent).toMatchObject({
        revision: 2,
        input: { subject: "Updated", payload: { text: "Synthetic content" } },
      });
      const conflict = await client.callTool({
        name: "send_draft",
        arguments: {
          draft_id: draft.draft_id,
          expected_revision: 1,
          idempotency_key: "synthetic-revision-conflict",
        },
      });
      expect(conflict).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "draft_conflict" } },
      });
      expect(ctx.EMAIL.send).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("rejects cross-origin browser requests before protocol parsing", async () => {
    const response = await handleMcp(
      new Request("https://fumi.example.invalid/mcp", {
        method: "POST",
        headers: { origin: "https://untrusted.example.invalid" },
        body: "{}",
      }),
      context(),
      reader,
    );
    expect(response.status).toBe(403);
  });
  it("defaults replies to the trusted envelope recipient and honors explicit permitted overrides", async () => {
    const p = { ...mailer, fromAddresses: [], fromDomains: ["example.invalid"] };
    const id = crypto.randomUUID();
    const key = `ingest/2026-11-11/${id}/raw.eml`;
    const receipt = {
      schemaVersion: 1,
      ingestId: id,
      receivedAt: "2026-11-11T00:00:00.000Z",
      envelope: { from: "other@example.invalid", to: "captured@example.invalid" },
      reportedRawSize: 1,
      archive: { status: "stored", key, size: 1, sha256: "a".repeat(64) },
      forward: { status: "forwarded" },
    };
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO archive_sources(source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,receipt_snapshot,forward_status,raw_state,receipt_state,observed_pass,observed_revision) VALUES ('email_routing','ingress-v1',?,?,?,'2026-11-11T00:00:00.000Z',?,'forwarded','present','valid',0,0)`,
    )
      .bind(id, key, `${key}.receipt`, JSON.stringify(receipt))
      .run();
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_sha256=? WHERE external_id=?")
      .bind("a".repeat(64), id)
      .run();
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO mail_extractions(raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,attachments_json,body_json_key,manifest_key,updated_at) VALUES (?,'mime-v1',?,1,?,'complete',?,'[]',?,?,0)`,
    )
      .bind(
        key,
        "a".repeat(64),
        id,
        JSON.stringify({
          messageId: "<parent@example.invalid>",
          to: [{ address: "untrusted@example.invalid" }],
        }),
        `synthetic/body/${id}`,
        `synthetic/manifest/${id}`,
      )
      .run();
    const ctx = context();
    const { client } = await clientFor(p, ctx);
    try {
      const input = {
        to: ["recipient@example.invalid"],
        subject: "Synthetic reply",
        payload: { text: "Synthetic" },
        reply_message_id: `mail_${id}`,
      };
      const preview = await client.callTool({ name: "preview_email", arguments: input });
      expect(preview.structuredContent).toMatchObject({
        input: { from_address: "captured@example.invalid", reply_message_id: `mail_${id}` },
        submitted: false,
      });
      expect(JSON.stringify(preview)).not.toContain(key);
      const override = await client.callTool({
        name: "preview_email",
        arguments: {
          ...input,
          from_address: "override@example.invalid",
          reply_to: "responses@example.invalid",
        },
      });
      expect(override.structuredContent).toMatchObject({
        input: { from_address: "override@example.invalid", reply_to: "responses@example.invalid" },
      });
      const forbidden = await client.callTool({
        name: "preview_email",
        arguments: { ...input, from_address: "sender@sub.example.invalid" },
      });
      expect(forbidden).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "sender_forbidden" } },
      });
      const { reply_message_id: _parent, ...newMail } = input;
      expect(await client.callTool({ name: "preview_email", arguments: newMail })).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "from_address_required" } },
      });
      expect(ctx.EMAIL.send).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
  it("advertises Events on the actual initialize wire and serves protocol methods", async () => {
    const p = { ...reader, scopes: [...reader.scopes, "mail:events"] };
    const ctx = {
      ...context(),
      eventRuntime: { http: { post: vi.fn() }, authorize: async () => true },
    };
    const response = await handleMcp(
      new Request("https://fumi.example.invalid/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
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
      ctx,
      p,
    );
    const text = await response.text();
    const payload = JSON.parse(
      text.startsWith("event:") ? text.split("data: ")[1]!.split("\n")[0]! : text,
    ) as { result: { capabilities: Record<string, unknown> } };
    expect(payload.result.capabilities["events"]).toEqual({});
    const { client } = await clientFor(p, ctx);
    try {
      const events = await client.request(
        { method: "events/list", params: {} },
        v.looseObject({ events: v.array(v.looseObject({ name: v.string() })) }),
      );
      expect(events.events.map((event) => event.name)).toContain("email.received");
      expect(events.events.map((event) => event.name)).not.toContain("email.send_status_changed");
    } finally {
      await client.close();
    }
  });
  it("keeps validation and wire JSON Schema authored from the same schema", async () => {
    const schema = bridge(toolSchemas.send_email);
    const json = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    expect(json).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["to", "payload", "idempotency_key"]),
    });
    expect(await schema["~standard"].validate({ to: [], subject: "Synthetic" })).toHaveProperty(
      "issues",
    );
  });
});
