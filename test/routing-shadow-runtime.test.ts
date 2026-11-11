import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  repairRoutingShadow,
  ROUTING_CONFIG_KEY,
  SHADOW_REPAIR_LIMIT,
} from "../src/routing-shadow-runtime.ts";

const config = {
  schemaVersion: 1,
  adoptions: [],
  rules: [
    { id: "synthetic-review", priority: 1, match: 'subject.contains("確認")', outcome: "review" },
  ],
  fallback: "unresolved",
};
const metadata = {
  subject: "合成の確認",
  from: { name: "Synthetic", address: "sender@example.invalid" },
  to: [{ address: "recipient@example.invalid" }],
  messageId: "synthetic-message",
};

async function configure(
  value: unknown = { schemaVersion: 1, configJson: JSON.stringify(config), manifests: [] },
) {
  await env.MAIL_ARCHIVE.put(ROUTING_CONFIG_KEY, JSON.stringify(value));
}

async function source(index: number, notify = 1, json = JSON.stringify(metadata)) {
  const id = `synthetic-${String(index).padStart(4, "0")}`;
  const rawKey = `ingest/2026-11-11/${id}/raw.eml`;
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare(`INSERT INTO archive_sources (
      source_kind,source_namespace,external_id,raw_key,receipt_key,raw_state,receipt_state,
      raw_sha256,observed_pass,observed_revision,notify_events)
      VALUES ('email_routing','ingress-v1',?,?,?,'present','missing',?,0,0,?)`).bind(
      id,
      rawKey,
      `${rawKey}.receipt`,
      "a".repeat(64),
      notify,
    ),
    env.MAIL_CATALOG.prepare(`INSERT INTO mail_extractions (
      raw_key,extractor_version,raw_sha256,raw_size,instance_id,status,metadata_json,
      attachments_json,body_json_key,manifest_key,updated_at)
      VALUES (?,'mime-v1',?,100,?,'complete',?,'[]',?,?,1)`).bind(
      rawKey,
      "a".repeat(64),
      id,
      json,
      `${rawKey}.body`,
      `${rawKey}.manifest`,
    ),
  ]);
  return rawKey;
}

async function decisions() {
  return (
    await env.MAIL_CATALOG.prepare("SELECT * FROM routing_shadow_decisions ORDER BY raw_key").all<{
      raw_key: string;
      configuration_sha256: string;
      state: string;
      failure_code: string | null;
      decision_json: string | null;
      notify_events: number;
    }>()
  ).results;
}

beforeAll(async () => applyD1Migrations(env.MAIL_CATALOG, env.TEST_MIGRATIONS));
beforeEach(async () => {
  await env.MAIL_ARCHIVE.delete(ROUTING_CONFIG_KEY);
  await env.MAIL_CATALOG.batch([
    env.MAIL_CATALOG.prepare("DELETE FROM routing_shadow_decisions"),
    env.MAIL_CATALOG.prepare("DELETE FROM routing_shadow_scan"),
    env.MAIL_CATALOG.prepare("DELETE FROM mail_extractions"),
    env.MAIL_CATALOG.prepare("DELETE FROM archive_sources"),
  ]);
});

