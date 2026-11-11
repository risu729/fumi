import * as v from "valibot";
import { toStandardJsonSchema } from "@valibot/to-json-schema";

export const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(200));
const shortText = v.pipe(v.string(), v.maxLength(1000));
const address = v.pipe(v.string(), v.minLength(3), v.maxLength(254));
const addresses = v.pipe(v.array(address), v.maxLength(50));
const boundedBody = v.pipe(v.string(), v.maxLength(100_000));
const page = {
  max_results: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)), 20),
  next_page_token: v.optional(v.pipe(v.string(), v.maxLength(8192))),
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
  reply_to: v.optional(address),
};
export const mailInputSchema = v.strictObject(mailInputEntries);
export const toolSchemas = {
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
  search_emails: v.strictObject({
    ...page,
    query: v.optional(shortText),
    label_ids: v.optional(
      v.nullable(v.pipe(v.array(v.picklist(["INBOX", "SENT"])), v.maxLength(1))),
    ),
  }),
  search_email_ids: v.strictObject({
    ...page,
    query: v.optional(shortText),
    label_ids: v.optional(
      v.nullable(v.pipe(v.array(v.picklist(["INBOX", "SENT"])), v.maxLength(1))),
    ),
  }),
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
    reply_to: v.optional(address),
  }),
  send_email: v.strictObject({ ...mailInputEntries, idempotency_key: identifier }),
  send_draft: v.strictObject({
    draft_id: identifier,
    expected_revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    idempotency_key: identifier,
  }),
  forward_emails: v.strictObject({
    ...mailInputEntries,
    message_id: identifier,
    idempotency_key: identifier,
  }),
  get_send_status: v.strictObject({ operation_id: identifier }),
  upload_attachment: v.strictObject({
    filename: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    content_type: v.pipe(v.string(), v.maxLength(100)),
    content_base64: v.pipe(v.string(), v.maxLength(1_398_104)),
  }),
  copy_attachment: v.strictObject({
    message_id: identifier,
    attachment_id: v.pipe(v.string(), v.regex(/^part_(0|[1-9][0-9]?)$/)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
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
export const toolOutputSchemas = {
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
    threading: v.literal("direct_message_id_header_links_only"),
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

/** Standard Schema validation and Standard JSON Schema share the same Valibot source. */
export function bridge<T extends v.GenericSchema>(schema: T) {
  const json = toStandardJsonSchema(schema);
  return {
    ...json,
    "~standard": {
      ...json["~standard"],
      validate: (input: unknown) => {
        const result = v.safeParse(schema, input);
        return result.success
          ? { value: result.output }
          : { issues: [{ message: "invalid_arguments" }] };
      },
    },
  };
}
