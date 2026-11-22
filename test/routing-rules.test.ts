import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as v from "valibot";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchMailTool, handleMcp } from "../src/mcp.ts";
import { toolOutputSchemas, toolSchemas } from "../src/mcp-schemas.ts";
import type { MailPrincipal } from "../src/principal.ts";
import { ROUTING_CONFIG_KEY, repairRoutingShadow } from "../src/routing-shadow-runtime.ts";
import { DISPATCH_CONFIG_KEY } from "../src/routing-dispatch-config.ts";
import { dispatchDigest } from "../src/plugin-offer.ts";
import { compileShadowRouter } from "../src/routing.ts";
import {
  explainRouting,
  listRoutingRules,
  routingRuleUsage,
  USAGE_SQL,
} from "../src/routing-rules.ts";

// Synthetic rules only. The marker stands in for a private address in a rule body.
const SECRET = "rule-secret-marker@example.invalid";
const candidateConfig = {
  schemaVersion: 1,
  adoptions: [],
  rules: [
    { id: "synthetic-stale", priority: 30, match: `from == "${SECRET}"`, outcome: "ignore" },
    {
      id: "synthetic-alpha",
      priority: 10,
      match: 'subject.contains("alpha")',
      outcome: "review",
      category: "notice",
      urgent: false,
    },
    { id: "synthetic-beta", priority: 20, match: 'subject.contains("beta")', outcome: "ignore" },
  ],
  fallback: "unresolved",
};
const activeConfig = {
  ...candidateConfig,
  rules: [
    { ...candidateConfig.rules[1], match: 'subject.contains("alpha") || hasAttachments' },
    candidateConfig.rules[2],
    { id: "synthetic-retired", priority: 40, match: "false", outcome: "review" },
  ],
};
const routingPrincipal: MailPrincipal = {
  id: "service:synthetic-operator",
  scopes: ["mail:routing"],
  fromAddresses: [],
};
const reader: MailPrincipal = {
  id: "service:synthetic-reader",
  scopes: ["mail:read", "mail:draft", "mail:send", "mail:events", "mail:import"],
  fromAddresses: ["sender@example.invalid"],
};
const BASE = "https://fumi.example.invalid";
const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const ROUTING_TOOLS = ["list_routing_rules", "routing_rule_usage", "explain_routing"] as const;

async function configureCandidate(config: unknown = candidateConfig) {
  await env.MAIL_ARCHIVE.put(
    ROUTING_CONFIG_KEY,
    JSON.stringify({ schemaVersion: 1, configJson: JSON.stringify(config), manifests: [] }),
  );
}
async function configureActive(config: unknown = activeConfig, activate = true) {
  const artifact = {
    schemaVersion: 1,
    revision: 3,
    generation: 1,
    enabled: true,
    routing: { configJson: JSON.stringify(config), manifests: [] },
    destination: null,
    owners: [],
  };
  await env.MAIL_ARCHIVE.put(DISPATCH_CONFIG_KEY, JSON.stringify(artifact));
  if (activate)
    await env.MAIL_CATALOG.prepare(
      `INSERT INTO routing_dispatch_control(id,revision,generation,configuration_sha256,destination_sha256,accepting,paused)
      VALUES (1,3,1,?,?,1,0)`,
    )
      .bind(await dispatchDigest(JSON.stringify(artifact)), await dispatchDigest("null"))
      .run();
}
const routerHash = async (config: unknown) =>
  (await compileShadowRouter(JSON.stringify(config), [])).configurationSha256;

