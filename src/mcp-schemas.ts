import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import { INLINE_ATTACHMENT_BASE64_CHARACTERS } from "./outbound.ts";
import { ROUTING_USAGE_LIMITS } from "./routing-rules.ts";
import { routingRuleSchema } from "./routing.ts";

export const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const shortText = v.pipe(v.string(), v.maxLength(1000));
const address = v.pipe(v.string(), v.minLength(3), v.maxLength(254));
const addresses = v.pipe(v.array(address), v.maxLength(50));
const boundedBody = v.pipe(v.string(), v.maxLength(100_000));
const page = {
  max_results: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)), 20),
  next_page_token: v.optional(v.pipe(v.string(), v.maxLength(8192))),
};
const archiveSearch = {
  ...page,
  query: v.optional(shortText),
  archive_source: v.optional(v.picklist(["all", "gmail", "email_routing"])),
  label_ids: v.optional(
    v.nullable(
      v.pipe(v.array(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/))), v.maxLength(10)),
    ),
  ),
};
export const payloadSchema = v.strictObject({
  text: v.optional(boundedBody),
  html: v.optional(boundedBody),
  attachments: v.optional(
    v.pipe(
      v.array(
        v.strictObject({
          attachment_id: identifier,
          sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        }),
      ),
      v.maxLength(8),
    ),
  ),
});
export const mailInputEntries = {
  to: addresses,
  cc: v.optional(addresses),
  bcc: v.optional(addresses),
  from_address: v.optional(address),
  subject: v.pipe(v.string(), v.maxLength(998)),
  payload: payloadSchema,
  reply_message_id: v.optional(identifier),
  quote: v.optional(v.boolean()),
  include_attachments: v.optional(v.boolean()),
  reply_to: v.optional(address),
};
export const mailInputSchema = v.strictObject(mailInputEntries);
const { quote: _quote, ...forwardInputEntries } = mailInputEntries;
const expectedSha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const toolSchemas = {
  get_mail_health: v.strictObject({}),
  search_mail_semantic: v.strictObject({
    query: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
    mode: v.optional(v.picklist(["semantic", "hybrid"]), "hybrid"),
    max_results: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10)), 10),
    filters: v.optional(shortText),
    archive_source: archiveSearch.archive_source,
    label_ids: archiveSearch.label_ids,
  }),
  search_mail_content: v.strictObject({
    ...page,
    query: v.pipe(v.string(), v.minLength(3), v.maxLength(200)),
    filters: v.optional(shortText),
  }),
  get_profile: v.strictObject({}),
  read_email: v.strictObject({
    message_id: identifier,
    format: v.optional(v.picklist(["full", "minimal", "metadata", "raw"]), "full"),
  }),
  batch_read_email: v.strictObject({
    message_ids: v.pipe(v.array(identifier), v.minLength(1), v.maxLength(10)),
    format: v.optional(v.picklist(["full", "minimal", "metadata", "raw"]), "full"),
  }),
  read_email_thread: v.strictObject({
    message_id: v.optional(v.nullable(identifier)),
    thread_id: v.optional(v.nullable(identifier)),
    max_messages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20)), 20),
  }),
  read_attachment: v.strictObject({
    message_id: identifier,
    attachment_id: v.optional(identifier),
    filename: v.optional(shortText),
  }),
  search_emails: v.strictObject(archiveSearch),
  search_email_ids: v.strictObject(archiveSearch),
  preview_email: mailInputSchema,
  create_draft: mailInputSchema,
  get_draft: v.strictObject({ draft_id: identifier }),
  list_drafts: v.strictObject(page),
  update_draft: v.strictObject({
    draft_id: identifier,
    expected_revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    to: v.optional(addresses),
    cc: v.optional(addresses),
    bcc: v.optional(addresses),
    from_address: v.optional(address),
    subject: v.optional(v.pipe(v.string(), v.maxLength(998))),
    payload: v.optional(payloadSchema),
    reply_message_id: v.optional(identifier),
    quote: v.optional(v.boolean()),
    include_attachments: v.optional(v.boolean()),
    reply_to: v.optional(address),
  }),
  send_email: v.strictObject({ ...mailInputEntries, idempotency_key: identifier }),
  send_draft: v.strictObject({
    draft_id: identifier,
    expected_revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    idempotency_key: identifier,
  }),
  // Forwards never quote: the forwarded block replaces the reply quote.
  forward_emails: v.strictObject({
    ...forwardInputEntries,
    message_id: identifier,
    idempotency_key: identifier,
  }),
  get_send_status: v.strictObject({ operation_id: identifier }),
  upload_attachment: v.strictObject({
    filename: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    content_type: v.pipe(v.string(), v.maxLength(100)),
    // format "byte" is the OpenAPI marker for base64. It did not make the Claude
    // app offer file references (docs/mcp-file-transfer.md), but it is accurate.
    content_base64: v.pipe(
      v.string(),
      v.maxLength(INLINE_ATTACHMENT_BASE64_CHARACTERS),
      v.metadata({ format: "byte" }),
      v.description("The base64-encoded content of the attachment."),
    ),
  }),
  copy_attachment: v.strictObject({
    message_id: identifier,
    attachment_id: v.pipe(v.string(), v.regex(/^part_(0|[1-9][0-9]?)$/)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  }),
  list_routing_rules: v.strictObject({}),
  routing_rule_usage: v.strictObject({
    configuration: v.optional(v.picklist(["candidate", "active"]), "candidate"),
    window_days: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(ROUTING_USAGE_LIMITS.maxWindowDays),
      ),
      ROUTING_USAGE_LIMITS.defaultWindowDays,
    ),
    max_decisions: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(ROUTING_USAGE_LIMITS.maxDecisions)),
      ROUTING_USAGE_LIMITS.maxDecisions,
    ),
    samples_per_rule: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(ROUTING_USAGE_LIMITS.maxSamples)),
      ROUTING_USAGE_LIMITS.defaultSamples,
    ),
  }),
  explain_routing: v.strictObject({
    message_id: v.pipe(v.string(), v.regex(/^mail_[a-zA-Z0-9-]{1,128}$/)),
  }),
  // The rule shape is the configuration validator's own schema.
  propose_routing_rule: v.strictObject({
    expected_configuration_sha256: expectedSha256,
    rule: routingRuleSchema,
  }),
  update_routing_rule: v.strictObject({
    expected_configuration_sha256: expectedSha256,
    rule_id: routingRuleSchema.entries.id,
    rule: v.omit(routingRuleSchema, ["id"]),
  }),
  retire_routing_rule: v.strictObject({
    expected_configuration_sha256: expectedSha256,
    rule_id: routingRuleSchema.entries.id,
  }),
};

