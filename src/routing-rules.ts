import * as v from "valibot";
import { readRoutingConfig, type RoutingConfig } from "./routing.ts";
import { loadShadowConfiguration } from "./routing-shadow-runtime.ts";
import { loadDispatchConfiguration } from "./routing-dispatch-config.ts";
import { MailReadError } from "./mail-read.ts";

/**
 * Authorized read layer for private routing rules and their recorded decisions.
 *
 * Rule bodies (match expressions) are private administrator configuration. They are
 * returned only to an authenticated `mail:routing` principal through the MCP tools,
 * and never logged. Every input is a closed enumeration, a bounded number or a
 * `mail_` ID; mail content and model output select nothing here.
 */
export interface RoutingRulesEnvironment {
  MAIL_ARCHIVE: R2Bucket;
  MAIL_CATALOG: D1Database;
}

/** Live and imported raw keys are `ingest/<UTC day>/<uuid>/raw.eml`; '0' follows '/'. */
const INGEST_END = "ingest0";
const DAY_MS = 86_400_000;
export const ROUTING_USAGE_LIMITS = {
  maxWindowDays: 90,
  defaultWindowDays: 30,
  maxDecisions: 2000,
  maxSamples: 10,
  defaultSamples: 3,
  explainRows: 16,
} as const;

type Outcome = RoutingConfig["fallback"];
interface RuleSet {
  status: "configured" | "absent" | "unreadable";
  configurationSha256: string | null;
  uploadedAt: string | null;
  config: RoutingConfig | null;
}
interface ActiveRuleSet extends RuleSet {
  revision: number | null;
  generation: number | null;
  enabled: boolean | null;
  activated: boolean | null;
}
export interface RoutingRuleSets {
  candidate: RuleSet;
  active: ActiveRuleSet;
}
const empty = (status: RuleSet["status"]): RuleSet => ({
  status,
  configurationSha256: null,
  uploadedAt: null,
  config: null,
});

/** Read both private artifacts. Unreadable configuration is reported, never guessed. */
export async function loadRoutingRuleSets(env: RoutingRulesEnvironment): Promise<RoutingRuleSets> {
  let candidate: RuleSet;
  try {
    const loaded = await loadShadowConfiguration(env.MAIL_ARCHIVE);
    candidate = loaded
      ? {
          status: "configured",
          configurationSha256: loaded.router.configurationSha256,
          uploadedAt: loaded.uploaded.toISOString(),
          config: readRoutingConfig(loaded.artifact.configJson),
        }
      : empty("absent");
  } catch {
    candidate = empty("unreadable");
  }
  const inactive = { revision: null, generation: null, enabled: null, activated: null };
  let active: ActiveRuleSet;
  try {
    const loaded = await loadDispatchConfiguration(env.MAIL_ARCHIVE);
    if (!loaded) active = { ...empty("absent"), ...inactive };
    else {
      const control = await env.MAIL_CATALOG.prepare(
        "SELECT revision,configuration_sha256,accepting,paused FROM routing_dispatch_control WHERE id=1",
      ).first<{
        revision: number;
        configuration_sha256: string;
        accepting: number;
        paused: number;
      }>();
      const artifact = loaded.artifact;
      active = {
        status: "configured",
        configurationSha256: loaded.router.configurationSha256,
        uploadedAt: loaded.uploaded.toISOString(),
        config: readRoutingConfig(artifact.routing.configJson),
        revision: artifact.revision,
        generation: artifact.generation,
        enabled: artifact.enabled,
        activated:
          artifact.enabled &&
          control?.revision === artifact.revision &&
          control.configuration_sha256 === loaded.configurationSha256 &&
          control.accepting === 1 &&
          control.paused === 0,
      };
    }
  } catch {
    active = { ...empty("unreadable"), ...inactive };
  }
  return { candidate, active };
}

function ruleKey(rule: RoutingConfig["rules"][number]) {
  return JSON.stringify([
    rule.priority,
    rule.match,
    rule.outcome,
    rule.category ?? null,
    rule.urgent ?? null,
  ]);
}

