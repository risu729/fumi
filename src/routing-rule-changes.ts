import * as v from "valibot";
import { isValidRoutingRuleMatch, ROUTING_LIMITS, type RoutingRule } from "./routing.ts";
import {
  loadShadowConfiguration,
  parseShadowArtifact,
  ROUTING_CONFIG_KEY,
  ShadowConfigurationUnavailableError,
} from "./routing-shadow-runtime.ts";
import { readDispatchBytes } from "./plugin-offer.ts";
import type { MailPrincipal } from "./principal.ts";

/**
 * Rule changes over MCP write only the candidate: the shadow artifact
 * `config/routing-shadow-v1.json`, which produces shadow decisions and never
 * dispatches. Activation reads the separate dispatch artifact and stays an
 * administrator action outside MCP.
 *
 * Every change is a full new artifact, checked by the same validator as the
 * scheduled reader (`parseShadowArtifact`), and committed with an R2 conditional
 * write on the etag that was read. Each committed change also writes an immutable
 * revision record; the candidate's custom metadata names the record. Errors are
 * fixed codes with a key path. Rule text is never logged.
 */
export const RULE_REVISION_PREFIX = "config/routing-shadow-revisions/";
const ARTIFACT_BYTES = 256 * 1024;
// The record embeds the artifact as a JSON string, whose escaping can double it.
const REVISION_BYTES = 1024 * 1024;
const uuid = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const ruleId = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const time = v.pipe(v.string(), v.isoTimestamp());
const operationSchema = v.picklist(["propose", "update", "retire"]);
const revisionSchema = v.strictObject({
  schemaVersion: v.literal(1),
  revisionId: uuid,
  previousRevisionId: v.nullable(uuid),
  previousConfigurationSha256: sha256,
  configurationSha256: sha256,
  operation: operationSchema,
  ruleId,
  principalId: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  createdAt: time,
  // When each rule of this revision was added and last changed, carried forward
  // from the previous record. null: the change happened outside these tools.
  ruleTimes: v.pipe(
    v.array(v.strictObject({ id: ruleId, addedAt: v.nullable(time), changedAt: v.nullable(time) })),
    v.maxLength(ROUTING_LIMITS.rules),
  ),
  // The exact committed artifact, so earlier rule sets can be compared or restored.
  artifactJson: v.pipe(v.string(), v.maxLength(ARTIFACT_BYTES)),
});
export type RuleRevision = v.InferOutput<typeof revisionSchema>;
export type RuleChangeOperation = v.InferOutput<typeof operationSchema>;

export type RuleChangeCode =
  | "invalid_arguments"
  | "configuration_absent"
  | "configuration_unreadable"
  | "configuration_unavailable"
  | "configuration_conflict"
  | "configuration_too_large"
  | "configuration_invalid"
  | "rule_id_exists"
  | "rule_not_found"
  | "rule_unchanged"
  | "rule_limit_exceeded"
  | "rule_match_invalid"
  | "rule_category_not_allowed";