describe("scheduled private routing shadow persistence in workerd", () => {
  it("is disabled without the fixed administrator artifact and makes no network requests", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No routing network requests"));
    try {
      await source(1);
      expect(await repairRoutingShadow(env)).toMatchObject({ status: "disabled", examined: 0 });
      expect(await decisions()).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("durably records only symbolic shadow decisions and is idempotent", async () => {
    await configure();
    await source(1);
    const eventsBefore = await env.MAIL_CATALOG.prepare(
      "SELECT COUNT(*) AS count FROM mail_events",
    ).first<{ count: number }>();
    expect(await repairRoutingShadow(env)).toEqual({
      status: "complete",
      examined: 1,
      written: 1,
      blocked: 0,
      failed: 0,
    });
    const rows = await decisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("complete");
    expect(JSON.parse(rows[0]!.decision_json!)).toMatchObject({
      status: "shadow",
      dispatchAllowed: false,
      fallback: { outcome: "review", ruleId: "synthetic-review" },
    });
    expect(rows[0]?.decision_json).not.toContain("sender@example.invalid");
    expect((await repairRoutingShadow(env)).examined).toBe(0);
    expect(
      await env.MAIL_CATALOG.prepare("SELECT COUNT(*) AS count FROM mail_events").first(),
    ).toEqual(eventsBefore);
  });

  it("suppresses a trusted historical source even when mail claims to be live", async () => {
    await configure();
    await source(1, 0, JSON.stringify({ ...metadata, source: "live", notify_events: 1 }));
    expect((await repairRoutingShadow(env)).written).toBe(1);
    expect(JSON.parse((await decisions())[0]!.decision_json!)).toMatchObject({
      status: "historical_suppressed",
      dispatchAllowed: false,
      candidates: [],
      fallback: { outcome: "unresolved", ruleId: null },
    });
  });

  it("consumes the pinned administrator-owned manifest artifact without calling an owner", async () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      pluginId: "synthetic-owner",
      version: "1.0.0",
      protocol: "fumi-offer-v1",
      mode: "exclusive",
      inputFields: ["subject"],
      capabilities: ["offer"],
      match: 'subject.contains("確認")',
    });
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const ownerOrigin = "https://owner.example.invalid";
    await configure({
      schemaVersion: 1,
      configJson: JSON.stringify({
        ...config,
        adoptions: [
          {
            pluginId: "synthetic-owner",
            origin: ownerOrigin,
            version: "1.0.0",
            manifestSha256: digest,
            enabled: true,
            priority: 1,
            inputFields: ["subject"],
            capabilities: ["offer"],
            handlerRef: "synthetic-binding",
            timeoutMs: 1000,
            onFailure: "hold",
          },
        ],
      }),
      manifests: [{ json, authenticatedOrigin: ownerOrigin }],
    });
    await source(1);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No owner requests"));
    try {
      expect((await repairRoutingShadow(env)).written).toBe(1);
      expect(JSON.parse((await decisions())[0]!.decision_json!)).toMatchObject({
        dispatchAllowed: false,
        candidates: [
          { pluginId: "synthetic-owner", manifestVersion: "1.0.0", manifestSha256: digest },
        ],
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("holds malformed and oversized metadata without starving later messages", async () => {
    await configure();
    await source(1, 1, "{");
    await source(2, 1, " ".repeat(32 * 1024 + 1));
    await source(3);
    expect(await repairRoutingShadow(env)).toMatchObject({ examined: 3, written: 3, blocked: 2 });
    const rows = await decisions();
    expect(rows.map((row) => row.state)).toEqual(["blocked", "blocked", "complete"]);
    expect(rows.slice(0, 2).map((row) => row.failure_code)).toEqual([
      "invalid_metadata",
      "invalid_metadata",
    ]);
    expect((await repairRoutingShadow(env)).examined).toBe(0);
  });

  it("rejects invalid, oversized and action-bearing configuration instead of evaluating", async () => {
    await source(1);
    for (const artifact of [
      {},
      {
        schemaVersion: 1,
        configJson: JSON.stringify({ ...config, dispatch: true }),
        manifests: [],
      },
      {
        schemaVersion: 1,
        configJson: JSON.stringify(config),
        manifests: [],
        destination: "https://evil.invalid",
      },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each case replaces the same private configuration object.
      await configure(artifact);
      // oxlint-disable-next-line no-await-in-loop -- Evaluate the replacement before overwriting it with the next case.
      expect((await repairRoutingShadow(env)).status).toBe("invalid_config");
    }
    await env.MAIL_ARCHIVE.put(ROUTING_CONFIG_KEY, "a".repeat(256 * 1024 + 1));
    expect((await repairRoutingShadow(env)).status).toBe("invalid_config");
    expect(await decisions()).toHaveLength(0);
  });

  it("limits each scheduled batch and converges over subsequent runs", async () => {
    await configure();
    await Promise.all(Array.from({ length: SHADOW_REPAIR_LIMIT + 2 }, (_, index) => source(index)));
    expect(await repairRoutingShadow(env)).toMatchObject({
      examined: SHADOW_REPAIR_LIMIT,
      written: SHADOW_REPAIR_LIMIT,
    });
    expect(await repairRoutingShadow(env)).toMatchObject({ examined: 2, written: 2 });
    expect((await decisions()).length).toBe(SHADOW_REPAIR_LIMIT + 2);
  });

  it("recomputes changed extraction/provenance and keeps configuration versions separate", async () => {
    await configure();
    const key = await source(1);
    await repairRoutingShadow(env);
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET notify_events=0 WHERE raw_key=?")
      .bind(key)
      .run();
    expect((await repairRoutingShadow(env)).written).toBe(1);
    expect(JSON.parse((await decisions())[0]!.decision_json!).status).toBe("historical_suppressed");
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET notify_events=1 WHERE raw_key=?")
      .bind(key)
      .run();
    await env.MAIL_CATALOG.prepare(
      "UPDATE mail_extractions SET metadata_json=?,updated_at=2 WHERE raw_key=?",
    )
      .bind(JSON.stringify({ ...metadata, subject: "Synthetic ordinary" }), key)
      .run();
    expect((await repairRoutingShadow(env)).written).toBe(1);
    expect(JSON.parse((await decisions())[0]!.decision_json!).fallback.outcome).toBe("unresolved");
    await configure({
      schemaVersion: 1,
      configJson: JSON.stringify({ ...config, fallback: "ignore" }),
      manifests: [],
    });
    expect((await repairRoutingShadow(env)).written).toBe(1);
    expect(await decisions()).toHaveLength(2);
  });

  it("records source mismatch and retries after catalog identity is repaired", async () => {
    await configure();
    const key = await source(1);
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_sha256=? WHERE raw_key=?")
      .bind("b".repeat(64), key)
      .run();
    expect((await repairRoutingShadow(env)).blocked).toBe(1);
    expect((await decisions())[0]?.failure_code).toBe("source_changed");
    await env.MAIL_CATALOG.prepare("UPDATE archive_sources SET raw_sha256=? WHERE raw_key=?")
      .bind("a".repeat(64), key)
      .run();
    expect((await repairRoutingShadow(env)).written).toBe(1);
    expect((await decisions())[0]?.state).toBe("complete");
  });

  it("advances the cursor after a transient poison-row write failure and retries after wrap", async () => {
    await configure();
    const poison = await source(0);
    await Promise.all(
      Array.from({ length: SHADOW_REPAIR_LIMIT + 1 }, (_, index) => source(index + 1)),
    );
    const session = env.MAIL_CATALOG.withSession("first-primary");
    let failing = true;
    const fakeSession = {
      prepare(sql: string) {
        const statement = session.prepare(sql);
        if (!sql.startsWith("INSERT INTO routing_shadow_decisions")) return statement;
        return {
          bind(...values: (string | number | null)[]) {
            const bound = statement.bind(...values);
            return {
              run() {
                if (failing && values[0] === poison)
                  return Promise.reject(new Error("Synthetic transient write failure"));
                return bound.run();
              },
            };
          },
        };
      },
    } as unknown as D1DatabaseSession;
    const wrapped = {
      MAIL_ARCHIVE: env.MAIL_ARCHIVE,
      MAIL_CATALOG: { withSession: () => fakeSession } as unknown as D1Database,
    };
    expect(await repairRoutingShadow(wrapped)).toMatchObject({
      status: "partial",
      failed: 1,
      written: 4,
    });
    expect((await repairRoutingShadow(wrapped)).written).toBe(2);
    expect(await decisions()).toHaveLength(SHADOW_REPAIR_LIMIT + 1);
    failing = false;
    expect((await repairRoutingShadow(wrapped)).written).toBe(1);
    expect(await decisions()).toHaveLength(SHADOW_REPAIR_LIMIT + 2);
  });

  it("fences a concurrent provenance change and retries using the new historical state", async () => {
    await configure();
    const key = await source(1);
    const session = env.MAIL_CATALOG.withSession("first-primary");
    const fakeSession = {
      prepare(sql: string) {
        const statement = session.prepare(sql);
        if (!sql.startsWith("INSERT INTO routing_shadow_decisions")) return statement;
        return {
          bind(...values: (string | number | null)[]) {
            const bound = statement.bind(...values);
            return {
              async run() {
                await env.MAIL_CATALOG.prepare(
                  "UPDATE archive_sources SET notify_events=0 WHERE raw_key=?",
                )
                  .bind(key)
                  .run();
                return bound.run();
              },
            };
          },
        };
      },
    } as unknown as D1DatabaseSession;
    const wrapped = {
      MAIL_ARCHIVE: env.MAIL_ARCHIVE,
      MAIL_CATALOG: { withSession: () => fakeSession } as unknown as D1Database,
    };
    expect((await repairRoutingShadow(wrapped)).written).toBe(0);
    expect(await decisions()).toHaveLength(0);
    expect((await repairRoutingShadow(env)).written).toBe(1);
    expect(JSON.parse((await decisions())[0]!.decision_json!).status).toBe("historical_suppressed");
  });
});