function publicRuleSet(set: RuleSet, other: RuleSet) {
  const others = new Map((other.config?.rules ?? []).map((rule) => [rule.id, ruleKey(rule)]));
  return {
    status: set.status,
    configuration_sha256: set.configurationSha256,
    uploaded_at: set.uploadedAt,
    fallback: set.config?.fallback ?? null,
    rules: (set.config?.rules ?? []).map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      match: rule.match,
      outcome: rule.outcome,
      category: rule.category ?? null,
      urgent: rule.urgent ?? null,
      // Previous revisions are not retained, so no per-rule time is known.
      added_at: null,
      changed_at: null,
      compared_to_other:
        other.status !== "configured"
          ? null
          : !others.has(rule.id)
            ? "only_here"
            : others.get(rule.id) === ruleKey(rule)
              ? "same"
              : "changed",
    })),
    adoptions: (set.config?.adoptions ?? []).map((adoption) => ({
      plugin_id: adoption.pluginId,
      version: adoption.version,
      manifest_sha256: adoption.manifestSha256,
      enabled: adoption.enabled,
      priority: adoption.priority,
      input_fields: adoption.inputFields,
    })),
  };
}

/** `list_routing_rules`: current candidate (shadow) and active (dispatch) rules. */
export async function listRoutingRules(env: RoutingRulesEnvironment) {
  const sets = await loadRoutingRuleSets(env);
  const { active } = sets;
  return {
    candidate: publicRuleSet(sets.candidate, active),
    active: {
      ...publicRuleSet(active, sets.candidate),
      revision: active.revision,
      generation: active.generation,
      enabled: active.enabled,
      activated: active.activated,
    },
    same_configuration:
      sets.candidate.configurationSha256 !== null &&
      sets.candidate.configurationSha256 === active.configurationSha256,
    history: {
      available: false,
      reason:
        "Only the current object under each fixed R2 key is stored; earlier revisions and per-rule change times are not retained.",
    },
  };
}

const ruleIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const categorySchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/));
const evidenceSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/));
const decisionSchema = v.object({
  status: v.picklist(["shadow", "historical_suppressed", "invalid_metadata", "evaluation_error"]),
  candidates: v.pipe(
    v.array(
      v.object({
        pluginId: ruleIdSchema,
        manifestVersion: v.pipe(v.string(), v.maxLength(64)),
        mode: v.picklist(["exclusive", "observer"]),
      }),
    ),
    v.maxLength(16),
  ),
  fallback: v.object({
    outcome: v.picklist(["review", "ignore", "unresolved"]),
    ruleId: v.nullable(ruleIdSchema),
    category: v.optional(categorySchema),
    urgent: v.optional(v.boolean()),
  }),
});
const resolutionSchema = v.object({
  outcome: v.picklist(["review", "ignore", "hold"]),
  category: v.nullable(categorySchema),
  urgent: v.boolean(),
  evidenceCode: evidenceSchema,
});
/** Stored rows are fumi's own output, but parsing stays closed: an unexpected
 * value is reported as unreadable rather than passed through. */
function parsed<T extends v.GenericSchema>(schema: T, json: string | null) {
  if (json === null || json.length > 16_384) return null;
  try {
    const result = v.safeParse(schema, JSON.parse(json) as unknown);
    return result.success ? (result.output as v.InferOutput<T>) : null;
  } catch {
    return null;
  }
}
const evidence = (value: string | null) => (value && v.is(evidenceSchema, value) ? value : null);
const receivedAt = (value: string | null, rawKey: string) =>
  value ?? `${rawKey.slice("ingest/".length, "ingest/".length + 10)}T00:00:00.000Z`;

export interface RoutingUsageInput {
  configuration: "candidate" | "active";
  window_days: number;
  max_decisions: number;
  samples_per_rule: number;
}

