# Outbound email through MCP

Status: Cloudflare Email Sending selected on 2026-11-07; implementation is still
planned. No sending domain, credential, MCP send tool or delivery path has been
configured or used by this bootstrap.

## Provider choice

Use the native Cloudflare Email Sending binding. Workers Paid is the deployment
baseline; sender-domain onboarding and generated binding types are implementation
prerequisites. Keep the binding call behind a small adapter for testing and durable
submission handling. A second sending provider is not part of the plan.

Cloudflare's current limits allow arbitrary recipients after sending-domain onboarding,
a 25 MiB complete message and 50 total recipients. Allow for MIME encoding overhead. The
native API returns `{ messageId }` and supports to/cc/bcc, replyTo, text/HTML and
attachments. [Limits](https://developers.cloudflare.com/email-service/platform/limits/),
[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

Cloudflare's published scope is transactional email and excludes marketing.
The provider selection is settled; follow its documented service scope when
implementing sending. Existing Email Routing does not establish that a sending
domain is enabled.
[FAQ](https://developers.cloudflare.com/email-service/reference/faq/),
[sending-domain setup](https://developers.cloudflare.com/email-service/get-started/send-emails/).

## Tool contract and authorization

Proposed tools:

- `create_draft`, `update_draft` with expected revision, and `get_draft`.
- `preview_mail`: normalized sender/recipients, bodies, attachment versions and
  policy results; does not submit or grant authorization.
- `send_mail(input, idempotencyKey)`: explicitly submit a new message or a reply
  linked to a stored parent message.
- `send_draft(draftId, expectedRevision, idempotencyKey)`: submit exactly that
  revision after revalidating current policy.
- `get_send_status(operationId)`: submission and per-recipient delivery outcomes.

A principal with `mail:send` can invoke sending directly within its configured
policy. Drafts/previews are optional; a mandatory interactive confirmation screen
is not required for every message. Enforce this on the server, not through tool
annotations or a caller-controlled `confirmed` boolean.

Separate `mail:read`, `mail:draft` and `mail:send` capabilities. Check owner/account,
sender identity, recipients and attachment access on every call. A permitted
principal may address new recipients according to its grant; From identities
remain restricted to configured sending domains/identities. Inbound messages,
retrieved text, model output and plugin matching cannot grant send permission.

Use authenticated remote MCP with resource/audience-bound access tokens, expiry
and per-tool scope checks. A read-only client cannot send. MCP access tokens are
not forwarded as provider credentials. Validate the intended client's OAuth
interoperability against the pinned specification before production.
[MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Durable submission and ambiguous results

Persist an immutable send input, principal ID, payload hash, attachment hashes,
optional draft revision/reply parent and logical operation ID before provider
I/O. One logical key permits one active submission; the same key with different
content is rejected. Queue items carry operation IDs rather than full messages.

Submission states are `prepared`, `submitting`, `accepted`, `rejected`, `unknown`.
Recipient delivery states are separate. An accepted API call is not proof of
inbox placement, delivery to every recipient, or human reading.

- A crash/timeout after submission starts is `unknown`, even without a saved
  provider ID. An expired local lease does not prove it is safe to send again.
- The reviewed
  [Cloudflare REST contract](https://developers.cloudflare.com/email-service/api/send-emails/rest-api/)
  and
  [send API](https://developers.cloudflare.com/api/resources/email_sending/methods/send/)
  do not document a provider idempotency guarantee. Reconcile using available
  receipts/activity; hold unresolved results rather than blindly resubmitting.
- Never mint a new key automatically after an unknown outcome. A deliberate resend
  records the possibility that the original submission succeeded.
- Let the provider retry temporary SMTP delivery failures after acceptance; a
  deferred event is not a reason to submit a second message.

Process delivery events idempotently and tolerate duplication/reordering without
regressing settled states. Cloudflare sends domain-scoped delivery events to Queues, but
excludes Email Routing events and delivery to verified routing recipients. A
verified-destination smoke test therefore does not validate the production event path.
[Cloudflare events](https://developers.cloudflare.com/email-service/reference/event-subscriptions/).

## Attachments, replies and sent records

Reference authorized immutable R2 objects by ID/hash; do not fetch arbitrary URLs
or local paths supplied through MCP. Select original encrypted attachments versus
decrypted derivatives explicitly. Validate count/size/encoding overhead, filenames,
content types and header injection before provider I/O. Keep Bcc private in
envelope metadata and out of shared search results and citations.

Archive the submitted input, attachment hashes, renderer/adapter version and provider
receipts. A locally generated preview/export MIME is not the provider's final
transmitted bytes. Cloudflare controls Message-ID, Date and transport/MIME headers; save
provider IDs separately from RFC Message-ID until their relationship is verified.
[Header contract](https://developers.cloudflare.com/email-service/reference/headers/).

Replies use stored parent headers for In-Reply-To/References and retain a local
thread link. MCP new sends and later replies use the outbound API, not the live
Email Routing `message.reply()` object. That API is limited to the incoming event
and has sender, DMARC and reply-count restrictions.
[Inbound reply API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/).

Ongoing Gmail Sent synchronization is out of scope. fumi stores its own sent
records; it neither inserts future sends into Gmail nor maintains a mirror of
future Gmail Sent changes. Historical Gmail backfill explicitly includes SENT
messages, their original MIME/attachments and labels. That import is read-only
and does not require Gmail write access.

## Implementation gates

1. Verify sending-domain setup, generated bindings and actual account limits.
2. Test authorization, stale drafts, changed payload under the same key and private
   attachment access using synthetic inputs.
3. Inject concurrent submissions, duplicate queue messages, lost responses,
   crashes, late events and mixed-recipient results; prove there is no automatic
   duplicate submission after an ambiguous result.
4. Test actual Worker memory/CPU and attachment behavior; local binary-attachment
   simulation alone does not establish deployment behavior.
5. When real sending is requested, verify owned-address new mail/replies,
   authentication, attachment bytes and accepted versus delivered receipts.
