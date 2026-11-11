import { describe, expect, it, vi } from "vitest";
import {
  compileShadowRouter,
  ROUTING_LIMITS,
  RoutingConfigError,
  shadowClaimState,
} from "../src/routing.ts";

const mail = {
  subject: "お支払い確認 12345",
  from: "sender@example.invalid",
  to: "recipient@example.invalid",
  hasAttachments: true,
};
const manifest = {
  schemaVersion: 1,
  pluginId: "synthetic-owner",
  version: "1.0.0",
  protocol: "fumi-offer-v1",
  mode: "exclusive",
  inputFields: ["subject"],
  capabilities: ["offer"],
  match: 'subject.contains("確認")',
};
const origin = "https://plugin.example.invalid";
const baseConfig = {
  schemaVersion: 1,
  adoptions: [] as Record<string, unknown>[],
  rules: [
    {
      id: "synthetic-review",
      priority: 10,
      match: 'hasAttachments && subject.startsWith("お支払い") && from.endsWith(".invalid")',
      outcome: "review",
    },
  ],
  fallback: "unresolved",
};

async function hash(json: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function adopted(
  overrides: Record<string, unknown> = {},
  ownerOverrides: Record<string, unknown> = {},
) {
  const json = JSON.stringify({ ...manifest, ...ownerOverrides });
  const adoption = {
    pluginId: manifest.pluginId,
    origin,
    version: manifest.version,
    manifestSha256: await hash(json),
    enabled: true,
    priority: 1,
    inputFields: ["subject"],
    capabilities: ["offer"],
    handlerRef: "synthetic-binding",
    timeoutMs: 1000,
    onFailure: "hold",
    ...overrides,
  };
  const config = { ...baseConfig, adoptions: [adoption] };
  const published = [{ json, authenticatedOrigin: origin }];
  return {
    config,
    published,
    router: () => compileShadowRouter(JSON.stringify(config), published),
  };
}

describe("bounded shadow CEL routing in workerd", () => {
  it.each([
    'subject == "お支払い確認 12345"',
    'subject != "unrelated" && hasAttachments == true',
    "!(hasAttachments == false) && (false || true)",
    '"確認".contains("確") && subject.endsWith("12345")',
  ])("supports the declared boolean/string CEL subset %#", async (match) => {
    const router = await compileShadowRouter(
      JSON.stringify({
        ...baseConfig,
        rules: [{ id: "synthetic-subset", priority: 1, match, outcome: "review" }],
      }),
      [],
    );
    expect(router.evaluate(mail, "live").fallback).toEqual({
      outcome: "review",
      ruleId: "synthetic-subset",
    });
  });

  it("evaluates Japanese predicates and explicit pinned owner adoption without IO", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No routing network access"));
    try {
      const setup = await adopted();
      const router = await setup.router();
      const decision = router.evaluate(mail, "live");
      expect(decision).toMatchObject({
        status: "shadow",
        dispatchAllowed: false,
        candidates: [{ pluginId: manifest.pluginId, manifestVersion: "1.0.0" }],
        fallback: { outcome: "review", ruleId: "synthetic-review" },
      });
      expect(decision.configurationSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(shadowClaimState(decision, [])).toEqual({
        state: "awaiting_claim",
        pluginId: manifest.pluginId,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps fingerprints stable across config whitespace and captures config changes", async () => {
    const first = await compileShadowRouter(JSON.stringify(baseConfig), []);
    const second = await compileShadowRouter(JSON.stringify(baseConfig, null, 2), []);
    expect(first.configurationSha256).toBe(second.configurationSha256);
    const changed = await compileShadowRouter(
      JSON.stringify({ ...baseConfig, fallback: "ignore" }),
      [],
    );
    expect(changed.configurationSha256).not.toBe(first.configurationSha256);
  });

  it("honors priority and binary ID ties independently of input ordering", async () => {
    const rules = [
      { id: "z-last", priority: 2, match: "true", outcome: "ignore" },
      { id: "b-second", priority: 1, match: "true", outcome: "unresolved" },
      { id: "a-first", priority: 1, match: "true", outcome: "review" },
    ];
    const router = await compileShadowRouter(JSON.stringify({ ...baseConfig, rules }), []);
    expect(router.evaluate(mail, "live").fallback).toEqual({
      outcome: "review",
      ruleId: "a-first",
    });
  });

  it("never treats a static match as a durable owner claim or ambiguous failure as fallback", async () => {
    const router = await (await adopted()).router();
    const decision = router.evaluate(mail, "live");
    for (const result of [
      "handled",
      "not_applicable",
      "retryable_error",
      "rejected",
      "uncertain",
    ] as const) {
      expect(shadowClaimState(decision, [{ pluginId: manifest.pluginId, result }]).state).toBe(
        {
          handled: "handled",
          not_applicable: "fallback",
          retryable_error: "held",
          rejected: "held",
          uncertain: "uncertain",
        }[result],
      );
    }
    expect(
      shadowClaimState(decision, [{ pluginId: "untrusted-owner", result: "handled" }]).state,
    ).toBe("held");
  });

  it("observes owner order and lets only not_applicable advance the exclusive lane", async () => {
    const first = await adopted();
    const secondJson = JSON.stringify({ ...manifest, pluginId: "second-owner", mode: "exclusive" });
    first.config.adoptions.push({
      ...first.config.adoptions[0]!,
      pluginId: "second-owner",
      priority: 2,
      manifestSha256: await hash(secondJson),
    });
    first.published.push({ json: secondJson, authenticatedOrigin: origin });
    const router = await first.router();
    const decision = router.evaluate(mail, "live");
    expect(decision.candidates.map((candidate) => candidate.pluginId)).toEqual([
      manifest.pluginId,
      "second-owner",
    ]);
    expect(
      shadowClaimState(decision, [{ pluginId: manifest.pluginId, result: "not_applicable" }]),
    ).toEqual({ state: "awaiting_claim", pluginId: "second-owner" });
  });

  it("keeps observers out of the exclusive claim lane", async () => {
    const router = await (await adopted({}, { mode: "observer" })).router();
    const decision = router.evaluate(mail, "live");
    expect(decision.candidates[0]?.mode).toBe("observer");
    expect(shadowClaimState(decision, []).state).toBe("fallback");
  });

  it("suppresses historical mail before exposing candidates or fallback rules", async () => {
    const router = await (await adopted()).router();
    const decision = router.evaluate(mail, "historical");
    expect(decision).toMatchObject({
      status: "historical_suppressed",
      dispatchAllowed: false,
      candidates: [],
      fallback: { outcome: "unresolved", ruleId: null },
    });
    expect(shadowClaimState(decision, []).state).toBe("suppressed");
  });

  it("treats message text as data and rejects injected configuration fields", async () => {
    const router = await (await adopted()).router();
    expect(
      router.evaluate({ ...mail, subject: 'true; fetch("https://evil.invalid")' }, "live")
        .candidates,
    ).toEqual([]);
    expect(
      router.evaluate({ ...mail, handlerRef: "attacker", source: "live" }, "live").status,
    ).toBe("invalid_metadata");
    expect(
      router.evaluate({ ...mail, subject: "あ".repeat(ROUTING_LIMITS.fieldBytes) }, "live").status,
    ).toBe("invalid_metadata");
  });

  it.each([
    { version: "2.0.0" },
    { manifestSha256: "0".repeat(64) },
    { origin: "https://other.example.invalid" },
    { origin: `${origin}/path` },
    { origin: "http://plugin.example.invalid" },
    { inputFields: [] },
    { capabilities: ["send"] },
    { timeoutMs: 5001 },
    { endpoint: "https://evil.invalid" },
  ])("rejects mismatch or overgrant in explicit adoption %#", async (overrides) => {
    await expect((await adopted(overrides)).router()).rejects.toBeInstanceOf(RoutingConfigError);
  });

  it("rejects unauthenticated publisher, missing adoption bundle, and changed exact bytes", async () => {
    const setup = await adopted();
    setup.published[0]!.authenticatedOrigin = "https://untrusted.example.invalid";
    await expect(setup.router()).rejects.toThrow("Invalid routing configuration");
    await expect(compileShadowRouter(JSON.stringify(setup.config), [])).rejects.toThrow();
    setup.published[0]!.authenticatedOrigin = origin;
    setup.published[0]!.json += " ";
    await expect(setup.router()).rejects.toThrow();
  });

  it("revocation removes the plugin without loading its manifest", async () => {
    const setup = await adopted({ enabled: false });
    const router = await compileShadowRouter(JSON.stringify(setup.config), []);
    expect(router.evaluate(mail, "live").candidates).toEqual([]);
  });

  it.each([
    'subject.matches("(a+)+$")',
    "[1,2].exists(x, true)",
    'subject + "x" == "x"',
    'subject.constructor == "x"',
    "has(subject)",
    "true ? true : false",
    "subject",
    'hasAttachments.contains("x")',
    "subject == true",
    'unknown == "x"',
    "true /* comment */",
    'subject.contains("確認"',
    "!".repeat(100) + "true",
    "(".repeat(1000) + "true" + ")".repeat(1000),
    '"a"'.repeat(1000),
    Array.from({ length: 130 }, () => "true").join(" && "),
  ])("rejects unsupported or resource-intensive CEL before evaluation %#", async (match) => {
    await expect(
      compileShadowRouter(
        JSON.stringify({
          ...baseConfig,
          rules: [{ id: "invalid", priority: 1, match, outcome: "review" }],
        }),
        [],
      ),
    ).rejects.toThrow("Invalid routing configuration");
  });

  it("rejects references to a field not granted by an owner manifest", async () => {
    await expect(
      (await adopted({}, { match: 'from.contains("invalid")' })).router(),
    ).rejects.toThrow();
  });

  it("bounds malformed config and aggregate work", async () => {
    await expect(
      compileShadowRouter("{".repeat(ROUTING_LIMITS.configBytes + 1), []),
    ).rejects.toThrow();
    await expect(compileShadowRouter("{}", [])).rejects.toThrow();
    const rules = Array.from({ length: 33 }, (_, index) => ({
      id: `rule-${index}`,
      priority: 1,
      match: "true",
      outcome: "review",
    }));
    await expect(
      compileShadowRouter(JSON.stringify({ ...baseConfig, rules }), []),
    ).rejects.toThrow();
    const duplicate = { ...baseConfig, rules: [baseConfig.rules[0], baseConfig.rules[0]] };
    await expect(compileShadowRouter(JSON.stringify(duplicate), [])).rejects.toThrow();
  });

  it("repeated worst-sized allowed strings remain deterministic under the fixed operation budget", async () => {
    const rules = Array.from({ length: ROUTING_LIMITS.rules }, (_, index) => ({
      id: `rule-${index}`,
      priority: index,
      match: 'subject.contains("見つからない")',
      outcome: "review",
    }));
    const router = await compileShadowRouter(JSON.stringify({ ...baseConfig, rules }), []);
    const largeMail = { ...mail, subject: "a".repeat(ROUTING_LIMITS.fieldBytes) };
    for (let index = 0; index < 100; index++) {
      expect(router.evaluate(largeMail, "live")).toMatchObject({
        status: "shadow",
        dispatchAllowed: false,
        fallback: { outcome: "unresolved", ruleId: null },
      });
    }
  });
});