/** A fixed code and the key path of the input it concerns, never a value. */
export class RuleChangeError extends Error {
  readonly code: RuleChangeCode;
  readonly path: string | null;
  constructor(code: RuleChangeCode, path: string | null = null) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

type RuleFields = Omit<RoutingRule, "id">;
export type RuleChange =
  | { operation: "propose"; expectedSha256: string; rule: RoutingRule }
  | { operation: "update"; expectedSha256: string; ruleId: string; rule: RuleFields }
  | { operation: "retire"; expectedSha256: string; ruleId: string };

/** Read the committed revision record the candidate names. Any mismatch or
 * failure means no history, never a guessed one. */
export async function readRuleRevision(
  bucket: R2Bucket,
  metadata: Record<string, string>,
  configurationSha256: string,
): Promise<RuleRevision | null> {
  const id = metadata["revision_id"];
  if (!id || !v.is(uuid, id)) return null;
  try {
    const object = await bucket.get(`${RULE_REVISION_PREFIX}${id}.json`);
    if (!object) return null;
    if (object.size > REVISION_BYTES) {
      await object.body.cancel();
      return null;
    }
    const parsed = v.safeParse(
      revisionSchema,
      JSON.parse(await readDispatchBytes(object.body, REVISION_BYTES, 5000)) as unknown,
    );
    if (
      !parsed.success ||
      parsed.output.revisionId !== id ||
      parsed.output.configurationSha256 !== configurationSha256
    )
      return null;
    return parsed.output;
  } catch {
    return null;
  }
}

function normalized(rule: RoutingRule): RoutingRule {
  return {
    id: rule.id,
    priority: rule.priority,
    match: rule.match,
    outcome: rule.outcome,
    ...(rule.category !== undefined ? { category: rule.category } : {}),
    ...(rule.urgent !== undefined ? { urgent: rule.urgent } : {}),
  };
}

function checkRule(rule: RoutingRule) {
  if (rule.outcome !== "review") {
    if (rule.category !== undefined)
      throw new RuleChangeError("rule_category_not_allowed", "rule.category");
    if (rule.urgent !== undefined)
      throw new RuleChangeError("rule_category_not_allowed", "rule.urgent");
  }
  if (!isValidRoutingRuleMatch(rule.match))
    throw new RuleChangeError("rule_match_invalid", "rule.match");
}

/** Apply one change to the candidate rule set. Activation is not reachable here. */
export async function changeRoutingRule(
  env: { MAIL_ARCHIVE: R2Bucket },
  principal: MailPrincipal,
  change: RuleChange,
  now = new Date(),
) {
  const bucket = env.MAIL_ARCHIVE;
  let loaded;
  try {
    loaded = await loadShadowConfiguration(bucket);
  } catch (error) {
    throw new RuleChangeError(
      error instanceof ShadowConfigurationUnavailableError
        ? "configuration_unavailable"
        : "configuration_unreadable",
    );
  }
  if (!loaded) throw new RuleChangeError("configuration_absent");
  const previousSha256 = loaded.router.configurationSha256;
  if (previousSha256 !== change.expectedSha256)
    throw new RuleChangeError("configuration_conflict", "expected_configuration_sha256");

  // Keep the stored order and every other configuration field; only rules change.
  const config = JSON.parse(loaded.artifact.configJson) as Record<string, unknown> & {
    rules: RoutingRule[];
  };
  const rules = [...config.rules];
  const id = change.operation === "propose" ? change.rule.id : change.ruleId;
  const index = rules.findIndex((rule) => rule.id === id);
  if (change.operation === "propose") {
    if (index >= 0) throw new RuleChangeError("rule_id_exists", "rule.id");
    if (rules.length >= ROUTING_LIMITS.rules)
      throw new RuleChangeError("rule_limit_exceeded", "rule");
    const rule = normalized(change.rule);
    checkRule(rule);
    rules.push(rule);
  } else if (index < 0) throw new RuleChangeError("rule_not_found", "rule_id");
  else if (change.operation === "update") {
    const rule = normalized({ ...change.rule, id });
    checkRule(rule);
    if (JSON.stringify(rule) === JSON.stringify(normalized(rules[index]!)))
      throw new RuleChangeError("rule_unchanged", "rule");
    rules[index] = rule;
  } else rules.splice(index, 1);

  const configJson = JSON.stringify({ ...config, rules });
  if (new TextEncoder().encode(configJson).byteLength > ROUTING_LIMITS.configBytes)
    throw new RuleChangeError("configuration_too_large", "rule");
  const artifactJson = JSON.stringify({ ...loaded.artifact, configJson });
  if (new TextEncoder().encode(artifactJson).byteLength > ARTIFACT_BYTES)
    throw new RuleChangeError("configuration_too_large", "rule");
  let next;
  try {
    next = await parseShadowArtifact(artifactJson);
  } catch {
    throw new RuleChangeError("configuration_invalid");
  }
  const nextSha256 = next.router.configurationSha256;

  const previous = await readRuleRevision(bucket, loaded.customMetadata, previousSha256);
  const times = new Map((previous?.ruleTimes ?? []).map((entry) => [entry.id, entry]));
  const at = now.toISOString();
  const ruleTimes = rules.map((rule) => {
    const known = times.get(rule.id);
    if (rule.id !== id)
      return { id: rule.id, addedAt: known?.addedAt ?? null, changedAt: known?.changedAt ?? null };
    return change.operation === "propose"
      ? { id, addedAt: at, changedAt: at }
      : { id, addedAt: known?.addedAt ?? null, changedAt: at };
  });
  const revisionId = crypto.randomUUID();
  const record: RuleRevision = {
    schemaVersion: 1,
    revisionId,
    previousRevisionId: previous?.revisionId ?? null,
    previousConfigurationSha256: previousSha256,
    configurationSha256: nextSha256,
    operation: change.operation,
    ruleId: id,
    principalId: principal.id,
    createdAt: at,
    ruleTimes,
    artifactJson,
  };
  const recordKey = `${RULE_REVISION_PREFIX}${revisionId}.json`;
  try {
    // A record is committed only once the candidate names it; a record left by
    // a lost race is never referenced.
    await bucket.put(recordKey, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch {
    throw new RuleChangeError("configuration_unavailable");
  }
  let written;
  try {
    written = await bucket.put(ROUTING_CONFIG_KEY, artifactJson, {
      onlyIf: { etagMatches: loaded.etag },
      httpMetadata: { contentType: "application/json" },
      customMetadata: { revision_id: revisionId, configuration_sha256: nextSha256 },
    });
  } catch {
    // The outcome is unknown; the record stays so a committed candidate keeps it.
    throw new RuleChangeError("configuration_unavailable");
  }
  if (!written) {
    await bucket.delete(recordKey).catch(() => undefined);
    throw new RuleChangeError("configuration_conflict", "expected_configuration_sha256");
  }
  // Who changed which revision and when; never the rule, its ID or its expression.
  console.log(
    JSON.stringify({
      event: "routing_rule_change",
      operation: change.operation,
      principal_id: principal.id,
      revision_id: revisionId,
      previous_configuration_sha256: previousSha256,
      configuration_sha256: nextSha256,
    }),
  );
  return {
    configuration: "candidate" as const,
    operation: change.operation,
    rule_id: id,
    previous_configuration_sha256: previousSha256,
    configuration_sha256: nextSha256,
    revision_id: revisionId,
    previous_revision_id: record.previousRevisionId,
    changed_by: principal.id,
    changed_at: at,
    rule_count: rules.length,
    activated: false as const,
  };
}
