# ADR 0003: Signed notification webhooks with identifiers only

Status: accepted, implemented for the routing webhook (points 1 to 3); amended
2026-11-20 (see Amendment). On 2026-11-16 the owner asked, at 12:00 UTC, that MCP Events
subscriptions carry only the routing-filtered result. In the same minute they
asked that both webhook senders share their sending code ("結局送るのってwebhookなら、
そこは共通化すべき", "if both send webhooks in the end, that part should be
shared"). At 12:01 UTC they asked that subscribe tools be made permanent if
`events/subscribe` cannot be used.

On 2026-11-20 at 17:13 UTC the owner accepted the re-verified recommendations below
("はい、そうして", "yes, do that"). This ADR amends the routing
dispatch decision of 2026-11-12 22:50 UTC (who builds the Grok Bot proxy) and the
generic `webhook` adapter's no-retry behavior in
[routing dispatch](../routing-dispatch.md).

Date: 2026-11-20

## Context

Fumi has two outbound webhook senders, and each implements URL validation,
redirect refusal, timeouts and retry policy on its own.

| | Routing notification | MCP Events subscription |
| --- | --- | --- |
| Code | `src/routing-dispatch.ts`, `src/plugin-offer.ts` | `src/mcp-events.ts`, `src/event-delivery.ts` |
| Storage | One frozen row per mail in `routing_dispatch_outbox`, lane `action` | `mail_events` log and a cursor per subscription |
| Auth | Bearer from `ROUTING_DISPATCH_AUTH[authRef]` and `Idempotency-Key` | Standard Webhooks HMAC with a subscriber secret |
| Retry | None for `kind: "webhook"`: a non-2xx stays `uncertain` until a manual receipt and blocks handoff | 8 POSTs, then the subscription stops |
| Body | `kind: "notification"`, `classification` and granted `input` fields (`subject`, `from`, `to`, `hasAttachments`, `envelope`, `text`) | `{eventId, name, timestamp, data, cursor}` |

Facts on 2026-11-20:

- **Grok Bot is a fumi MCP client.** Fumi is attached to the owner MCP Portal with
  `on_behalf = false` and every tool enabled (owner, 2026-11-17 13:27 UTC, recorded
  in risu729/infra). Since 2026-11-17 the Grok Bot's mail-draft skill in
  [risu729/techo](https://github.com/risu729/techo) sends mail through the Portal's
  `fumi_` tools, so the Grok Bot already reads the whole archive as the owner.
- **The Grok Bot proxy does not exist.** It would pick the active A/B account. The
  Grok Bot side has no runtime to host it.
- **Nothing is live.** The private routing policy is inactive, the routing
  destination is `null`, and `WEBHOOK_ORIGINS` is empty.
- **MCP Events is deferred** until ChatGPT returns (owner, 2026-11-16 11:59 UTC).
  The MCP Portal does not proxy `events/*`.
- **The classifier `category` is model-chosen.** It is a slug of up to 64
  characters (`^[a-z][a-z0-9_-]{0,63}$`) from an open vocabulary, chosen after
  reading the mail, so mail content can steer it.

A subagent reviewed the first proposal, which moved both senders onto one
per-destination outbox. It found three problems with that design:

- it lost events during subscription renewal gaps;
- it sent mail that the notification gate later ignores;
- it needed a migration of the action lane's "already notified" check.

That proposal was dropped in favor of the decision below.

## Decision

The owner accepted points 1 to 6. The sub-bullets marked "agent" are details an
agent specified to make them implementable; they are not confirmed by the owner.

1. **Share the sending code, not the storage.** One module signs bodies with
   Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`) and
   performs the bounded POST without following redirects.
   - Routing keeps its frozen outbox, fences, gate and owner-lane order.
   - MCP Events keeps its ordered log, cursor replay and subscription rules.
   - Agent: each sender keeps its current URL validation, timeout and
     `WEBHOOK_ORIGINS` allowlist, so MCP Events behavior does not change.
     Routing secret rotation stays a new `authRef` with a new generation. It does
     not use dual signatures.

2. **The routing `webhook` adapter is signed and retries automatically.** It signs
   with a `whsec_` secret resolved through `authRef` and sends the existing
   `operationId` as `webhook-id`. The receiver deduplicates by `webhook-id`.
   - Agent: a non-2xx response, a timeout, a transport failure or an interrupted
     attempt resends the same frozen body. This reuses the existing total of 5
     attempts and its backoff. An exhausted row ends `dead`, so a timeout no longer
     needs a manual receipt.
   - Agent: a webhook row that was already attempted stays bound to the generation
     and credential it was first sent with. It is never re-targeted to a new
     destination, whose receiver lacks the old deduplication state. Rows never
     attempted are still revoked and rebuilt as today.
   - Agent: the receiver keeps deduplication state for at least 24 hours, which is
     longer than the retry span.

3. **The notification body carries identifiers and classification only.**
   - It adds the message ID that `read_email` accepts (`mail_<ingestId>`).
   - It keeps the classification. The receiver treats `category` as a hint from
     mail-steerable output, the same as the mail itself.
   - It sends no granted mail fields. The receiver reads the mail through fumi's
     MCP tools.
   - Agent: this applies to the `webhook` adapter. Configuration validation
     rejects a non-empty `destination.offerFields` for it. Strict notification
     adapters and owner lanes, such as Kogane, keep their granted `input`.

4. **The Grok Bot proxy is a Worker built by this project's agents, not by the
   Grok Bot side.**
   - It verifies the signature and deduplicates by `webhook-id`.
   - It reads the active account and forwards to that account's Grok webhook
     trigger, holding the per-account URLs and secrets.
   - Fumi still sends to one URL and selects no account.
   - Its repository, deduplication storage and active-account source need a
     separate approved design.

5. **MCP Events carries the routing result instead of every mail, later.**
   - A post-routing event replaces `email.received` and `email.ready` for
     notification purposes.
   - Its name, data, scope and where it is produced are designed when the
     deferred MCP Events item resumes, not now. Constraints:
     - it must not require the operator scope `mail:routing`;
     - it must be produced even when the routing destination is `null`.

6. **No permanent subscribe tools for now.**
   - ChatGPT subscribes through the `events/subscribe` method, not a tool.
   - The Grok Bot uses the routing webhook.
   - Portal clients would share one principal and see each other's subscriptions.
   - The subscriber's `whsec_` secret would pass through model context.

   Add tools only when a concrete subscriber exists.

## Consequences

- **Fewer manual steps and no mail text.** A failed or timed-out webhook POST is
  retried automatically instead of waiting for a manual receipt. No mail text
  travels in the webhook.
- **Duplicates are possible.** A receiver that does not deduplicate may see one
  notification more than once. The proxy deduplicates before it forwards.
- **Broad tools in webhook-triggered sessions.** Webhook-triggered Grok sessions
  read untrusted mail while holding fumi send tools and the Portal's GitHub and
  Kogane tools. This follows the owner's 2026-11-17 decision not to restrict Portal
  tools.
- **Existing rows keep their old body.** Bodies and `request_sha256` are frozen
  when a row is first written. Rows from before the change keep any old `input`.
  Nothing is live, so no such rows exist in production.
- **Agent's split, not confirmed by the owner.**
  - One code PR for the shared signing, the retrying webhook and the body change.
  - A separate proposal for the proxy.
  - The MCP Events change waits for ChatGPT.

## Alternatives

- **One outbox for both senders.** Rejected after review for the reasons in
  Context.
- **Keep the bearer and no retry for the routing webhook.** Every timeout would need
  manual reconciliation and would block handoff.
- **Send `subject` and `from` to the proxy.** That was useful only while the Grok Bot
  could not read fumi. It now can, through the Portal.
- **Make the routing destination an MCP Events subscription.** Subscriptions expire
  after 24 hours and need a renewing client. The Portal does not proxy `events/*`.

## Amendment 2026-11-20: generation change ends attempted webhook rows

Status: agent decision while implementing, not confirmed by the owner.

The accepted text said an attempted webhook row blocks handoff until it is
`accepted` or `dead`. Implementing it showed that such a row cannot progress during
a handoff: a newer revision closes claims, and the old destination's configuration is
no longer the one loaded. Handoff would wait forever.

Instead, an attempted webhook row is never revoked by a revision. Once a newer
destination generation is active, such a row in `ready` or `retry` ends `dead` with
`destination_changed`. It is still never re-targeted. Rows that are `sending` block
handoff as before until their attempt finishes or is recovered as interrupted. The
check runs on every observation, so an attempt that finishes as `retry` after the
handoff also ends `dead`.