function counter<K>(key: (value: K) => string) {
  const counts = new Map<string, { value: K; count: number }>();
  return {
    add(value: K) {
      const id = key(value);
      const entry = counts.get(id);
      if (entry) entry.count++;
      else counts.set(id, { value, count: 1 });
    },
    list() {
      return [...counts.values()]
        .sort((a, b) => b.count - a.count || (key(a.value) < key(b.value) ? -1 : 1))
        .map((entry) => ({ ...entry.value, count: entry.count }));
    },
  };
}

/** Each scan is a descending range over a primary-key or unique index that starts
 * with raw_key, so the newest receipt days come first without a sort, and the row
 * cap bounds what is read. Exported for the query-plan test. */
export const USAGE_SQL = {
  decisions: `SELECT d.raw_key,d.state,d.failure_code,d.decision_json,s.external_id,s.received_at
    FROM routing_shadow_decisions d JOIN archive_sources s ON s.raw_key=d.raw_key
    WHERE d.raw_key>=? AND d.raw_key<? AND d.configuration_sha256=?
    AND d.source_kind='email_routing' AND d.notify_events=1
    ORDER BY d.raw_key DESC LIMIT ?`,
  classifications: `SELECT state,failure_code,result_json FROM routing_classifications
    WHERE raw_key>=? AND raw_key<? ORDER BY raw_key DESC LIMIT ?`,
  jobs: `SELECT state,failure_code FROM routing_dispatch_jobs
    WHERE raw_key>=? AND raw_key<? ORDER BY raw_key DESC LIMIT ?`,
  offers: `SELECT lane,state FROM routing_dispatch_outbox
    WHERE raw_key>=? AND raw_key<? ORDER BY raw_key DESC LIMIT ?`,
} as const;

