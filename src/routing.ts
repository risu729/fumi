import { CelScalar, celEnv, parse, plan } from "@bufbuild/cel";
import * as v from "valibot";

export const ROUTING_VERSION = "shadow-cel-v1";
export const ROUTING_LIMITS = {
  configBytes: 64 * 1024,
  manifestBytes: 8 * 1024,
  expressionBytes: 2048,
  expressionDepth: 16,
  expressionNodes: 128,
  plugins: 16,
  rules: 32,
  fieldBytes: 4096,
} as const;

const fieldSchema = v.picklist(["subject", "from", "to", "hasAttachments"]);
type Field = v.InferOutput<typeof fieldSchema>;
const idSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const versionSchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/));
const fieldsSchema = v.pipe(v.array(fieldSchema), v.maxLength(4));
const offerFieldsSchema = v.pipe(
  v.array(v.picklist(["subject", "from", "to", "hasAttachments", "envelope", "text"])),
  v.maxLength(6),
);
const prioritySchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1000));
const matchSchema = v.pipe(v.string(), v.maxLength(ROUTING_LIMITS.expressionBytes));
const outcomeSchema = v.picklist(["review", "ignore", "unresolved"]);
type Outcome = v.InferOutput<typeof outcomeSchema>;
const manifestSchema = v.strictObject({
  schemaVersion: v.literal(1),
  pluginId: idSchema,
  version: versionSchema,
  protocol: v.literal("fumi-offer-v1"),
  mode: v.picklist(["exclusive", "observer"]),
  inputFields: fieldsSchema,
  offerInputFields: v.optional(offerFieldsSchema),
  capabilities: v.tuple([v.literal("offer")]),
  match: matchSchema,
});
const adoptionSchema = v.strictObject({
  pluginId: idSchema,
  origin: v.pipe(v.string(), v.maxLength(256)),
  version: versionSchema,
  manifestSha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  enabled: v.boolean(),
  priority: prioritySchema,
  inputFields: fieldsSchema,
  offerInputFields: v.optional(offerFieldsSchema),
  capabilities: v.tuple([v.literal("offer")]),
  handlerRef: idSchema,
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5000)),
  onFailure: v.literal("hold"),
});
const ruleSchema = v.strictObject({
  id: idSchema,
  priority: prioritySchema,
  match: matchSchema,
  outcome: outcomeSchema,
  category: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/))),
  urgent: v.optional(v.boolean()),
});
const configSchema = v.strictObject({
  schemaVersion: v.literal(1),
  adoptions: v.pipe(v.array(adoptionSchema), v.maxLength(ROUTING_LIMITS.plugins)),
  rules: v.pipe(v.array(ruleSchema), v.maxLength(ROUTING_LIMITS.rules)),
  fallback: outcomeSchema,
});
const metadataSchema = v.strictObject({
  subject: v.string(),
  from: v.string(),
  to: v.string(),
  hasAttachments: v.boolean(),
});
export type RoutingMetadata = v.InferOutput<typeof metadataSchema>;
type Expr = ReturnType<typeof parse>["expr"];
type ValueType = "string" | "bool";
const encoder = new TextEncoder();
const fieldTypes: Record<Field, ValueType> = {
  subject: "string",
  from: "string",
  to: "string",
  hasAttachments: "bool",
};

export class RoutingConfigError extends Error {
  constructor() {
    // Neither expressions nor private configuration are included in diagnostics.
    super("Invalid routing configuration");
  }
}

function boundedJson(json: string, maxBytes: number): unknown {
  if (json.length > maxBytes || encoder.encode(json).byteLength > maxBytes)
    throw new RoutingConfigError();
  return JSON.parse(json) as unknown;
}

async function digest(bytes: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(bytes))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new RoutingConfigError();
}

function order(a: { priority: number; id: string }, b: { priority: number; id: string }) {
  return a.priority - b.priority || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1);
}

