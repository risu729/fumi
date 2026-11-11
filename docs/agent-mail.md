# Agent mail API

Status: implemented with synthetic Workers tests, 2026-11-11. Production sender
domain onboarding, Access configuration, Queue subscriptions and actual delivery
acceptance are separate rollout steps. No UI is required.

## Authentication and sender policy

`/mcp` is a stateless Streamable HTTP MCP endpoint. `/api/mail/*` downloads use
the same authentication. Cloudflare Access must front both paths. The Worker
verifies the RS256 assertion signature, issuer, application audience and expiry;
it never accepts an identity from mail or request arguments. Configure Access
Managed OAuth separately for clients that need OAuth discovery and login.

Server secrets:

| Name | Value |
| --- | --- |
| `ACCESS_ISSUER` | Exact `https://<team>.cloudflareaccess.com` issuer |
| `ACCESS_AUDIENCE` | The Access application's audience |
| `API_ORIGIN` | Exact HTTPS origin, without a trailing slash |
| `MAIL_GRANTS` | JSON object from principal IDs to grants |
| `WEBHOOK_ORIGINS` | JSON array of administrator-trusted exact HTTPS origins |

Principal IDs are `user:<verified sub>` or `service:<verified common_name>`.
An unlisted principal has no access. Grants contain `scopes`, `fromAddresses`
and optional `fromDomains`; every field is validated. The four scopes are
`mail:read`, `mail:draft`, `mail:send` and `mail:events`. A domain grant permits
any local part at that exact domain, without permitting its subdomains or
unrelated addresses. The provider must also have verified the sending domain.

This is a single-owner inbound archive: `mail:read` permits all inbound records.
Drafts, staged attachments, outgoing records and outbound notifications remain
principal-owned. Scope checks run on the server even if a caller bypasses tool
discovery. Missing or malformed grants fail closed. Requests and downloads are
uncacheable; HTML is downloaded as opaque content and never rendered.

For replies, omitting `from_address` selects the original SMTP envelope
recipient recorded by Fumi. Header `To` cannot choose this default. Explicit
`from_address` overrides it within the caller's configured sender policy.
New messages require an explicit sender. Recipients are always explicit;
replying never infers reply-all or adds an archive CC/BCC.

## Tools and bounded results

| Tools | Contract |
| --- | --- |
| `get_profile` | Scopes, sender addresses/domains, limits and coverage |
| `search_emails`, `search_email_ids` | Bounded pages, opaque continuation token |
| `read_email`, `batch_read_email` | Full, metadata, minimal or raw; per-item batch errors |
| `read_email_thread` | Direct Message-ID/In-Reply-To links, explicit truncation |
| `read_attachment` | Parent message plus attachment ID; authenticated download |
| `preview_email` | Validate without sending |
| `upload_attachment`, `copy_attachment` | Stage new bytes or copy a verified archived part |
| `create_draft`, `get_draft`, `list_drafts`, `update_draft` | Owner isolation and revision checks |
| `send_email`, `send_draft`, `forward_emails` | Explicit content and stable idempotency key |
| `get_send_status` | Submission state plus per-recipient delivery evidence |

Schemas are generated from Valibot through Standard Schema and Standard JSON
Schema. Results include structured data and machine-readable error codes.
Mail, headers, attachment filenames and HTML are untrusted data. Tool annotations
are client hints, not authorization.

Inbound search supports AND combinations of `from:`, `to:`, `subject:`,
`after:YYYY-MM-DD` (inclusive), `before:YYYY-MM-DD` (exclusive) and
`has:attachment`. Quote values containing spaces. It searches extracted metadata,
not full bodies or attachments. `INBOX` denotes the inbound catalog. `SENT`
lists the caller's outgoing operation records and accepts only an empty query.
Other Gmail syntax is rejected. Pending/blocked extraction is reported explicitly.
Thread links are direct header hints, not a complete conversation model.

Search pages contain at most 50 records; batches contain at most ten messages;
thread reads contain at most 20. Bodies inline at most 16,000 characters per
representation, with authenticated full-content links when truncated. Attachments
use descriptors rather than embedding arbitrary bytes in model context. Uploads
are limited to 1 MiB each, eight attachments and 4 MiB total per send.