/** `routing_rule_usage`: bounded, indexed scans of the most recent decisions. */
export async function routingRuleUsage(
  env: RoutingRulesEnvironment,
  input: RoutingUsageInput,
  now = Date.now(),
) {
  const sets = await loadRoutingRuleSets(env);
  const set = sets[input.configuration];
  const startDay = new Date(now - (input.window_days - 1) * DAY_MS).toISOString().slice(0, 10);
  const lower = `ingest/${startDay}/`;
  const cap = input.max_decisions;
  const db = env.MAIL_CATALOG;
  // One extra row per scan detects truncation.
  const [shadow, classifications, jobs, offers] = await Promise.all([
    set.configurationSha256 === null
      ? Promise.resolve([])
      : db
          .prepare(USAGE_SQL.decisions)
          .bind(lower, INGEST_END, set.configurationSha256, cap + 1)
          .all<{
            raw_key: string;
            state: string;
            failure_code: string | null;
            decision_json: string | null;
            external_id: string;
            received_at: string | null;
          }>()
          .then((rows) => rows.results),
    db
      .prepare(USAGE_SQL.classifications)
      .bind(lower, INGEST_END, cap + 1)
      .all<{ state: string; failure_code: string | null; result_json: string | null }>()
      .then((rows) => rows.results),
    db
      .prepare(USAGE_SQL.jobs)
      .bind(lower, INGEST_END, cap + 1)
      .all<{ state: string; failure_code: string | null }>()
      .then((rows) => rows.results),
    db
      .prepare(USAGE_SQL.offers)
      .bind(lower, INGEST_END, cap + 1)
      .all<{ lane: string; state: string }>()
      .then((rows) => rows.results),
  ]);

  const scanned = shadow.slice(0, cap);
  const rules = new Map(
    (set.config?.rules ?? []).map((rule) => [
      rule.id,
      { first: null as string | null, last: null as string | null, matches: [] as string[][] },
    ]),
  );
  let defaultMatches = 0;
  let unreadable = 0;
  let oldest: string | null = null;
  const blocked = counter<{ failure_code: string | null; status: string | null }>((value) =>
    JSON.stringify([value.failure_code, value.status]),
  );
  const plugins = counter<{ plugin_id: string; mode: string }>((value) =>
    JSON.stringify([value.plugin_id, value.mode]),
  );
  for (const row of scanned) {
    const time = receivedAt(row.received_at, row.raw_key);
    if (oldest === null || time < oldest) oldest = time;
    if (row.state !== "complete") {
      blocked.add({ failure_code: evidence(row.failure_code), status: null });
      continue;
    }
    const decision = parsed(decisionSchema, row.decision_json);
    if (!decision) {
      unreadable++;
      continue;
    }
    if (decision.status !== "shadow") {
      blocked.add({ failure_code: null, status: decision.status });
      continue;
    }
    for (const candidate of decision.candidates)
      plugins.add({ plugin_id: candidate.pluginId, mode: candidate.mode });
    const usage = decision.fallback.ruleId === null ? null : rules.get(decision.fallback.ruleId);
    if (!usage) {
      defaultMatches++;
      continue;
    }
    if (usage.first === null || time < usage.first) usage.first = time;
    if (usage.last === null || time > usage.last) usage.last = time;
    usage.matches.push([time, `mail_${row.external_id}`]);
  }
  const truncated = shadow.length > cap;
  const ruleUsage = [...rules].map(([id, usage]) => ({
    rule_id: id,
    matches: usage.matches.length,
    first_matched_at: usage.first,
    last_matched_at: usage.last,
    sample_message_ids: usage.matches
      .sort((a, b) => (a[0]! < b[0]! ? 1 : a[0]! > b[0]! ? -1 : a[1]! < b[1]! ? -1 : 1))
      .slice(0, input.samples_per_rule)
      .map((match) => match[1]!),
  }));

  const outcomes = counter<{
    state: string;
    outcome: string | null;
    category: string | null;
    evidence_code: string | null;
  }>((value) => JSON.stringify([value.state, value.outcome, value.category, value.evidence_code]));
  for (const row of classifications.slice(0, cap)) {
    const result = row.state === "pending" ? null : parsed(resolutionSchema, row.result_json);
    outcomes.add({
      state: ["pending", "complete", "held"].includes(row.state) ? row.state : "unknown",
      outcome: result?.outcome ?? null,
      category: result?.category ?? null,
      evidence_code: result?.evidenceCode ?? evidence(row.failure_code),
    });
  }
  const jobStates = counter<{ state: string; reason: string | null }>((value) =>
    JSON.stringify([value.state, value.reason]),
  );
  for (const row of jobs.slice(0, cap))
    jobStates.add({ state: row.state, reason: evidence(row.failure_code) });
  const lanes = counter<{ lane: string; state: string }>((value) =>
    JSON.stringify([value.lane, value.state]),
  );
  for (const row of offers.slice(0, cap)) lanes.add({ lane: row.lane, state: row.state });

  return {
    configuration: input.configuration,
    status: set.status,
    configuration_sha256: set.configurationSha256,
    window: {
      days: input.window_days,
      start: `${startDay}T00:00:00.000Z`,
      end: new Date(now).toISOString(),
    },
    decisions: {
      source: "routing_shadow_decisions",
      max_rows: cap,
      scanned: scanned.length,
      truncated,
      oldest_scanned_received_at: oldest,
      default_outcome: set.config?.fallback ?? null,
      default_matches: defaultMatches,
      unreadable,
      not_evaluated: blocked.list(),
      rules: ruleUsage,
      // With truncation, "no match" covers only the scanned decisions, not the window.
      unmatched_rule_ids: ruleUsage
        .filter((rule) => rule.matches === 0)
        .map((rule) => rule.rule_id),
      unmatched_covers_window: !truncated,
      plugin_candidates: plugins.list(),
    },
    classifier: {
      source: "routing_classifications",
      max_rows: cap,
      scanned: Math.min(classifications.length, cap),
      truncated: classifications.length > cap,
      outcomes: outcomes.list(),
    },
    dispatch: {
      source: "routing_dispatch_jobs",
      max_rows: cap,
      scanned_jobs: Math.min(jobs.length, cap),
      jobs_truncated: jobs.length > cap,
      jobs: jobStates.list(),
      scanned_offers: Math.min(offers.length, cap),
      offers_truncated: offers.length > cap,
      offers: lanes.list(),
    },
  };
}