const attachmentOutput = v.looseObject({
  attachment_id: identifier,
  sha256: v.string(),
  size: v.number(),
  filename: v.nullable(v.string()),
});
const inputOutput = v.looseObject({
  to: addresses,
  from_address: address,
  subject: v.string(),
  payload: v.looseObject({
    text: v.optional(v.string()),
    html: v.optional(v.string()),
    attachments: v.optional(
      v.array(v.looseObject({ attachment_id: identifier, sha256: v.string() })),
    ),
  }),
});
const draftOutput = v.looseObject({
  draft_id: identifier,
  revision: v.number(),
  input: inputOutput,
  created_at: v.number(),
  updated_at: v.number(),
});
const sendOutput = v.looseObject({
  operation_id: identifier,
  state: v.picklist(["prepared", "accepted", "rejected", "unknown"]),
  provider_message_id: v.nullable(v.string()),
  failure_code: v.nullable(v.string()),
  recipients: v.array(
    v.looseObject({
      address: v.string(),
      kind: v.string(),
      state: v.string(),
      event_timestamp: v.number(),
    }),
  ),
  created_at: v.number(),
  updated_at: v.number(),
});
const messageOutput = v.looseObject({
  id: identifier,
  thread_id: identifier,
  label_ids: v.array(v.string()),
  extraction: v.optional(
    v.looseObject({
      status: v.picklist(["pending", "complete", "blocked"]),
      failure_code: v.nullable(v.string()),
    }),
  ),
  content_truncated: v.optional(v.boolean()),
  extraction_file_uri: v.optional(v.string()),
});
const searchOutput = v.looseObject({
  emails: v.array(v.looseObject({ id: identifier })),
  next_page_token: v.nullable(v.string()),
  coverage: v.record(v.string(), v.unknown()),
});
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const routingId = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
const routingCode = v.nullable(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/)));
const routingCategory = v.nullable(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_-]{0,63}$/)));
const ruleOutcome = v.picklist(["review", "ignore", "unresolved"]);
const isoTime = v.pipe(v.string(), v.isoTimestamp());
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const ruleSetStatus = v.picklist(["configured", "absent", "unreadable", "unavailable"]);
const ruleSetOutput = {
  status: ruleSetStatus,
  configuration_sha256: v.nullable(sha256),
  uploaded_at: v.nullable(isoTime),
  fallback: v.nullable(ruleOutcome),
  rules: v.array(
    v.strictObject({
      id: routingId,
      priority: count,
      match: v.string(),
      outcome: ruleOutcome,
      category: routingCategory,
      urgent: v.nullable(v.boolean()),
      added_at: v.nullable(isoTime),
      changed_at: v.nullable(isoTime),
      compared_to_other: v.nullable(v.picklist(["same", "changed", "only_here"])),
    }),
  ),
  adoptions: v.array(
    v.strictObject({
      plugin_id: routingId,
      version: v.string(),
      manifest_sha256: sha256,
      enabled: v.boolean(),
      priority: count,
      input_fields: v.array(v.picklist(["subject", "from", "to", "hasAttachments"])),
    }),
  ),
};
const ruleOperation = v.picklist(["propose", "update", "retire"]);
const ruleChangeOutput = v.strictObject({
  configuration: v.literal("candidate"),
  operation: ruleOperation,
  rule_id: routingId,
  previous_configuration_sha256: sha256,
  configuration_sha256: sha256,
  revision_id: v.string(),
  previous_revision_id: v.nullable(v.string()),
  changed_by: v.string(),
  changed_at: isoTime,
  rule_count: count,
  activated: v.literal(false),
});
const configurationLabel = v.picklist(["candidate_and_active", "candidate", "active", "other"]);
const routingOutputs = {
  propose_routing_rule: ruleChangeOutput,
  update_routing_rule: ruleChangeOutput,
  retire_routing_rule: ruleChangeOutput,
  list_routing_rules: v.strictObject({
    candidate: v.strictObject(ruleSetOutput),
    active: v.strictObject({
      ...ruleSetOutput,
      revision: v.nullable(count),
      generation: v.nullable(count),
      enabled: v.nullable(v.boolean()),
      activated: v.nullable(v.boolean()),
    }),
    same_configuration: v.boolean(),
    history: v.strictObject({
      available: v.boolean(),
      revision_id: v.nullable(v.string()),
      previous_revision_id: v.nullable(v.string()),
      previous_configuration_sha256: v.nullable(sha256),
      operation: v.nullable(ruleOperation),
      rule_id: v.nullable(routingId),
      changed_by: v.nullable(v.string()),
      changed_at: v.nullable(isoTime),
      note: v.string(),
    }),
  }),
  routing_rule_usage: v.strictObject({
    configuration: v.picklist(["candidate", "active"]),
    status: ruleSetStatus,
    configuration_sha256: v.nullable(sha256),
    window: v.strictObject({ days: count, start: isoTime, end: isoTime }),
    decisions: v.strictObject({
      source: v.literal("routing_shadow_decisions"),
      max_rows: count,
      scanned: count,
      truncated: v.boolean(),
      oldest_scanned_received_at: v.nullable(v.string()),
      default_outcome: v.nullable(ruleOutcome),
      default_matches: count,
      unreadable: count,
      not_evaluated: v.array(
        v.strictObject({ failure_code: routingCode, status: v.nullable(v.string()), count }),
      ),
      rules: v.array(
        v.strictObject({
          rule_id: routingId,
          matches: count,
          first_matched_at: v.nullable(v.string()),
          last_matched_at: v.nullable(v.string()),
          sample_message_ids: v.array(identifier),
        }),
      ),
      unmatched_rule_ids: v.array(routingId),
      not_yet_evaluated: v.pipe(count, v.maxValue(ROUTING_USAGE_LIMITS.maxNotYetEvaluated)),
      unmatched_covers_window: v.boolean(),
      plugin_candidates: v.array(
        v.strictObject({
          plugin_id: routingId,
          mode: v.picklist(["exclusive", "observer"]),
          count,
        }),
      ),
    }),
    classifier: v.strictObject({
      source: v.literal("routing_classifications"),
      max_rows: count,
      scanned: count,
      truncated: v.boolean(),
      outcomes: v.array(
        v.strictObject({
          state: v.picklist(["pending", "complete", "held", "unknown"]),
          outcome: v.nullable(v.picklist(["review", "ignore", "hold"])),
          category: routingCategory,
          evidence_code: routingCode,
          count,
        }),
      ),
    }),
    dispatch: v.strictObject({
      source: v.literal("routing_dispatch_jobs"),
      max_rows: count,
      scanned_jobs: count,
      jobs_truncated: v.boolean(),
      jobs: v.array(v.strictObject({ state: v.string(), reason: routingCode, count })),
      scanned_offers: count,
      offers_truncated: v.boolean(),
      offers: v.array(v.strictObject({ lane: v.string(), state: v.string(), count })),
    }),
  }),
  explain_routing: v.strictObject({
    message_id: identifier,
    received_at: v.nullable(v.string()),
    provenance: v.picklist(["live", "historical"]),
    decided_by: v.strictObject({
      kind: v.picklist([
        "plugin",
        "plugin_offer",
        "rule",
        "default",
        "rule_or_default",
        "classifier",
        "unresolved",
        "suppressed",
        "blocked",
        "not_evaluated",
      ]),
      source: v.nullable(v.picklist(["dispatch", "shadow"])),
      plugin_id: v.nullable(routingId),
      rule_id: v.nullable(routingId),
      outcome: v.nullable(v.picklist(["review", "ignore", "unresolved", "hold"])),
      category: routingCategory,
      evidence_code: routingCode,
      configuration_sha256: v.nullable(sha256),
      revision: v.nullable(count),
    }),
    shadow: v.array(
      v.strictObject({
        configuration_sha256: sha256,
        configuration: configurationLabel,
        state: v.picklist(["complete", "unreadable", "blocked"]),
        failure_code: routingCode,
        status: v.nullable(
          v.picklist(["shadow", "historical_suppressed", "invalid_metadata", "evaluation_error"]),
        ),
        rule_id: v.nullable(routingId),
        outcome: v.nullable(ruleOutcome),
        category: routingCategory,
        urgent: v.nullable(v.boolean()),
        plugin_candidates: v.array(
          v.strictObject({
            plugin_id: routingId,
            mode: v.picklist(["exclusive", "observer"]),
            manifest_version: v.string(),
          }),
        ),
        evaluated_at: isoTime,
        current: v.boolean(),
      }),
    ),
    shadow_truncated: v.boolean(),
    dispatch: v.strictObject({
      job: v.nullable(
        v.strictObject({
          state: v.string(),
          reason: routingCode,
          revision: count,
          updated_at: isoTime,
        }),
      ),
      offers: v.array(
        v.strictObject({
          lane: v.string(),
          state: v.string(),
          failure_code: routingCode,
          revision: count,
          generation: count,
          category: routingCategory,
          urgent: v.nullable(v.boolean()),
          evidence_code: routingCode,
          updated_at: isoTime,
        }),
      ),
      offers_truncated: v.boolean(),
    }),
    classifications: v.array(
      v.strictObject({
        policy_sha256: v.string(),
        state: v.string(),
        outcome: v.nullable(v.picklist(["review", "ignore", "hold"])),
        category: routingCategory,
        urgent: v.nullable(v.boolean()),
        evidence_code: routingCode,
        failure_code: routingCode,
        updated_at: isoTime,
      }),
    ),
    classifications_truncated: v.boolean(),
    rule_id_note: v.string(),
  }),
};
export const toolOutputSchemas = {
  ...routingOutputs,
  get_mail_health: v.looseObject({
    observed_at: v.string(),
    status: v.picklist(["observations_available", "partial_observations"]),
    archive_completeness: v.literal("unknown"),
    sections: v.record(v.string(), v.unknown()),
    coverage: v.record(v.string(), v.unknown()),
  }),
  search_mail_semantic: v.looseObject({
    matches: v.array(
      v.looseObject({
        message_id: identifier,
        excerpt: v.string(),
        score: v.number(),
        citation: v.record(v.string(), v.unknown()),
      }),
    ),
    next_page_token: v.null(),
    coverage: v.record(v.string(), v.unknown()),
  }),
  search_mail_content: v.looseObject({
    matches: v.array(
      v.looseObject({
        message_id: identifier,
        excerpt: v.string(),
        citation: v.record(v.string(), v.unknown()),
      }),
    ),
    next_page_token: v.nullable(v.string()),
    coverage: v.record(v.string(), v.unknown()),
  }),
  get_profile: v.looseObject({
    principal_id: v.string(),
    scopes: v.array(v.string()),
    from_addresses: v.array(v.string()),
    from_domains: v.array(v.string()),
    sender_policy: v.strictObject({
      new_mail: v.string(),
      reply_default: v.string(),
      override: v.string(),
    }),
    limits: v.record(v.string(), v.number()),
    search_coverage: v.string(),
    mail_content_trust: v.literal("untrusted_data"),
  }),
  read_email: messageOutput,
  batch_read_email: v.looseObject({
    emails: v.array(
      v.union([
        v.looseObject({ id: identifier, ok: v.literal(true), data: messageOutput }),
        v.looseObject({
          id: identifier,
          ok: v.literal(false),
          error: v.strictObject({ code: v.string() }),
        }),
      ]),
    ),
  }),
  read_email_thread: v.looseObject({
    thread_id: identifier,
    messages: v.array(messageOutput),
    truncated: v.boolean(),
    threading: v.picklist([
      "direct_message_id_header_links_only",
      "gmail_account_thread_id",
      "gmail_provenance_unavailable",
    ]),
  }),
  read_attachment: v.looseObject({
    message_id: identifier,
    attachment_id: identifier,
    filename: v.nullable(v.string()),
    mime_type: v.string(),
    size: v.number(),
    sha256: v.string(),
    file_uri: v.string(),
    content_truncated: v.literal(false),
  }),
  search_emails: searchOutput,
  search_email_ids: v.looseObject({
    message_ids: v.array(identifier),
    next_page_token: v.nullable(v.string()),
    coverage: v.record(v.string(), v.unknown()),
  }),
  preview_email: v.looseObject({
    input: inputOutput,
    policy: v.looseObject({ allowed: v.literal(true) }),
    submitted: v.literal(false),
  }),
  create_draft: draftOutput,
  get_draft: draftOutput,
  update_draft: draftOutput,
  list_drafts: v.looseObject({
    drafts: v.array(
      v.looseObject({
        draft_id: identifier,
        revision: v.number(),
        created_at: v.number(),
        updated_at: v.number(),
      }),
    ),
    next_page_token: v.nullable(v.string()),
  }),
  send_email: sendOutput,
  send_draft: sendOutput,
  forward_emails: sendOutput,
  get_send_status: sendOutput,
  upload_attachment: attachmentOutput,
  copy_attachment: attachmentOutput,
};

/** Standard Schema validation and Standard JSON Schema share the same Valibot source.
 * With `inHandler`, the tool handler validates the same schema itself so that its
 * error can carry a structured input path; the advertised JSON Schema is unchanged. */
export function bridge<T extends v.GenericSchema>(schema: T, inHandler = false) {
  const json = toStandardJsonSchema(schema);
  return {
    ...json,
    "~standard": {
      ...json["~standard"],
      validate: (input: unknown) => {
        if (inHandler) return { value: input as v.InferOutput<T> };
        const result = v.safeParse(schema, input);
        return result.success
          ? { value: result.output }
          : { issues: [{ message: "invalid_arguments" }] };
      },
    },
  };
}