## Sending and recovery

The native `EMAIL` binding is used only after immutable R2 input persistence,
D1 operation creation and a compare-and-swap submission claim. The operation
identity is scoped to the principal and idempotency key. Reusing a key with
different normalized input is a conflict. Concurrent identical requests share
one operation. Draft sends check `expected_revision` before creating the operation.

Submission states are `prepared`, `submitting`, `accepted`, `rejected` and
`unknown`. Provider acceptance does not mean delivery. An ambiguous call is
never automatically resubmitted; repeating the identical key returns existing
evidence. Never use a new key to resolve an unknown outcome. Keep draft revisions
and attachment hashes stable across retries.

The sent archive contains validated submitted content and provider receipts,
not a claim to reproduce the provider's final SMTP wire bytes. Original inbound
MIME remains separate. `raw` on a sent record is explicitly unavailable.

Only the `fumi-delivery-events` Queue handler accepts provider delivery events;
there is no public HTTP receipt endpoint. Events are retained before projection,
deduplicated by provider event ID and reconciled when the provider message ID
becomes known. Deferred events cannot overwrite terminal recipient outcomes;
mixed recipient outcomes remain separate. Failed processing retries through the
Queue and eventually uses `fumi-delivery-events-dlq`. Scheduled reconciliation
updates evidence and never sends mail.

## MCP Events

`events/list`, `events/subscribe` and `events/unsubscribe` are protocol methods,
not tools. Supported events are `email.received`, `email.ready`,
`email.processing_failed`, `email.send_status_changed` and
`email.delivery_status_changed`. Notifications contain IDs and status only;
clients retrieve content through authorized tools. Filters currently support
one `ingestId` for inbound or one `operationId` for outbound events. Broader
sender, recipient, thread and status filters are not implemented.

Live ingress marks its raw object for notifications. Historical/unmarked
objects do not emit new-mail notifications, including during catalog recovery.
Lifecycle state and event rows commit atomically; replayed workflow steps do
not create duplicate event IDs.

Subscriptions require `mail:events` plus the event's read/send scope. Callback
verification and delivery use Standard Webhooks signatures; subscriptions default
to 24 hours and are owner-bound. Requested `ttlMs` is bounded to one minute through
24 hours; `null` still receives a finite 24-hour grant. Rotation signs with both
keys for five minutes. Unsubscribe accepts the original event name, arguments
and webhook URL. Refresh supports replay from an acknowledged
subscription cursor, never skipping pending events. Delivery is at least once:
receivers must deduplicate `eventId`. Only successful HTTP acknowledgement moves
the cursor. HTTP 410, excessive retries, expiry or lost authorization stops delivery.

The five-minute scheduled handler processes a bounded set of subscriptions, one
pending event per selected subscription. This is not an immediate notification
latency guarantee. No arbitrary callback hosts are accepted: configure only
administrator-trusted origins in `WEBHOOK_ORIGINS`. Workers fetch cannot pin DNS
answers while retaining TLS SNI, so this adapter explicitly trusts those origins'
DNS administration. Redirects are refused on verification and delivery.

## Activation checklist

Follow the [activation runbook](mail-activation.md) for targeted Queue and
subscription commands, the protected hostname and owner login.

Apply D1 migrations before activating new code. Verify sender domains and current
account quotas, configure the `EMAIL` binding and private grants, provision the
delivery Queue/DLQ and Email Sending event subscription, and configure Access and
the public origin. Do not infer this configuration from a successful build.

Use controlled real-message acceptance after deployment: read an incoming
message over authenticated MCP, send an authorized reply, confirm one received
copy and its provider ID, inspect sent content, per-recipient events and signed
MCP webhook delivery. Compare Gmail forwarding and raw R2 capture independently.
Until those steps pass, production sending and MCP connectivity remain unverified.

References:
[Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[delivery events](https://developers.cloudflare.com/email-service/reference/event-subscriptions/),
[MCP Events](https://developers.openai.com/plugins/build/mcp-events).
