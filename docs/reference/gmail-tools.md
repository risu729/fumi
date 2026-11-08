# Gmail connector tool reference

Captured on 2026-11-08 from the Gmail tool definitions exposed to this Codex chat.
This is a reference snapshot for fumi's future mail-tool design and historical
Gmail import, not a runtime dependency or a commitment to keep Gmail forwarding.
The [roadmap](../roadmap.md) plans retirement of Gmail forwarding.

The snapshot contains all 21 visible tools, their exact descriptions, and the
TypeScript declarations exposed by the connector, including argument names,
required/optional markers, types, defaults and documented behavior. These are
connector interfaces, not the public Gmail REST API or independently retrieved
JSON Schemas. Response declarations are preserved as provided; no missing fields
or response schemas have been inferred. Tool availability and signatures can change.

No Gmail operation was invoked to collect this reference. It contains tool
metadata only, with no mailbox content, account identifiers or credentials.

## Tools

- [`apply_labels_to_emails`](#apply-labels-to-emails)
- [`archive_emails`](#archive-emails)
- [`batch_modify_email`](#batch-modify-email)
- [`batch_read_email`](#batch-read-email)
- [`batch_read_email_threads`](#batch-read-email-threads)
- [`bulk_label_matching_emails`](#bulk-label-matching-emails)
- [`create_draft`](#create-draft)
- [`create_label`](#create-label)
- [`delete_emails`](#delete-emails)
- [`forward_emails`](#forward-emails)
- [`get_profile`](#get-profile)
- [`list_drafts`](#list-drafts)
- [`list_labels`](#list-labels)
- [`read_attachment`](#read-attachment)
- [`read_email`](#read-email)
- [`read_email_thread`](#read-email-thread)
- [`search_email_ids`](#search-email-ids)
- [`search_emails`](#search-emails)
- [`send_draft`](#send-draft)
- [`send_email`](#send-email)
- [`update_draft`](#update-draft)

## Definitions

### apply labels to emails

Tool name: `mcp__codex_apps__gmail_apply_labels_to_emails`

Apply labels to Gmail messages using label names rather than Gmail label IDs. This is
the preferred labeling action for models because it avoids a separate label-id lookup
step. Prefer this when the user refers to labels by name. This tool is part of plugin
`Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_apply_labels_to_emails(args: {
  // Gmail label display names. This action accepts names and can create missing labels when create_missing_labels is true; batch_modify_email requires existing Gmail label IDs.
  add_label_names?: Array<string> | null;
  // Whether to create missing labels before applying them.
  create_missing_labels?: boolean;
  // Gmail message IDs returned by Gmail search/read results. Use `message_ids` from search_email_ids or `id` fields from email results. Do not pass placeholder values like `dummy`, `latest`, `gmail:<id>`, draft IDs, thread IDs, email addresses, subjects, or Gmail UI URLs.
  message_ids: Array<string>;
  // Gmail label display names. This action accepts names and can create missing labels when create_missing_labels is true; batch_modify_email requires existing Gmail label IDs.
  remove_label_names?: Array<string> | null;
}): Promise<CallToolResult>; };
```

### archive emails

Tool name: `mcp__codex_apps__gmail_archive_emails`

Archive Gmail threads while keeping their messages available in Gmail. The INBOX label
is removed from every message currently in each thread, so the thread disappears from
the inbox. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_archive_emails(args: {
  // Gmail thread IDs to archive. Empty and duplicate IDs are ignored. At most 100 distinct threads may be archived.
  thread_ids: Array<string>;
}): Promise<CallToolResult>; };
```

### batch modify email

Tool name: `mcp__codex_apps__gmail_batch_modify_email`

Add or remove Gmail labels on a batch of individual messages. This modifies messages,
not whole threads. To label by subject, sender, or search query, search first or use
bulk_label_matching_emails/apply_labels_to_emails. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_batch_modify_email(args: {
  // Existing Gmail label IDs to add, not label display names. Mutable system label IDs include INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, and the CATEGORY_* labels. Gmail assigns SENT and DRAFT; they cannot be added or removed. For user labels, copy list_labels.labels[].id. Prefer apply_labels_to_emails when you have label names or want missing labels created. Do not pass search operators such as -in:trash, ALL, or display names.
  add_labels?: Array<string> | null;
  // Gmail message IDs returned by Gmail search/read results. Use `message_ids` from search_email_ids or `id` fields from email results. Do not pass placeholder values like `dummy`, `latest`, `gmail:<id>`, draft IDs, thread IDs, email addresses, subjects, or Gmail UI URLs.
  message_ids: Array<string>;
  // Existing Gmail label IDs to remove, not label display names. Mutable system label IDs include INBOX, UNREAD, STARRED, IMPORTANT, SPAM, TRASH, and the CATEGORY_* labels. Gmail assigns SENT and DRAFT; they cannot be added or removed. For user labels, copy list_labels.labels[].id. Prefer apply_labels_to_emails when you have label names. Do not pass search operators such as -in:trash, ALL, or display names.
  remove_labels?: Array<string> | null;
}): Promise<CallToolResult>; };
```

### batch read email

Tool name: `mcp__codex_apps__gmail_batch_read_email`

Read up to 100 Gmail messages as MIME trees, preserving request order. Later IDs are
ignored. The action fails if the combined serialized response exceeds 100 MB. This tool
is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_batch_read_email(args: {
  // Gmail message IDs to fetch, in order. At most 100 are read; later entries are ignored.
  message_ids: Array<string>;
}): Promise<CallToolResult>; };
```

### batch read email threads

Tool name: `mcp__codex_apps__gmail_batch_read_email_threads`

Read recent messages from threads identified by message IDs or thread IDs. Supply at
least one non-empty `message_ids` or `thread_ids` list; `message_ids` take precedence
when both are supplied. Exact duplicate input IDs and duplicate resolved thread IDs are
coalesced, preserving the first occurrence. Each thread contains at most `max_messages`
messages, ordered from oldest to newest. Later IDs are ignored. The action fails if the
combined serialized response exceeds 100 MB. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_batch_read_email_threads(args: {
  // Optional maximum number of messages to include per thread; defaults to 20.
  max_messages?: number;
  // Gmail message IDs whose conversations should be read. Supply message_ids or thread_ids; message_ids take precedence when both are supplied. At most 100 are read.
  message_ids?: Array<string> | null;
  // Gmail thread IDs to read directly. Supply message_ids or thread_ids; message_ids take precedence when both are supplied. At most 100 are read.
  thread_ids?: Array<string> | null;
}): Promise<CallToolResult>; };
```

### bulk label matching emails

Tool name: `mcp__codex_apps__gmail_bulk_label_matching_emails`

Apply a label to every Gmail message matching a Gmail search query. This action performs
the search and label batching server-side, so it is suitable for very large backfills
without sending message IDs through the model context. This tool is part of plugin
`Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_bulk_label_matching_emails(args: {
  // Whether to archive matching messages after labeling them.
  archive?: boolean;
  // Whether to create the label first if it does not already exist.
  create_label_if_missing?: boolean;
  // Label name to apply to all matching messages.
  label_name: string;
  // Gmail search query used to find messages to label.
  query: string;
}): Promise<CallToolResult>; };
```

### create draft

Tool name: `mcp__codex_apps__gmail_create_draft`

Create an unsent Gmail draft from message headers and a MIME tree. Prefer `text/html` by
default, even for simple messages; use `text/plain` when the user requests plain text.
This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_create_draft(args: { bcc?: string; cc?: string; classification_label_values?: Array<{ fields?: Array<{ field_id: string; selection?: string | null; }> | null; label_id: string; }> | null; from_address?: string | null; payload: { body?: { base64_url_content?: string | null; content?: string | null; } | null; charset?: string | null; content_disposition?: "inline" | "attachment" | null; content_id?: string | null; filename?: string | null; mime_type: string; parts?: Array<{ body?: { base64_url_content?: string | null; content?: string | null; } | null; charset?: string | null; content_disposition?: "inline" | "attachment" | null; content_id?: string | null; filename?: string | null; mime_type: string; parts?: Array<{ body?: { base64_url_content?: string | null; content?: string | null; } | null; charset?: string | null; content_disposition?: "inline" | "attachment" | null; content_id?: string | null; filename?: string | null; mime_type: string; parts?: Array<unknown> | null; }> | null; }> | null; }; reply_message_id?: string | null; reply_to?: string | null; response_fields?: Array<"id" | "message"> | null; subject: string; to?: string; }): Promise<CallToolResult>; };
```

### create label

Tool name: `mcp__codex_apps__gmail_create_label`

Create a Gmail label. Use this when the user wants a new organizational label. If the
label already exists, the existing label is returned instead of creating a duplicate.
This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_create_label(args: {
  // Visibility of the label itself in Gmail label lists.
  label_list_visibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  // Visibility of messages carrying this label in Gmail message lists.
  message_list_visibility?: "show" | "hide";
  // Name of the Gmail label to create.
  name: string;
}): Promise<CallToolResult>; };
```

### delete emails

Tool name: `mcp__codex_apps__gmail_delete_emails`

Move one or more existing Gmail messages to Trash. Use this when the user wants messages
deleted from Gmail. This matches Gmail delete behavior and does not permanently delete
the messages. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_delete_emails(args: {
  // Gmail message IDs returned by Gmail search/read results. Use `message_ids` from search_email_ids or `id` fields from email results. Do not pass placeholder values like `dummy`, `latest`, `gmail:<id>`, draft IDs, thread IDs, email addresses, subjects, or Gmail UI URLs.
  message_ids: Array<string>;
}): Promise<CallToolResult>; };
```

### forward emails

Tool name: `mcp__codex_apps__gmail_forward_emails`

Forward Gmail messages with structured MIME content. Each source is sent separately as a
`message/rfc822` attachment so its original MIME content and attachments are preserved.
Optional `payload` content appears before that attachment and is not parsed as Markdown.
This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_forward_emails(args: {
  // Optional comma-separated email addresses for the Bcc header.
  bcc?: string;
  // Optional comma-separated email addresses for the Cc header.
  cc?: string;
  // Gmail message IDs to forward. Empty and duplicate IDs are ignored. At most 10 distinct messages may be forwarded.
  message_ids: Array<string>;
  // Optional MIME content to include before each forwarded message.
  payload?: {
  // Optional body for a leaf MIME part. Set exactly one of `base64_url_content` or `content`. Omit `body` for an empty part.
  body?: {
  // Optional base64url-encoded body bytes for binary content such as images and attachments, or for any content whose exact bytes must be preserved. Set exactly one of `base64_url_content` or `content`.
  base64_url_content?: string | null;
  // Optional unencoded text for a `text/*` MIME part, such as `text/plain` or `text/html`. It is encoded with the part's `charset`, which defaults to UTF-8. Set exactly one of `content` or `base64_url_content`.
  content?: string | null;
} | null;
  // Optional character encoding for a `text/*` part. Direct `content` defaults to UTF-8. Do not set this field on a non-text part.
  charset?: string | null;
  // Optional Content-Disposition value: `inline` or `attachment`. A part with a filename defaults to `inline` when `content_id` is set and `attachment` otherwise.
  content_disposition?: "inline" | "attachment" | null;
  // Optional Content ID referenced by `cid:` URLs. Supply the ID without angle brackets. The resulting Content-ID header encloses it in angle brackets.
  content_id?: string | null;
  // Optional filename to include in this part's Content-Disposition header.
  filename?: string | null;
  // MIME media type for this part, such as `text/plain` or `image/png`.
  mime_type: string;
  // Optional child parts for a `multipart/*` container. Do not combine `parts` with `body`, `filename`, `content_id`, or `content_disposition`.
  parts?: Array<{
  // Optional body for a leaf MIME part. Set exactly one of `base64_url_content` or `content`. Omit `body` for an empty part.
  body?: {
  // Optional base64url-encoded body bytes for binary content such as images and attachments, or for any content whose exact bytes must be preserved. Set exactly one of `base64_url_content` or `content`.
  base64_url_content?: string | null;
  // Optional unencoded text for a `text/*` MIME part, such as `text/plain` or `text/html`. It is encoded with the part's `charset`, which defaults to UTF-8. Set exactly one of `content` or `base64_url_content`.
  content?: string | null;
} | null;
  // Optional character encoding for a `text/*` part. Direct `content` defaults to UTF-8. Do not set this field on a non-text part.
  charset?: string | null;
  // Optional Content-Disposition value: `inline` or `attachment`. A part with a filename defaults to `inline` when `content_id` is set and `attachment` otherwise.
  content_disposition?: "inline" | "attachment" | null;
  // Optional Content ID referenced by `cid:` URLs. Supply the ID without angle brackets. The resulting Content-ID header encloses it in angle brackets.
  content_id?: string | null;
  // Optional filename to include in this part's Content-Disposition header.
  filename?: string | null;
  // MIME media type for this part, such as `text/plain` or `image/png`.
  mime_type: string;
  // Optional child parts for a `multipart/*` container. Do not combine `parts` with `body`, `filename`, `content_id`, or `content_disposition`.
  parts?: Array<unknown> | null;
}> | null;
} | null;
  // Optional message properties to include in the response. Values use the connector's snake_case output property names. Omit this parameter to return the standard response. The local `original_message_id` and per-message error properties are always returned.
  response_fields?: Array<"id" | "thread_id" | "label_ids" | "snippet" | "history_id" | "internal_date" | "payload" | "size_estimate" | "classification_label_values"> | null;
  // Comma-separated email addresses for the To header. Use `me` for the authenticated Gmail account.
  to: string;
}): Promise<CallToolResult>; };
```

### get profile

Tool name: `mcp__codex_apps__gmail_get_profile`

Return the current Gmail user's profile information. This tool is part of plugin
`Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_get_profile(args: { [key: string]: unknown; }): Promise<CallToolResult>; };
```

### list drafts

Tool name: `mcp__codex_apps__gmail_list_drafts`

List Gmail drafts with summarized metadata so they can be reviewed or selected. Use this
to review pending drafts or find a draft the user asked about. This tool is part of
plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_list_drafts(args: {
  // Maximum number of results to return. Must be at least 1.
  max_results?: number;
  // Pagination token from a previous drafts list.
  next_page_token?: string;
}): Promise<CallToolResult>; };
```

### list labels

Tool name: `mcp__codex_apps__gmail_list_labels`

List Gmail labels with per-label counts. Use this for questions like how many emails are
in the inbox or unread, because Gmail exposes those totals directly on labels without
paging through messages. For unread counts within a specific label, request that label
and use its unread totals rather than requesting UNREAD. For search label filters, copy
labels[].id, not labels[].name. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_list_labels(args: {
  // Optional Gmail label display names to filter by. For search label filters, copy labels[].id from the response, not labels[].name.
  label_names?: Array<string> | null;
}): Promise<CallToolResult>; };
```

### read attachment

Tool name: `mcp__codex_apps__gmail_read_attachment`

Read one attachment from a Gmail message. First read/search the parent message and
select an entry from its attachments, inline_images, or API-content MIME parts. For an
attachments entry or downloadable MIME part, call this action only when its
read_attachment_supported field is true; when false, do not call this action because the
MIME type is unsupported. Pass the parent message id as message_id. Prefer the entry's
non-null attachment_id or MIME part's body.attachment_id when its complete value is
available; when it is absent or marked truncated, pass the exact filename instead. Do
not synthesize attachment IDs from filenames, content IDs, x-attachment IDs, URLs, or
user text. The original attachment is returned as file_uri. Small extracted content and
images are included inline. If content_truncated is true, the inline text is only a
preview; read extraction_file_uri for the complete extracted content and images as JSON.
This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_read_attachment(args: {
  // Exact Gmail attachment_id copied from the selected attachment's attachments[].attachment_id or inline_images[].attachment_id, or from a downloadable API-content MIME part's body.attachment_id. Use it only when the complete value is available; if it is absent or marked truncated in a tool response, pass the exact filename instead. Do not pass truncated values, filenames, message IDs, thread IDs, Content-ID, X-Attachment-Id, URLs, or guessed values.
  attachment_id?: string;
  // Exact attachment filename from the parent message's attachments, inline_images, or API-content MIME parts. Use only when attachment_id is absent, unknown, or marked truncated in the tool response. If multiple attachments share this filename, retry with a complete attachment_id.
  filename?: string;
  // Gmail message ID returned by Gmail search/read results. Use the `id` or `message_id` field from an email result. Do not pass placeholder values like `dummy`, `latest`, `gmail:<id>`, draft IDs, thread IDs, email addresses, subjects, or Gmail UI URLs. Use the parent message ID.
  message_id: string;
}): Promise<CallToolResult>; };
```

### read email

Tool name: `mcp__codex_apps__gmail_read_email`

Read one Gmail message in the requested Gmail API representation. In `full` format, text
MIME bodies are returned in `content`, non-text body bytes are returned in
`base64_url_content`, and an `attachment_id` identifies content that must be fetched
separately. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_read_email(args: {
  // Gmail response representation. `full` returns headers and parsed MIME parts; `minimal` omits headers and body content; `metadata` returns headers without body content; `raw` returns a base64url-encoded RFC 2822 message.
  format?: "full" | "minimal" | "metadata" | "raw";
  // Immutable Gmail message ID returned by the Gmail API.
  message_id: string;
}): Promise<CallToolResult>; };
```

### read email thread

Tool name: `mcp__codex_apps__gmail_read_email_thread`

Read the most recent messages in a Gmail thread as headers and MIME parts. Supply at
least one of `message_id` or `thread_id`; when both are supplied, `message_id` takes
precedence. The response contains at most `max_messages` messages, ordered from oldest
to newest. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_read_email_thread(args: {
  // Optional maximum number of messages to include from the thread; defaults to 20.
  max_messages?: number;
  // Gmail message ID whose conversation should be read. Supply message_id or thread_id; message_id takes precedence when both are supplied.
  message_id?: string | null;
  // Gmail thread ID to read directly. Supply message_id or thread_id; message_id takes precedence when both are supplied.
  thread_id?: string | null;
}): Promise<CallToolResult>; };
```

### search email ids

Tool name: `mcp__codex_apps__gmail_search_email_ids`

Retrieve Gmail message IDs that match a search. If the user asks for important emails,
search likely candidates and read/interpret them instead of treating Gmail system labels
as the answer. Prefer list_labels for label counts. Put Gmail search operators in query,
not label_ids. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_search_email_ids(args: {
  // Optional Gmail label IDs, not Gmail search operators and not display names. Use exact system label IDs such as INBOX, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, SPAM, TRASH, CHAT, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, and CATEGORY_FORUMS. For user labels, use the account-specific ID returned in list_labels.labels[].id. Put Gmail search syntax such as -in:spam, -in:trash, -category:promotions, label:Newsletters, category:promotions, newer_than:7d, or from:alice@example.com in query. Do not pass ALL, label display names like Newsletters, or custom names like DA/30 Waiting - Cody unless list_labels returned that exact value as id.
  label_ids?: Array<string> | null;
  // Maximum number of results to return. Must be at least 1.
  max_results?: number;
  // Pagination token from a previous search.
  next_page_token?: string;
  // Gmail search query. Put Gmail search operators here, including -in:spam, -in:trash, -category:promotions, category:promotions, label:<display name>, from:, to:, after:, before:, newer_than:, and has:attachment.
  query?: string;
}): Promise<CallToolResult>; };
```

### search emails

Tool name: `mcp__codex_apps__gmail_search_emails`

Search Gmail for emails matching a query or exact label IDs. If the user asks for
important emails, search likely candidates and read/interpret them instead of treating
Gmail system labels as the answer. Prefer list_labels for count questions about inbox,
unread, or other label totals. Put all Gmail search operators in query, including
after:, before:, from:, to:, subject:, has:attachment, -in:spam, -in:trash,
-category:promotions, and label:<display name>. Examples: query="-in:spam -in:trash",
label_ids=None; query="", label_ids=["INBOX", "UNREAD"]; query="label:Newsletters
newer_than:30d", label_ids=None. Non-examples: label_ids=["-in:spam"],
label_ids=["ALL"], label_ids=["Newsletters"]. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_search_emails(args: {
  // Optional Gmail label IDs, not Gmail search operators and not display names. Use exact system label IDs such as INBOX, UNREAD, STARRED, IMPORTANT, SENT, DRAFT, SPAM, TRASH, CHAT, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, and CATEGORY_FORUMS. For user labels, use the account-specific ID returned in list_labels.labels[].id. Put Gmail search syntax such as -in:spam, -in:trash, -category:promotions, label:Newsletters, category:promotions, newer_than:7d, or from:alice@example.com in query. Do not pass ALL, label display names like Newsletters, or custom names like DA/30 Waiting - Cody unless list_labels returned that exact value as id.
  label_ids?: Array<string> | null;
  // Maximum number of results to return. Must be at least 1.
  max_results?: number;
  // Pagination token from a previous search.
  next_page_token?: string;
  // Gmail search query. Put Gmail search operators here, including -in:spam, -in:trash, -category:promotions, category:promotions, label:<display name>, from:, to:, after:, before:, newer_than:, and has:attachment.
  query?: string;
}): Promise<CallToolResult>; };
```

### send draft

Tool name: `mcp__codex_apps__gmail_send_draft`

Send an existing Gmail draft as currently stored. Use this only after the user has
reviewed the saved draft or explicitly asked to send that draft. This tool is part of
plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_send_draft(args: {
  // Gmail draft ID returned by create_draft, update_draft, or list_drafts as `draft_id`. Do not pass the draft's underlying message_id, thread_id, subject, recipient email, placeholder values, or Gmail UI URLs.
  draft_id: string;
}): Promise<CallToolResult>; };
```

### send email

Tool name: `mcp__codex_apps__gmail_send_email`

Send a Gmail message now from the authenticated account. Supply message headers and a
MIME tree. Set `to` to `me` to send to the authenticated Gmail account. Use
`create_draft` if the user should review the message first. Prefer `text/html` by
default, even for simple messages; use `text/plain` when the user requests plain text.
This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_send_email(args: { bcc?: string; cc?: string; classification_label_values?: Array<{ fields?: Array<{ field_id: string; selection?: string | null; }> | null; label_id: string; }> | null; from_address?: string | null; payload: { body?: { base64_url_content?: string | null; content?: string | null; } | null; charset?: string | null; content_disposition?: "inline" | "attachment" | null; content_id?: string | null; filename?: string | null; mime_type: string; parts?: Array<{ body?: { base64_url_content?: string | null; content?: string | null; } | null; charset?: string | null; content_disposition?: "inline" | "attachment" | null; content_id?: string | null; filename?: string | null; mime_type: string; parts?: Array<{ body?: { base64_url_content?: string | null; content?: string | null; } | null; charset?: string | null; content_disposition?: "inline" | "attachment" | null; content_id?: string | null; filename?: string | null; mime_type: string; parts?: Array<unknown> | null; }> | null; }> | null; }; reply_message_id?: string | null; reply_to?: string | null; response_fields?: Array<"id" | "thread_id" | "label_ids" | "snippet" | "history_id" | "internal_date" | "payload" | "size_estimate" | "classification_label_values"> | null; subject: string; to: string; }): Promise<CallToolResult>; };
```

### update draft

Tool name: `mcp__codex_apps__gmail_update_draft`

Patch selected fields in an existing Gmail draft. This action has sparse patch
semantics: omitted or null fields preserve the current draft. An empty string clears a
supplied header. Omitting `payload` preserves the complete MIME tree, including
attachments; supplying `payload` replaces that MIME tree. When replacing `payload`,
prefer `text/html` by default, even for simple messages; use `text/plain` when the user
requests plain text. This tool is part of plugin `Gmail`.

Gmail tools for label counts, searching and reading emails/threads/attachments,
reviewing drafts, and explicit mail changes like send, draft, forward, archive, Trash,
and label actions.

exec tool declaration:

```ts
declare const tools: { mcp__codex_apps__gmail_update_draft(args: {
  // Replacement Bcc header; omit to preserve it or set an empty string to clear it.
  bcc?: string | null;
  // Replacement Cc header; omit to preserve it or set an empty string to clear it.
  cc?: string | null;
  // Replacement classification labels; omit to preserve them or set an empty list to clear them.
  classification_label_values?: Array<{
  // Optional values for fields defined by the classification label schema.
  fields?: Array<{
  // Organization-specific field ID from a Workspace classification label schema.
  field_id: string;
  // Optional organization-specific choice ID from the classification label schema. Set this only for a selection field.
  selection?: string | null;
}> | null;
  // Organization-specific Google Workspace classification label ID. This is not a Gmail mailbox label ID such as INBOX.
  label_id: string;
}> | null;
  // ID of the Gmail draft to patch.
  draft_id: string;
  // Replacement From header; omit to preserve it or set an empty string to clear it.
  from_address?: string | null;
  // Replacement root MIME part; omit it to preserve the current MIME tree and its attachments. When replacing, include any quoted history you want to keep; update_draft does not append quotes.
  payload?: {
  // Optional body for a leaf MIME part. Set exactly one of `base64_url_content` or `content`. Omit `body` for an empty part.
  body?: {
  // Optional base64url-encoded body bytes for binary content such as images and attachments, or for any content whose exact bytes must be preserved. Set exactly one of `base64_url_content` or `content`.
  base64_url_content?: string | null;
  // Optional unencoded text for a `text/*` MIME part, such as `text/plain` or `text/html`. It is encoded with the part's `charset`, which defaults to UTF-8. Set exactly one of `content` or `base64_url_content`.
  content?: string | null;
} | null;
  // Optional character encoding for a `text/*` part. Direct `content` defaults to UTF-8. Do not set this field on a non-text part.
  charset?: string | null;
  // Optional Content-Disposition value: `inline` or `attachment`. A part with a filename defaults to `inline` when `content_id` is set and `attachment` otherwise.
  content_disposition?: "inline" | "attachment" | null;
  // Optional Content ID referenced by `cid:` URLs. Supply the ID without angle brackets. The resulting Content-ID header encloses it in angle brackets.
  content_id?: string | null;
  // Optional filename to include in this part's Content-Disposition header.
  filename?: string | null;
  // MIME media type for this part, such as `text/plain` or `image/png`.
  mime_type: string;
  // Optional child parts for a `multipart/*` container. Do not combine `parts` with `body`, `filename`, `content_id`, or `content_disposition`.
  parts?: Array<{
  // Optional body for a leaf MIME part. Set exactly one of `base64_url_content` or `content`. Omit `body` for an empty part.
  body?: {
  // Optional base64url-encoded body bytes for binary content such as images and attachments, or for any content whose exact bytes must be preserved. Set exactly one of `base64_url_content` or `content`.
  base64_url_content?: string | null;
  // Optional unencoded text for a `text/*` MIME part, such as `text/plain` or `text/html`. It is encoded with the part's `charset`, which defaults to UTF-8. Set exactly one of `content` or `base64_url_content`.
  content?: string | null;
} | null;
  // Optional character encoding for a `text/*` part. Direct `content` defaults to UTF-8. Do not set this field on a non-text part.
  charset?: string | null;
  // Optional Content-Disposition value: `inline` or `attachment`. A part with a filename defaults to `inline` when `content_id` is set and `attachment` otherwise.
  content_disposition?: "inline" | "attachment" | null;
  // Optional Content ID referenced by `cid:` URLs. Supply the ID without angle brackets. The resulting Content-ID header encloses it in angle brackets.
  content_id?: string | null;
  // Optional filename to include in this part's Content-Disposition header.
  filename?: string | null;
  // MIME media type for this part, such as `text/plain` or `image/png`.
  mime_type: string;
  // Optional child parts for a `multipart/*` container. Do not combine `parts` with `body`, `filename`, `content_id`, or `content_disposition`.
  parts?: Array<unknown> | null;
}> | null;
} | null;
  // Optional Gmail message ID whose reply context replaces the draft's.
  reply_message_id?: string | null;
  // Replacement Reply-To header; omit to preserve it or set an empty string to clear it.
  reply_to?: string | null;
  // Optional top-level draft properties to include in the response. Values use the connector's output property names. Omit this parameter to return the standard response.
  response_fields?: Array<"id" | "message"> | null;
  // Replacement Subject header; omit to preserve it or set an empty string to clear it.
  subject?: string | null;
  // Replacement To header; omit to preserve it or set an empty string to clear it.
  to?: string | null;
}): Promise<CallToolResult>; };
```
