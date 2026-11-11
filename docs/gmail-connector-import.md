# Import from an already connected Gmail account

The optional connector transport reuses the existing resumable historical importer
when a trusted administrator already has a connected Gmail tool that can return
exact RFC 2822 raw bytes and provider metadata. It does not extract or reuse the
connector's OAuth credentials. The direct read-only OAuth transport remains
available for unattended higher-volume imports.

The administrator first reads the connector account profile, verifies the expected
account and freezes the historical interval. Each list must include SENT, use the
same date bounds and explicit Spam/Trash treatment, and request at most ten IDs.
Read every selected message in raw format; decode its base64url once into the exact
bytes without rebuilding MIME from parsed bodies or attachments. Preserve provider
message ID, thread ID, internal date and labels separately.

Only the administrator can write the fixed private staging prefix
`imports/gmail-connector-v1/<importId>/`. Staging is not an HTTP upload route, MCP
mail tool or write capability granted to messages. Its account hash is a trusted
operator attestation, not an independent Google authentication proof. The operator
must verify the connector profile again after reconnection/account switching.

## Staged objects

| Object | Content |
| --- | --- |
| `raw/<messageId>/<sha256>.eml` | Exact raw bytes, at most 25 MiB |
| `messages/<messageId>.json` | `schemaVersion: 1`, `accountHash`, `id`, `threadId`, `internalDate`, `labelIds`, `rawSize`, `rawSha256` |
| `pages/<cursorHash>.json` | `schemaVersion: 1`, `accountHash`, `scope`, `pageToken`, `messageIds`, `nextPageToken` |

`cursorHash` is SHA-256 of UTF-8 `JSON.stringify(pageToken)`; the first token is
`null`. Scope is the exact configured `accountNamespace`, `before`, optional
`after`, and `includeSpamTrash`. Account hash is SHA-256 of the trimmed lowercase
profile email address. Message IDs are constrained to the existing provider ID
alphabet; no staged input can supply an object path or URL. A terminal page has
`nextPageToken: null`; an empty nonterminal page is rejected.

Write raw objects first, metadata second and the page manifest last. Use
conditional writes and compare bytes/digests if an object already exists rather
than replacing a staged snapshot. Page manifests must preserve the original
connector cursor. Never invent a completion marker after an incomplete listing.

Set private `GMAIL_IMPORT_CONFIG` to the existing import configuration with
`transport: "connector"`. It requires `importId`, `expectedAccountHash`, and
`scope`, but no `GMAIL_IMPORT_ACCESS_TOKEN`. The existing authenticated
`mail:import` start/status/page routes remain unchanged. They accept no caller
query, object key, account identity, raw payload or credential.

Before committing a source, the transport verifies the account/scope/cursor,
metadata bounds, original size and computed SHA-256. Date bounds, provider
identity, immutable archive provenance, account leases and checkpoint advancement
remain enforced by the existing importer. Missing or conflicting staged content
stops the page without discarding its pending IDs. Historical mail never forwards
or produces live notifications.

## Operational acceptance

Compare scoped provider IDs against durable import items, replay the frozen
interval independently, and verify downloaded originals by byte hash. Import
completion, MIME extraction and search/OCR coverage are separate. The connector
list is not a transactional mailbox snapshot. Deleted messages and invalid cursors
remain explicit gaps rather than silently skipped records.

Keep staging until archive and migration acceptance are verified. Its eventual
cleanup is separate from preservation of immutable originals and requires an
explicit retention decision. Synthetic transport tests do not prove a real Gmail
copy, account identity or migration completeness.