let serial = 0;
async function source(
  day: string,
  subject: string,
  options: { notify?: number; hour?: string; from?: string } = {},
) {
  serial++;
  const id = `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
  const rawKey = `ingest/${day}/${id}/raw.eml`;
  const metadata = {
    subject,
    from: { address: options.from ?? "sender@example.invalid" },
    to: [{ address: "recipient@example.invalid" }],
  };
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (
      source_kind,source_namespace,external_id,raw_key,receipt_key,received_at,raw_state,receipt_state,
      raw_sha256,observed_pass,observed_revision,notify_events)
      VALUES ('email_routing','ingress-v1',?,?,?,?,'present','missing',?,0,0,?)`).bind(
      id,
      rawKey,
      `${rawKey}.receipt`,
      `${day}T${options.hour ?? "09"}:00:00.000Z`,
      "a".repeat(64),
      options.notify ?? 1,
    ),
    env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions (
      raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,
      attachments_json,body_json_key,manifest_key,updated_at)
      VALUES (?,'mime-v1',?,100,?,'complete',?,'[]',?,?,1)`).bind(
      rawKey,
      "a".repeat(64),
      id,
      JSON.stringify(metadata),
      `${rawKey}.body`,
      `${rawKey}.manifest`,
    ),
  ]);
  return { rawKey, messageId: `mail_${id}` };
}
async function evaluateAll() {
  for (let i = 0; i < 20; i++) {
    // oxlint-disable-next-line no-await-in-loop -- Each bounded repair pass evaluates five sources.
    const result = await repairRoutingShadow(env);
    if (result.examined === 0) return;
  }
}
const day = (offset: number, from = NOW) =>
  new Date(from - offset * 86_400_000).toISOString().slice(0, 10);
const usage = (input: Partial<Parameters<typeof routingRuleUsage>[1]> = {}, now = NOW) =>
  routingRuleUsage(
    env,
    {
      configuration: "candidate",
      window_days: 30,
      max_decisions: 2000,
      samples_per_rule: 3,
      ...input,
    },
    now,
  );

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_ARCHIVE.delete([ROUTING_CONFIG_KEY, DISPATCH_CONFIG_KEY]);
  await env.MAIL_CATALOG.batch(
    [
      "routing_shadow_decisions",
      "routing_shadow_scan",
      "routing_classifications",
      "routing_dispatch_outbox",
      "routing_dispatch_jobs",
      "routing_dispatch_control",
      "mail_extractions",
      "archive_sources",
    ].map((table) => env.MAIL_CATALOG.prepare(`DELETE FROM ${table}`)),
  );
});
const logs: unknown[][] = [];
beforeEach(() => {
  logs.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
});
afterEach(() => {
  vi.restoreAllMocks();
  // Rule bodies, addresses and expressions never reach logs.
  expect(JSON.stringify(logs)).not.toContain(SECRET);
  expect(JSON.stringify(logs)).not.toContain("subject.contains");
});

describe("routing rule tools authorization", () => {
  it("are hidden and denied without mail:routing, whatever other scopes are granted", async () => {
    for (const name of ROUTING_TOOLS)
      // oxlint-disable-next-line no-await-in-loop -- Each tool is checked independently.
      await expect(
        dispatchMailTool(
          name,
          name === "explain_routing" ? { message_id: "mail_x" } : {},
          env as never,
          reader,
          BASE,
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    const names = await toolNames(reader);
    for (const name of ROUTING_TOOLS) expect(names).not.toContain(name);
  });

  it("are listed as read-only tools for a mail:routing principal", async () => {
    await configureCandidate();
    const client = await clientFor(routingPrincipal);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ROUTING_TOOLS)
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        });
      // The operator scope grants no mail tool.
      expect(tools.map((tool) => tool.name)).not.toContain("read_email");
      const listed = await client.callTool({ name: "list_routing_rules", arguments: {} });
      expect(listed.isError).not.toBe(true);
      expect(listed.structuredContent).toMatchObject({ candidate: { status: "configured" } });
      const unknown = await client.callTool({
        name: "routing_rule_usage",
        arguments: { window_days: 91 },
      });
      expect(unknown).toMatchObject({ isError: true });
      const extra = await client.callTool({
        name: "list_routing_rules",
        arguments: { key: "config/other.json" },
      });
      expect(extra).toMatchObject({ isError: true });
    } finally {
      await client.close();
    }
  });
});

async function clientFor(principal: MailPrincipal) {
  const client = new Client({ name: "synthetic-operator", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      fetch: async (url, init) =>
        handleMcp(new Request(url, init), { ...env, EMAIL: {} as SendEmail }, principal),
    }),
  );
  return client;
}
async function toolNames(principal: MailPrincipal) {
  const client = await clientFor(principal);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("list_routing_rules", () => {
  it("reports absent configuration without inventing rules", async () => {
    const listed = await listRoutingRules(env);
    expect(listed.candidate).toMatchObject({ status: "absent", rules: [], fallback: null });
    expect(listed.active).toMatchObject({ status: "absent", revision: null, activated: null });
    expect(listed.same_configuration).toBe(false);
    expect(listed.history.available).toBe(false);
  });

  it("lists candidate and active rules in evaluation order with hashes and revision", async () => {
    await configureCandidate();
    await configureActive();
    const listed = await listRoutingRules(env);
    expect(v.is(toolOutputSchemas.list_routing_rules, listed)).toBe(true);
    expect(listed.candidate.configuration_sha256).toBe(await routerHash(candidateConfig));
    expect(listed.active.configuration_sha256).toBe(await routerHash(activeConfig));
    expect(listed.candidate.uploaded_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(listed.candidate.rules.map((rule) => [rule.id, rule.compared_to_other])).toEqual([
      ["synthetic-alpha", "changed"],
      ["synthetic-beta", "same"],
      ["synthetic-stale", "only_here"],
    ]);
    expect(listed.candidate.rules[0]).toEqual({
      id: "synthetic-alpha",
      priority: 10,
      match: 'subject.contains("alpha")',
      outcome: "review",
      category: "notice",
      urgent: false,
      added_at: null,
      changed_at: null,
      compared_to_other: "changed",
    });
    expect(listed.active).toMatchObject({
      status: "configured",
      revision: 3,
      generation: 1,
      enabled: true,
      activated: true,
    });
    expect(listed.active.rules.map((rule) => rule.id)).toEqual([
      "synthetic-alpha",
      "synthetic-beta",
      "synthetic-retired",
    ]);
    // The dispatch artifact's destination and owner adapters are never returned.
    expect(Object.keys(listed.active)).not.toContain("destination");
  });

  it("does not report an artifact as activated before the control row accepts it", async () => {
    await configureActive(activeConfig, false);
    expect((await listRoutingRules(env)).active.activated).toBe(false);
  });

  it("reports unreadable configuration without echoing it", async () => {
    await env.MAIL_ARCHIVE.put(ROUTING_CONFIG_KEY, `{"configJson": "${SECRET}"`);
    const listed = await listRoutingRules(env);
    expect(listed.candidate).toMatchObject({ status: "unreadable", configuration_sha256: null });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });
});

describe("routing_rule_usage", () => {
  it("counts matches per rule over a UTC-day window with times, samples and unmatched rules", async () => {
    await configureCandidate();
    const today = await source(day(0), "alpha today", { hour: "08" });
    const later = await source(day(0), "alpha later", { hour: "11" });
    const tenDays = await source(day(10), "alpha old");
    await source(day(5), "beta notice");
    await source(day(40), "beta outside");
    await source(day(1), "neither");
    await source(day(1), "alpha historical", { notify: 0 });
    await evaluateAll();

    const report = await usage({ samples_per_rule: 2 });
    expect(v.is(toolOutputSchemas.routing_rule_usage, report)).toBe(true);
    expect(report.window).toEqual({
      days: 30,
      start: `${day(29)}T00:00:00.000Z`,
      end: new Date(NOW).toISOString(),
    });
    expect(report.decisions).toMatchObject({
      scanned: 5,
      truncated: false,
      default_outcome: "unresolved",
      default_matches: 1,
      unmatched_rule_ids: ["synthetic-stale"],
      unmatched_covers_window: true,
      oldest_scanned_received_at: `${day(10)}T09:00:00.000Z`,
    });
    expect(report.decisions.rules).toEqual([
      {
        rule_id: "synthetic-alpha",
        matches: 3,
        first_matched_at: `${day(10)}T09:00:00.000Z`,
        last_matched_at: `${day(0)}T11:00:00.000Z`,
        sample_message_ids: [later.messageId, today.messageId],
      },
      {
        rule_id: "synthetic-beta",
        matches: 1,
        first_matched_at: `${day(5)}T09:00:00.000Z`,
        last_matched_at: `${day(5)}T09:00:00.000Z`,
        sample_message_ids: [expect.stringMatching(/^mail_/)],
      },
      {
        rule_id: "synthetic-stale",
        matches: 0,
        first_matched_at: null,
        last_matched_at: null,
        sample_message_ids: [],
      },
    ]);
    expect(report.decisions.rules[0]?.sample_message_ids).not.toContain(tenDays.messageId);

    const wide = await usage({ window_days: 60, samples_per_rule: 0 });
    expect(wide.decisions.rules.find((rule) => rule.rule_id === "synthetic-beta")).toMatchObject({
      matches: 2,
      first_matched_at: `${day(40)}T09:00:00.000Z`,
      sample_message_ids: [],
    });
    const narrow = await usage({ window_days: 1 });
    expect(narrow.decisions.rules.map((rule) => rule.matches)).toEqual([2, 0, 0]);
    expect(narrow.decisions.unmatched_rule_ids).toEqual(["synthetic-beta", "synthetic-stale"]);
  });

  it("reports truncation at the row cap, scanning the newest days first", async () => {
    await configureCandidate();
    await source(day(0), "alpha newest");
    await source(day(2), "beta middle");
    await source(day(4), "alpha oldest");
    await evaluateAll();
    const report = await usage({ max_decisions: 2 });
    expect(report.decisions).toMatchObject({
      max_rows: 2,
      scanned: 2,
      truncated: true,
      oldest_scanned_received_at: `${day(2)}T09:00:00.000Z`,
      unmatched_covers_window: false,
    });
    expect(report.decisions.rules.map((rule) => rule.matches)).toEqual([1, 1, 0]);
  });

  it("separates configurations by SHA-256 and counts nothing for an unevaluated one", async () => {
    await configureCandidate();
    await configureActive();
    await source(day(0), "alpha");
    await evaluateAll();
    const active = await usage({ configuration: "active" });
    expect(active).toMatchObject({
      configuration: "active",
      status: "configured",
      configuration_sha256: await routerHash(activeConfig),
      decisions: { scanned: 0, unmatched_covers_window: true },
    });
    expect(active.decisions.unmatched_rule_ids).toEqual([
      "synthetic-alpha",
      "synthetic-beta",
      "synthetic-retired",
    ]);
  });

  it("counts blocked decisions, plugin candidates, classifier outcomes and dispatch states", async () => {
    await configureCandidate();
    const hash = await routerHash(candidateConfig);
    const a = await source(day(0), "one");
    const b = await source(day(1), "two");
    const c = await source(day(2), "three");
    const insert = (rawKey: string, state: string, failure: string | null, decision: unknown) =>
      env.MAIL_CATALOG.prepare(`INSERT INTO routing_shadow_decisions(raw_key,configuration_sha256,source_sha256,
        catalog_sha256,extraction_updated_at,source_kind,notify_events,state,failure_code,decision_json,updated_at)
        VALUES (?,?,?,?,1,'email_routing',1,?,?,?,?)`).bind(
        rawKey,
        hash,
        "a".repeat(64),
        "a".repeat(64),
        state,
        failure,
        decision === null ? null : JSON.stringify(decision),
        NOW,
      );
    const decision = (ruleId: string | null, candidates: unknown[] = []) => ({
      version: "shadow-cel-v1",
      configurationSha256: hash,
      dispatchAllowed: false,
      status: "shadow",
      candidates,
      fallback: { outcome: ruleId ? "review" : "unresolved", ruleId },
    });
    const classification = (
      rawKey: string,
      state: string,
      failure: string | null,
      result: unknown,
    ) =>
      env.MAIL_CATALOG.prepare(`INSERT INTO routing_classifications(raw_key,policy_sha256,source_sha256,
        manifest_key,state,result_json,failure_code,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(
        rawKey,
        "b".repeat(64),
        "a".repeat(64),
        `${rawKey}.manifest`,
        state,
        JSON.stringify(result),
        failure,
        NOW,
      );
    await env.MAIL_CATALOG.batch([
      insert(
        a.rawKey,
        "complete",
        null,
        decision(null, [
          {
            pluginId: "synthetic-owner",
            manifestVersion: "1.0.0",
            manifestSha256: "c".repeat(64),
            mode: "exclusive",
          },
        ]),
      ),
      insert(b.rawKey, "blocked", "invalid_metadata", null),
      insert(c.rawKey, "complete", null, { injected: SECRET }),
      classification(a.rawKey, "complete", null, {
        outcome: "review",
        category: "billing",
        urgent: false,
        evidenceCode: "model_action_required",
      }),
      classification(b.rawKey, "complete", null, {
        outcome: "review",
        category: "billing",
        urgent: true,
        evidenceCode: "model_action_required",
      }),
      classification(c.rawKey, "held", "model_invalid_or_unavailable", {
        outcome: "hold",
        category: null,
        urgent: false,
        evidenceCode: "model_invalid_or_unavailable",
      }),
      env.MAIL_CATALOG.prepare(`INSERT INTO routing_dispatch_jobs(raw_key,source_sha256,extraction_updated_at,
        revision,state,failure_code,updated_at) VALUES (?,?,1,3,'held','notification_not_configured',?),
        (?,?,1,3,'complete',NULL,?)`).bind(
        a.rawKey,
        "a".repeat(64),
        NOW,
        b.rawKey,
        "a".repeat(64),
        NOW,
      ),
      offer(b.rawKey, "owner:synthetic-owner", "handled", { input: { subject: SECRET } }),
    ]);
    const report = await usage();
    expect(report.decisions).toMatchObject({
      scanned: 3,
      default_matches: 1,
      unreadable: 1,
      not_evaluated: [{ failure_code: "invalid_metadata", status: null, count: 1 }],
      plugin_candidates: [{ plugin_id: "synthetic-owner", mode: "exclusive", count: 1 }],
    });
    expect(report.classifier).toMatchObject({
      scanned: 3,
      truncated: false,
      outcomes: [
        {
          state: "complete",
          outcome: "review",
          category: "billing",
          evidence_code: "model_action_required",
          count: 2,
        },
        {
          state: "held",
          outcome: "hold",
          category: null,
          evidence_code: "model_invalid_or_unavailable",
          count: 1,
        },
      ],
    });
    expect(report.dispatch).toMatchObject({
      scanned_jobs: 2,
      jobs: [
        { state: "complete", reason: null, count: 1 },
        { state: "held", reason: "notification_not_configured", count: 1 },
      ],
      offers: [{ lane: "owner:synthetic-owner", state: "handled", count: 1 }],
    });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    const capped = await usage({ max_decisions: 1 });
    expect(capped.classifier).toMatchObject({ scanned: 1, truncated: true });
    expect(capped.dispatch).toMatchObject({ scanned_jobs: 1, jobs_truncated: true });
  });

  it("returns a schema-valid report through MCP with the default window", async () => {
    await configureCandidate();
    await source(day(0, Date.now()), "alpha now");
    await evaluateAll();
    const result = await dispatchMailTool(
      "routing_rule_usage",
      {},
      env as never,
      routingPrincipal,
      BASE,
    );
    expect(v.is(toolOutputSchemas.routing_rule_usage, result)).toBe(true);
    expect(result).toMatchObject({ window: { days: 30 }, decisions: { max_rows: 2000 } });
    expect(v.parse(toolSchemas.routing_rule_usage, {})).toEqual({
      configuration: "candidate",
      window_days: 30,
      max_decisions: 2000,
      samples_per_rule: 3,
    });
  });

  it("scans every source through an index range without a sort", async () => {
    for (const [name, sql] of Object.entries(USAGE_SQL)) {
      // oxlint-disable-next-line no-await-in-loop -- One plan per query.
      const rows = await env.MAIL_CATALOG.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...(name === "decisions" ? ["a", "b", "c", 1] : ["a", "b", 1]))
        .all<{ detail: string }>();
      const plan = rows.results.map((row) => row.detail);
      expect(plan[0], name).toMatch(
        /^SEARCH \S+ USING (COVERING )?INDEX \S+ \(raw_key>\? AND raw_key<\?\)$/,
      );
      expect(plan.join("\n"), name).not.toMatch(/TEMP B-TREE|SCAN/);
    }
  });
});