// A deliberately restricted CEL token alphabet bounds parser recursion before parsing.
// Strings are JSON-style double quoted literals; comments, escapes other than JSON,
// collections, selectors, macros, numeric operations and regular expressions are excluded.
function preflight(expression: string) {
  if (
    expression.length > ROUTING_LIMITS.expressionBytes ||
    encoder.encode(expression).byteLength > ROUTING_LIMITS.expressionBytes
  )
    throw new RoutingConfigError();
  let offset = 0;
  let depth = 0;
  let count = 0;
  const token =
    /\s+|"(?:[^"\\\p{Cc}]|\\["\\/bfnrt]|\\u[a-fA-F0-9]{4})*"|[a-zA-Z][a-zA-Z0-9]*|&&|\|\||==|!=|[!().,]/uy;
  while (offset < expression.length) {
    token.lastIndex = offset;
    const match = token.exec(expression);
    if (!match) throw new RoutingConfigError();
    const value = match[0];
    offset = token.lastIndex;
    if (/^\s+$/.test(value)) continue;
    if (
      /^[a-zA-Z]/.test(value) &&
      ![
        "subject",
        "from",
        "to",
        "hasAttachments",
        "true",
        "false",
        "contains",
        "startsWith",
        "endsWith",
      ].includes(value)
    )
      throw new RoutingConfigError();
    count++;
    if (count > ROUTING_LIMITS.expressionNodes * 3) throw new RoutingConfigError();
    if (value === "(") depth++;
    if (value === ")") depth--;
    if (depth < 0 || depth > ROUTING_LIMITS.expressionDepth) throw new RoutingConfigError();
    // Long unary chains recurse independently of parentheses in CEL parsers.
    if (value === "!" && /^\s*!/.test(expression.slice(offset))) throw new RoutingConfigError();
  }
  if (depth !== 0) throw new RoutingConfigError();
}

function compilePredicate(expression: string, allowed: readonly Field[]) {
  preflight(expression);
  const ast = parse(expression);
  let count = 0;
  function check(expr: Expr, depth: number): ValueType {
    count++;
    if (count > ROUTING_LIMITS.expressionNodes || depth > ROUTING_LIMITS.expressionDepth)
      throw new RoutingConfigError();
    const node = expr.exprKind;
    if (node.case === "constExpr") {
      if (node.value.constantKind.case === "boolValue") return "bool";
      if (node.value.constantKind.case === "stringValue") return "string";
    }
    if (node.case === "identExpr") {
      const name = node.value.name;
      if (!allowed.some((field) => field === name)) throw new RoutingConfigError();
      return fieldTypes[name as Field];
    }
    if (node.case === "callExpr") {
      const call = node.value;
      const args = call.args;
      if (!call.target && (call.function === "_&&_" || call.function === "_||_")) {
        if (args.length < 2 || args.some((arg) => check(arg, depth + 1) !== "bool"))
          throw new RoutingConfigError();
        return "bool";
      }
      if (
        !call.target &&
        call.function === "!_" &&
        args.length === 1 &&
        args[0] &&
        check(args[0], depth + 1) === "bool"
      )
        return "bool";
      if (
        !call.target &&
        (call.function === "_==_" || call.function === "_!=_") &&
        args.length === 2 &&
        args[0] &&
        args[1] &&
        check(args[0], depth + 1) === check(args[1], depth + 1)
      )
        return "bool";
      if (
        call.target &&
        ["contains", "startsWith", "endsWith"].includes(call.function) &&
        args.length === 1 &&
        args[0] &&
        check(call.target, depth + 1) === "string" &&
        check(args[0], depth + 1) === "string"
      )
        return "bool";
    }
    throw new RoutingConfigError();
  }
  if (check(ast.expr, 0) !== "bool") throw new RoutingConfigError();
  const evaluate = plan(
    celEnv({
      variables: {
        subject: CelScalar.STRING,
        from: CelScalar.STRING,
        to: CelScalar.STRING,
        hasAttachments: CelScalar.BOOL,
      },
    }),
    ast,
  );
  return (mail: RoutingMetadata) => {
    // Build a separate activation: withheld fields and any prototype properties
    // are never exposed to the interpreter, even when the caller has more data.
    const activation = Object.fromEntries(allowed.map((field) => [field, mail[field]]));
    const result = evaluate(activation as RoutingMetadata);
    if (typeof result !== "boolean") throw new RoutingConfigError();
    return result;
  };
}