interface ShadowEvidence {
  configuration_sha256: string;
  configuration: "candidate_and_active" | "candidate" | "active" | "other";
  state: "complete" | "unreadable" | "blocked";
  failure_code: string | null;
  status: "shadow" | "historical_suppressed" | "invalid_metadata" | "evaluation_error" | null;
  rule_id: string | null;
  outcome: Outcome | null;
  category: string | null;
  urgent: boolean | null;
  plugin_candidates: {
    plugin_id: string;
    mode: "exclusive" | "observer";
    manifest_version: string;
  }[];
  evaluated_at: string;
  current: boolean;
}
interface OfferEvidence {
  lane: string;
  state: string;
  failure_code: string | null;
  revision: number;
  generation: number;
  category: string | null;
  urgent: boolean | null;
  evidence_code: string | null;
  updated_at: string;
}
interface ClassificationEvidence {
  policy_sha256: string;
  state: string;
  outcome: "review" | "ignore" | "hold" | null;
  category: string | null;
  urgent: boolean | null;
  evidence_code: string | null;
  failure_code: string | null;
  updated_at: string;
}
interface JobEvidence {
  state: string;
  reason: string | null;
  revision: number;
  updated_at: string;
}

/** `explain_routing`: stored evidence for one message, newest first. */
export async function explainRouting(env: RoutingRulesEnvironment, messageId: string) {
  const db = env.MAIL_CATALOG;
  // The same lookup and conflict rule as read_email.
  const sources = (
    await db
      .prepare(`SELECT s.raw_key,s.external_id,s.received_at,s.source_kind,s.notify_events,
        e.raw_sha256 AS extraction_sha256,e.updated_at AS extraction_updated_at
        FROM archive_sources s LEFT JOIN mail_extractions e
        ON e.raw_key=s.raw_key AND e.extractor_version='mime-v1' AND e.status='complete'
        WHERE s.external_id=? LIMIT 2`)
      .bind(messageId.slice("mail_".length))
      .all<{
        raw_key: string;
        external_id: string;
        received_at: string | null;
        source_kind: string;
        notify_events: number;
        extraction_sha256: string | null;
        extraction_updated_at: number | null;
      }>()
  ).results;
  if (!sources.length) throw new MailReadError("message_not_found");
  if (sources.length > 1) throw new MailReadError("message_conflict");
  const source = sources[0]!;
  const limit = ROUTING_USAGE_LIMITS.explainRows;
  const [sets, shadowRows, job, offerRows, classificationRows] = await Promise.all([
    loadRoutingRuleSets(env),
    db
      .prepare(`SELECT configuration_sha256,source_sha256,extraction_updated_at,state,failure_code,
        decision_json,updated_at FROM routing_shadow_decisions WHERE raw_key=?
        ORDER BY updated_at DESC,configuration_sha256 LIMIT ?`)
      .bind(source.raw_key, limit + 1)
      .all<{
        configuration_sha256: string;
        source_sha256: string;
        extraction_updated_at: number;
        state: string;
        failure_code: string | null;
        decision_json: string | null;
        updated_at: number;
      }>()
      .then((rows) => rows.results),
    db
      .prepare(
        "SELECT state,failure_code,revision,updated_at FROM routing_dispatch_jobs WHERE raw_key=?",
      )
      .bind(source.raw_key)
      .first<{
        state: string;
        failure_code: string | null;
        revision: number;
        updated_at: number;
      }>(),
    // Only the symbolic classification is read from a frozen payload; granted
    // mail input in owner payloads is never selected.
    db
      .prepare(`SELECT lane,state,failure_code,revision,generation,updated_at,
        json_extract(payload_json,'$.classification.category') AS category,
        json_extract(payload_json,'$.classification.urgent') AS urgent,
        json_extract(payload_json,'$.classification.evidenceCode') AS evidence_code
        FROM routing_dispatch_outbox WHERE raw_key=? ORDER BY lane LIMIT ?`)
      .bind(source.raw_key, limit + 1)
      .all<{
        lane: string;
        state: string;
        failure_code: string | null;
        revision: number;
        generation: number;
        updated_at: number;
        category: string | null;
        urgent: number | null;
        evidence_code: string | null;
      }>()
      .then((rows) => rows.results),
    db
      .prepare(`SELECT policy_sha256,state,failure_code,result_json,updated_at
        FROM routing_classifications WHERE raw_key=? ORDER BY updated_at DESC,policy_sha256 LIMIT ?`)
      .bind(source.raw_key, limit + 1)
      .all<{
        policy_sha256: string;
        state: string;
        failure_code: string | null;
        result_json: string | null;
        updated_at: number;
      }>()
      .then((rows) => rows.results),
  ]);
  const which = (hash: string): ShadowEvidence["configuration"] =>
    hash === sets.candidate.configurationSha256
      ? hash === sets.active.configurationSha256
        ? "candidate_and_active"
        : "candidate"
      : hash === sets.active.configurationSha256
        ? "active"
        : "other";
  const shadow = shadowRows.slice(0, limit).map((row): ShadowEvidence => {
    const decision = row.state === "complete" ? parsed(decisionSchema, row.decision_json) : null;
    return {
      configuration_sha256: row.configuration_sha256,
      configuration: which(row.configuration_sha256),
      state: row.state === "complete" ? (decision ? "complete" : "unreadable") : "blocked",
      failure_code: evidence(row.failure_code),
      status: decision?.status ?? null,
      rule_id: decision?.fallback.ruleId ?? null,
      outcome: decision?.fallback.outcome ?? null,
      category: decision?.fallback.category ?? null,
      urgent: decision?.fallback.urgent ?? null,
      plugin_candidates: (decision?.candidates ?? []).map((candidate) => ({
        plugin_id: candidate.pluginId,
        mode: candidate.mode,
        manifest_version: candidate.manifestVersion,
      })),
      evaluated_at: new Date(row.updated_at).toISOString(),
      current:
        row.source_sha256 === source.extraction_sha256 &&
        row.extraction_updated_at === source.extraction_updated_at,
    };
  });
  const offers = offerRows.slice(0, limit).map((row): OfferEvidence => ({
    lane: row.lane,
    state: row.state,
    failure_code: evidence(row.failure_code),
    revision: row.revision,
    generation: row.generation,
    category: row.category !== null && v.is(categorySchema, row.category) ? row.category : null,
    urgent: row.urgent === null ? null : row.urgent === 1,
    evidence_code: evidence(row.evidence_code),
    updated_at: new Date(row.updated_at).toISOString(),
  }));
  const classifications = classificationRows.slice(0, limit).map((row): ClassificationEvidence => {
    const result = row.state === "pending" ? null : parsed(resolutionSchema, row.result_json);
    return {
      policy_sha256: row.policy_sha256,
      state: row.state,
      outcome: result?.outcome ?? null,
      category: result?.category ?? null,
      urgent: result?.urgent ?? null,
      evidence_code: result?.evidenceCode ?? null,
      failure_code: evidence(row.failure_code),
      updated_at: new Date(row.updated_at).toISOString(),
    };
  });
  const dispatchJob: JobEvidence | null = job
    ? {
        state: job.state,
        reason: evidence(job.failure_code),
        revision: job.revision,
        updated_at: new Date(job.updated_at).toISOString(),
      }
    : null;

  return {
    message_id: `mail_${source.external_id}`,
    received_at: source.received_at,
    provenance:
      source.source_kind === "email_routing" && source.notify_events === 1
        ? ("live" as const)
        : ("historical" as const),
    decided_by: decidedBy(sets, shadow, dispatchJob, offers, classifications),
    shadow,
    shadow_truncated: shadowRows.length > limit,
    dispatch: { job: dispatchJob, offers, offers_truncated: offerRows.length > limit },
    classifications,
    classifications_truncated: classificationRows.length > limit,
    rule_id_note:
      "Live dispatch does not store the deciding rule ID. A rule ID is attributed to a dispatch decision only from a current shadow decision under the active configuration's SHA-256 while the job's revision is the active revision.",
  };
}