function offer(rawKey: string, lane: string, state: string, payload: unknown) {
  return env.MAIL_CATALOG.prepare(`INSERT INTO routing_dispatch_outbox(operation_id,raw_key,lane,revision,
    generation,source_sha256,extraction_updated_at,manifest_key,target_id,adapter_json,payload_json,
    request_sha256,grant_fields_json,state,created_at,updated_at)
    VALUES (?,?,?,3,1,?,1,?,'synthetic-target','{}',?,?,'[]',?,?,?)`).bind(
    crypto.randomUUID(),
    rawKey,
    lane,
    "a".repeat(64),
    `${rawKey}.manifest`,
    JSON.stringify(payload),
    "d".repeat(64),
    state,
    NOW,
    NOW,
  );
}

describe("explain_routing", () => {
  it("rejects unknown and malformed message IDs with closed errors", async () => {
    await expect(explainRouting(env, "mail_missing")).rejects.toMatchObject({
      code: "message_not_found",
    });
    await expect(
      dispatchMailTool(
        "explain_routing",
        { message_id: "sent_x" },
        env as never,
        routingPrincipal,
        BASE,
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("reports not_evaluated for a message without stored decisions", async () => {
    const message = await source(day(0), "alpha");
    const explained = await explainRouting(env, message.messageId);
    expect(v.is(toolOutputSchemas.explain_routing, explained)).toBe(true);
    expect(explained).toMatchObject({
      provenance: "live",
      decided_by: { kind: "not_evaluated", source: null },
      shadow: [],
      dispatch: { job: null, offers: [] },
      classifications: [],
    });
  });

  it("explains a shadow-only decision with the deciding rule and configuration", async () => {
    await configureCandidate();
    const message = await source(day(0), "beta");
    const historical = await source(day(0), "alpha", { notify: 0 });
    await evaluateAll();
    const explained = await explainRouting(env, message.messageId);
    expect(v.is(toolOutputSchemas.explain_routing, explained)).toBe(true);
    const hash = await routerHash(candidateConfig);
    expect(explained.decided_by).toEqual({
      kind: "rule",
      source: "shadow",
      plugin_id: null,
      rule_id: "synthetic-beta",
      outcome: "ignore",
      category: null,
      evidence_code: null,
      configuration_sha256: hash,
      revision: null,
    });
    expect(explained.shadow).toEqual([
      expect.objectContaining({
        configuration: "candidate",
        current: true,
        rule_id: "synthetic-beta",
      }),
    ]);
    expect((await explainRouting(env, historical.messageId)).decided_by).toMatchObject({
      kind: "suppressed",
      evidence_code: "historical_suppressed",
    });
    // A changed extraction makes the stored decision stale rather than current.
    await env.MAIL_CATALOG.prepare("UPDATE mail_extractions SET updated_at=2 WHERE raw_key=?")
      .bind(message.rawKey)
      .run();
    const stale = await explainRouting(env, message.messageId);
    expect(stale.shadow[0]?.current).toBe(false);
    expect(stale.decided_by.kind).toBe("not_evaluated");
  });

  it("does not treat a decision as current once the catalog no longer matches its extraction", async () => {
    await configureCandidate();
    const replaced = await source(day(0), "beta replaced");
    const missing = await source(day(0), "beta missing");
    await evaluateAll();
    for (const message of [replaced, missing])
      // oxlint-disable-next-line no-await-in-loop -- Each message is checked independently.
      expect((await explainRouting(env, message.messageId)).decided_by.kind).toBe("rule");
    // A replaced raw object or a missing one leaves the old extraction behind; it is
    // no longer the current extraction, as for read_email.
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_sha256=? WHERE raw_key=?").bind(
        "e".repeat(64),
        replaced.rawKey,
      ),
      env.MAIL_CATALOG.prepare(
        "UPDATE archive_sources SET raw_state='missing' WHERE raw_key=?",
      ).bind(missing.rawKey),
    ]);
    for (const message of [replaced, missing]) {
      // oxlint-disable-next-line no-await-in-loop -- Each message is checked independently.
      const explained = await explainRouting(env, message.messageId);
      expect(v.is(toolOutputSchemas.explain_routing, explained)).toBe(true);
      expect(explained.shadow[0]?.current).toBe(false);
      expect(explained.decided_by).toMatchObject({ kind: "not_evaluated", rule_id: null });
    }
  });

  it("attributes a live static-rule decision to a rule only under the active configuration", async () => {
    await configureActive();
    // The shadow evaluates the same configuration as dispatch, so hashes agree.
    await configureCandidate(activeConfig);
    const message = await source(day(0), "alpha");
    await evaluateAll();
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare(`INSERT INTO routing_dispatch_jobs(raw_key,source_sha256,extraction_updated_at,
        revision,state,failure_code,updated_at) VALUES (?,?,1,3,'complete',NULL,?)`).bind(
        message.rawKey,
        "a".repeat(64),
        NOW,
      ),
      offer(message.rawKey, "action", "accepted", {
        input: {},
        classification: {
          outcome: "review",
          category: "notice",
          urgent: false,
          evidenceCode: "static_rule",
        },
      }),
    ]);
    const explained = await explainRouting(env, message.messageId);
    expect(v.is(toolOutputSchemas.explain_routing, explained)).toBe(true);
    expect(explained.decided_by).toEqual({
      kind: "rule",
      source: "dispatch",
      plugin_id: null,
      rule_id: "synthetic-alpha",
      outcome: "review",
      category: "notice",
      evidence_code: "static_rule",
      configuration_sha256: await routerHash(activeConfig),
      revision: 3,
    });
    expect(explained.shadow[0]?.configuration).toBe("candidate_and_active");
    expect(explained.dispatch.offers).toEqual([
      expect.objectContaining({
        lane: "action",
        state: "accepted",
        category: "notice",
        urgent: false,
      }),
    ]);

    // A re-extracted source is re-evaluated by the shadow before dispatch re-runs:
    // the current shadow row then describes other metadata than the job decided on.
    await env.MAIL_CATALOG.prepare("UPDATE mail_extractions SET updated_at=2 WHERE raw_key=?")
      .bind(message.rawKey)
      .run();
    await evaluateAll();
    const pending = await explainRouting(env, message.messageId);
    expect(pending.shadow[0]).toMatchObject({ current: true, rule_id: "synthetic-alpha" });
    expect(pending.decided_by).toMatchObject({
      kind: "rule_or_default",
      rule_id: null,
      configuration_sha256: null,
      revision: 3,
    });
    await env.MAIL_CATALOG.prepare(
      "UPDATE routing_dispatch_jobs SET extraction_updated_at=2",
    ).run();
    expect((await explainRouting(env, message.messageId)).decided_by).toMatchObject({
      kind: "rule",
      rule_id: "synthetic-alpha",
    });

    // A job decided under another revision gets no rule attribution.
    await env.MAIL_CATALOG.prepare("UPDATE routing_dispatch_jobs SET revision=2").run();
    expect((await explainRouting(env, message.messageId)).decided_by).toMatchObject({
      kind: "rule_or_default",
      rule_id: null,
      revision: 2,
    });
  });

  it("explains plugin claims and classifier outcomes without returning granted mail input", async () => {
    const owned = await source(day(0), "owned");
    const classified = await source(day(0), "classified");
    await env.MAIL_CATALOG.batch([
      env.MAIL_CATALOG.prepare(`INSERT INTO routing_dispatch_jobs(raw_key,source_sha256,extraction_updated_at,
        revision,state,failure_code,updated_at) VALUES (?,?,1,3,'complete',NULL,?),(?,?,1,3,'ignored','model_policy_exclusion',?)`).bind(
        owned.rawKey,
        "a".repeat(64),
        NOW,
        classified.rawKey,
        "a".repeat(64),
        NOW,
      ),
      offer(owned.rawKey, "owner:synthetic-owner", "handled", {
        input: { subject: SECRET, text: SECRET },
      }),
      env.MAIL_CATALOG.prepare(`INSERT INTO routing_classifications(raw_key,policy_sha256,source_sha256,
        manifest_key,state,result_json,updated_at) VALUES (?,?,?,?,'complete',?,?)`).bind(
        classified.rawKey,
        "b".repeat(64),
        "a".repeat(64),
        `${classified.rawKey}.manifest`,
        JSON.stringify({
          outcome: "ignore",
          category: null,
          urgent: false,
          evidenceCode: "model_policy_exclusion",
        }),
        NOW,
      ),
    ]);
    const plugin = await explainRouting(env, owned.messageId);
    expect(plugin.decided_by).toMatchObject({
      kind: "plugin",
      plugin_id: "synthetic-owner",
      source: "dispatch",
    });
    expect(JSON.stringify(plugin)).not.toContain(SECRET);
    const model = await dispatchMailTool(
      "explain_routing",
      { message_id: classified.messageId },
      env as never,
      routingPrincipal,
      BASE,
    );
    expect(v.is(toolOutputSchemas.explain_routing, model)).toBe(true);
    expect(model).toMatchObject({
      decided_by: {
        kind: "classifier",
        outcome: "ignore",
        evidence_code: "model_policy_exclusion",
      },
      classifications: [{ state: "complete", outcome: "ignore", category: null }],
    });
  });
});