export interface PublishedManifest {
  json: string;
  // Supplied only after the caller authenticates the distribution channel.
  // This API does not fetch, authenticate, or trust an origin from mail content.
  authenticatedOrigin: string;
}

export interface ShadowCandidate {
  pluginId: string;
  manifestVersion: string;
  manifestSha256: string;
  mode: "exclusive" | "observer";
}

export interface ShadowDecision {
  version: typeof ROUTING_VERSION;
  configurationSha256: string;
  dispatchAllowed: false;
  status: "shadow" | "historical_suppressed" | "invalid_metadata" | "evaluation_error";
  candidates: ShadowCandidate[];
  fallback: {
    outcome: Outcome;
    ruleId: string | null;
    category?: string;
    urgent?: boolean;
  };
}

export interface ShadowRouter {
  configurationSha256: string;
  evaluate(metadata: unknown, provenance: "live" | "historical"): ShadowDecision;
}

/** Compile trusted administrator configuration; invalid adoption fails closed. */
export async function compileShadowRouter(
  configJson: string,
  published: PublishedManifest[],
): Promise<ShadowRouter> {
  try {
    const config = v.parse(configSchema, boundedJson(configJson, ROUTING_LIMITS.configBytes));
    if (published.length > ROUTING_LIMITS.plugins) throw new RoutingConfigError();
    unique(config.adoptions.map((adoption) => adoption.pluginId));
    unique(config.rules.map((rule) => rule.id));
    const bundles = new Map<
      string,
      {
        manifest: v.InferOutput<typeof manifestSchema>;
        json: string;
        origin: string;
        sha256: string;
      }
    >();
    for (const bundle of published) {
      const manifest = v.parse(
        manifestSchema,
        boundedJson(bundle.json, ROUTING_LIMITS.manifestBytes),
      );
      if (bundles.has(manifest.pluginId)) throw new RoutingConfigError();
      bundles.set(manifest.pluginId, {
        manifest,
        json: bundle.json,
        origin: bundle.authenticatedOrigin,
        sha256: "",
      });
    }
    await Promise.all(
      Array.from(bundles.values(), async (bundle) => {
        bundle.sha256 = await digest(bundle.json);
      }),
    );
    const plugins: {
      id: string;
      priority: number;
      candidate: ShadowCandidate;
      matches: (mail: RoutingMetadata) => boolean;
    }[] = [];
    for (const adoption of config.adoptions) {
      unique(adoption.inputFields);
      const origin = new URL(adoption.origin);
      if (origin.protocol !== "https:" || origin.origin !== adoption.origin)
        throw new RoutingConfigError();
      if (!adoption.enabled) continue;
      const bundle = bundles.get(adoption.pluginId);
      if (
        !bundle ||
        bundle.origin !== adoption.origin ||
        bundle.manifest.version !== adoption.version ||
        bundle.sha256 !== adoption.manifestSha256
      )
        throw new RoutingConfigError();
      const manifest = bundle.manifest;
      unique(manifest.inputFields);
      const requestedOffer = manifest.offerInputFields ?? manifest.inputFields;
      const grantedOffer = adoption.offerInputFields ?? adoption.inputFields;
      unique(requestedOffer);
      unique(grantedOffer);
      if (requestedOffer.some((field) => !grantedOffer.some((allowed) => allowed === field)))
        throw new RoutingConfigError();
      if (manifest.inputFields.some((field) => !adoption.inputFields.includes(field)))
        throw new RoutingConfigError();
      plugins.push({
        id: adoption.pluginId,
        priority: adoption.priority,
        candidate: {
          pluginId: adoption.pluginId,
          manifestVersion: adoption.version,
          manifestSha256: adoption.manifestSha256,
          mode: manifest.mode,
        },
        matches: compilePredicate(manifest.match, manifest.inputFields),
      });
    }
    plugins.sort(order);
    if (
      config.rules.some(
        (rule) =>
          rule.outcome !== "review" && (rule.category !== undefined || rule.urgent !== undefined),
      )
    )
      throw new RoutingConfigError();
    const rules = config.rules
      .map((rule) => ({
        ...rule,
        matches: compilePredicate(rule.match, ["subject", "from", "to", "hasAttachments"]),
      }))
      .sort(order);
    // Include the evaluator version and deterministic parsed configuration. The
    // pinned manifest digests include owner rule bytes; whitespace in config is immaterial.
    const configurationSha256 = await digest(JSON.stringify({ version: ROUTING_VERSION, config }));
    return Object.freeze({
      configurationSha256,
      evaluate(metadata: unknown, provenance: "live" | "historical"): ShadowDecision {
        const decision: ShadowDecision = {
          version: ROUTING_VERSION,
          configurationSha256,
          dispatchAllowed: false,
          status: "shadow",
          candidates: [],
          fallback: { outcome: config.fallback, ruleId: null },
        };
        if (provenance === "historical") return { ...decision, status: "historical_suppressed" };
        if (provenance !== "live") return { ...decision, status: "invalid_metadata" };
        const parsed = v.safeParse(metadataSchema, metadata);
        if (
          !parsed.success ||
          [parsed.output.subject, parsed.output.from, parsed.output.to].some(
            (value) =>
              value.length > ROUTING_LIMITS.fieldBytes ||
              encoder.encode(value).byteLength > ROUTING_LIMITS.fieldBytes,
          )
        )
          return { ...decision, status: "invalid_metadata" };
        try {
          decision.candidates = plugins
            .filter((plugin) => plugin.matches(parsed.output))
            .map((plugin) => ({ ...plugin.candidate }));
          const rule = rules.find((item) => item.matches(parsed.output));
          if (rule)
            decision.fallback = {
              outcome: rule.outcome,
              ruleId: rule.id,
              ...(rule.category !== undefined ? { category: rule.category } : {}),
              ...(rule.urgent !== undefined ? { urgent: rule.urgent } : {}),
            };
          return decision;
        } catch {
          return { ...decision, status: "evaluation_error", candidates: [] };
        }
      },
    });
  } catch {
    throw new RoutingConfigError();
  }
}