export interface DecidedBy {
  kind:
    | "plugin"
    | "plugin_offer"
    | "rule"
    | "default"
    | "rule_or_default"
    | "classifier"
    | "unresolved"
    | "suppressed"
    | "blocked"
    | "not_evaluated";
  source: "dispatch" | "shadow" | null;
  plugin_id: string | null;
  rule_id: string | null;
  outcome: Outcome | "hold" | null;
  category: string | null;
  evidence_code: string | null;
  configuration_sha256: string | null;
  revision: number | null;
}

function decidedBy(
  sets: RoutingRuleSets,
  shadow: ShadowEvidence[],
  job: JobEvidence | null,
  offers: OfferEvidence[],
  classifications: ClassificationEvidence[],
): DecidedBy {
  const none: DecidedBy = {
    kind: "not_evaluated",
    source: null,
    plugin_id: null,
    rule_id: null,
    outcome: null,
    category: null,
    evidence_code: null,
    configuration_sha256: null,
    revision: null,
  };
  if (job) {
    const base: DecidedBy = { ...none, source: "dispatch", revision: job.revision };
    const handled = offers.find(
      (offer) => offer.lane.startsWith("owner:") && offer.state === "handled",
    );
    if (handled) return { ...base, kind: "plugin", plugin_id: handled.lane.slice("owner:".length) };
    const action = offers.find((offer) => offer.lane === "action");
    const code = action?.evidence_code ?? job.reason;
    const outcome: DecidedBy["outcome"] = action
      ? "review"
      : job.state === "ignored"
        ? "ignore"
        : job.state === "complete"
          ? null
          : "hold";
    if (code === "static_rule") {
      const active = sets.active;
      const match =
        active.revision === job.revision
          ? shadow.find(
              (row) =>
                row.current &&
                row.state === "complete" &&
                row.configuration_sha256 === active.configurationSha256,
            )
          : undefined;
      return {
        ...base,
        kind: match ? (match.rule_id ? "rule" : "default") : "rule_or_default",
        rule_id: match?.rule_id ?? null,
        outcome,
        category: action?.category ?? match?.category ?? null,
        evidence_code: code,
        configuration_sha256: match ? active.configurationSha256 : null,
      };
    }
    if (code?.startsWith("model_")) {
      const result = classifications.find((row) => row.evidence_code === code);
      return {
        ...base,
        kind: "classifier",
        outcome: result?.outcome ?? outcome,
        category: action?.category ?? result?.category ?? null,
        evidence_code: code,
      };
    }
    return { ...base, kind: "unresolved", outcome, evidence_code: code };
  }
  const order = ["candidate_and_active", "candidate", "active", "other"];
  const row = shadow
    .filter((item) => item.current)
    .sort((a, b) => order.indexOf(a.configuration) - order.indexOf(b.configuration))[0];
  if (!row) return none;
  const base: DecidedBy = {
    ...none,
    source: "shadow",
    configuration_sha256: row.configuration_sha256,
  };
  if (row.state !== "complete")
    return { ...base, kind: "blocked", evidence_code: row.failure_code };
  if (row.status !== "shadow") return { ...base, kind: "suppressed", evidence_code: row.status };
  const exclusive = row.plugin_candidates.find((candidate) => candidate.mode === "exclusive");
  if (exclusive) return { ...base, kind: "plugin_offer", plugin_id: exclusive.plugin_id };
  return {
    ...base,
    kind: row.rule_id ? "rule" : "default",
    rule_id: row.rule_id,
    outcome: row.outcome,
    category: row.category,
  };
}