/** Validate an owner publication without granting adoption or invoking its handler. */
export function validateRoutingManifest(json: string) {
  try {
    const manifest = v.parse(manifestSchema, boundedJson(json, ROUTING_LIMITS.manifestBytes));
    unique(manifest.inputFields);
    unique(manifest.offerInputFields ?? manifest.inputFields);
    compilePredicate(manifest.match, manifest.inputFields);
    return manifest;
  } catch {
    throw new RoutingConfigError();
  }
}

/** Describe exclusive claim precedence without invoking a handler or dispatching. */
export function shadowClaimState(
  decision: ShadowDecision,
  results: readonly {
    pluginId: string;
    result: "handled" | "not_applicable" | "retryable_error" | "rejected" | "uncertain";
  }[],
): {
  state: "suppressed" | "awaiting_claim" | "handled" | "held" | "uncertain" | "fallback";
  pluginId?: string;
} {
  if (decision.status !== "shadow") return { state: "suppressed" };
  let index = 0;
  for (const candidate of decision.candidates) {
    if (candidate.mode !== "exclusive") continue;
    const receipt = results[index];
    if (!receipt) return { state: "awaiting_claim", pluginId: candidate.pluginId };
    if (receipt.pluginId !== candidate.pluginId) return { state: "held" };
    index++;
    if (receipt.result === "handled") return { state: "handled", pluginId: candidate.pluginId };
    if (receipt.result === "uncertain") return { state: "uncertain", pluginId: candidate.pluginId };
    if (receipt.result !== "not_applicable") return { state: "held", pluginId: candidate.pluginId };
  }
  return results.length === index ? { state: "fallback" } : { state: "held" };
}
