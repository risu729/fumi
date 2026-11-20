# ADR 0003: Signed notification webhooks with identifiers only

Status: accepted. On 2026-11-16 the owner asked, at 12:00 UTC, that MCP Events
subscriptions carry only the routing-filtered result. In the same minute they
asked that both webhook senders share their sending code ("結局送るのってwebhookなら、
そこは共通化すべき", "if both send webhooks in the end, that part should be
shared"). At 12:01 UTC they asked that subscribe tools be made permanent if
`events/subscribe` cannot be used.

On 2026-11-20 at 17:13 UTC the owner accepted the re-verified recommendations below
("はい、そうして", "yes, do that"). Not implemented yet. This ADR amends the routing
dispatch decision of 2026-11-12 22:50 UTC (who builds the Grok Bot proxy) and the
generic `webhook` adapter's no-retry behavior in
[routing dispatch](../routing-dispatch.md).

Date: 2026-11-20

## Context

Fumi has two outbound webhook senders. Each validates URLs, refuses redirects,
applies timeouts and retries on its own.

| | Routing notification | MCP Events subscription |
| --- | --- | --- |
| Code | `src/routing-dispatch.ts`, `src/plugin-offer.ts` | `src/mcp-events.ts`, `src/event-delivery.ts` |
| Storage | One frozen row per mail in `routing_dispatch_outbox`, lane `action` | `mail_events` log and a cursor per subscription |
| Auth | Bearer from `ROUTING_DISPATCH_AUTH[authRef]` and `Idempotency-Key` | Standard Webhooks HMAC with a subscriber secret |
| Retry | None for `kind: "webhook"`: a non-2xx stays `uncertain` until a manual receipt and blocks handoff | 8 POSTs, then the subscription stops |
| Body | `kind: "notification"`, `classification` and granted `input` fields (`subject`, `from`, `text` and others) | `{eventId, name, timestamp, data, cursor}` |

Facts on 2026-11-20:

- **Grok Bot is a fumi MCP client.** Fumi is attached to the owner MCP Portal with
  `on_behalf = false` and all tools enabled (owner, 2026-11-17). Since 2026-11-17
  the Grok Bot's mail-draft skill in risu729/techo sends mail through the Portal's
  `fumi_` tools, so the Grok Bot already reads the whole archive as the owner.
- **The Grok Bot proxy does not exist.** It would pick the active A/B account. The
  Grok Bot side has no runtime to host it.
- **Nothing is live.** The private routing policy is inactive, the routing
  destination is `null`, and `WEBHOOK_ORIGINS` is empty.
- **MCP Events is deferred** until ChatGPT returns (owner, 2026-11-16 11:59 UTC).
  The MCP Portal does not proxy `events/*`.
- **Classifier categories are free text.** The optional classifier reads mail text
  and returns a free 64-character `category`, so mail content can steer it.

A subagent reviewed the first proposal, which moved both senders onto one
per-destination outbox. It found that this design:

- lost events during subscription renewal gaps;
- sent mail that the notification gate later ignores;
- needed a migration of the action lane's "already notified" check.

That proposal was dropped in favor of the decision below.

## Decision

1. **Share only the HTTP layer.** Both senders use one module for:
   - the URL rule: HTTPS, no userinfo, port, fragment or query;
   - a timeout of at most 5 seconds;
   - redirect refusal;
   - Standard Webhooks signing, with `webhook-id`, `webhook-timestamp` and
     `webhook-signature`, and dual signatures during secret rotation.

   Routing keeps its frozen outbox, fences, gate and owner-lane order. MCP Events
   keeps its ordered log, cursor replay and subscription rules.
2. **The routing `webhook` adapter is signed and retries.**
   - It signs with a `whsec_` secret resolved through `authRef`.
   - It sends the existing `operationId` as `webhook-id`.
   - A non-2xx response, timeout or transport failure resends the same frozen body,
     at most 5 times within one hour. Each attempt first re-checks the current fence
     and the notification gate.
   - Ready and retry rows are revoked when the destination generation changes, not
     on every configuration revision.
   - The receiver must deduplicate by `webhook-id` for at least 24 hours.
3. **The notification body carries identifiers and classification only.**
   - It adds the message ID that `read_email` accepts (`mail_<ingestId>`).
   - It keeps the classification.
   - It sends no granted mail fields (`subject`, `from`, `to`, `envelope`, `text`).
     The receiver reads the mail through fumi's MCP tools.
   - Strict owner lanes, such as Kogane, keep their granted `input`.
4. **The Grok Bot proxy is a Worker written in this project's work, not on the
   Grok Bot side.**
   - It verifies the signature and deduplicates by `webhook-id`.
   - It reads the active account and forwards to that account's Grok webhook
     trigger.
   - It holds the per-account URLs and secrets.
   - Fumi still sends to one URL and selects no account.
5. **MCP Events carries the routing result, later.**
   - `email.review_required`, with data `{message_id, urgent}` and no `category`,
     replaces `email.received` and `email.ready`.
   - It is appended to `mail_events` in the routing action claim batch, with the
     deterministic ID `review:<ingestId>`.
   - Subscribing to it requires `mail:routing`.
   - This is implemented when the deferred MCP Events item resumes, not before.
6. **No permanent subscribe tools for now.**
   - ChatGPT subscribes through the `events/subscribe` method, not a tool.
   - The Grok Bot uses the routing webhook.
   - Portal clients would share one principal and see each other's subscriptions.
   - The subscriber's `whsec_` secret would pass through model context.

   Add tools only when a concrete subscriber exists.

## Consequences

- **Less mail content in transit.** A timeout no longer leaves a notification
  uncertain forever. No mail text travels in the webhook, and the classifier's free
  `category` is not exposed to subscribers.
- **Webhook-triggered Grok sessions hold broad tools.** They read untrusted mail
  while holding fumi send tools and the Portal's GitHub and Kogane tools. This
  follows the owner's 2026-11-17 decision not to restrict Portal tools.
- **Duplicates are possible.** A receiver that does not deduplicate may see one
  notification more than once. The proxy deduplicates before it forwards.
- **The proxy needs its own design.** Repository, storage for deduplication, how it
  reads the active account and its deployment still need owner approval.
- **Planned changes (agent's split, not confirmed by the owner).**
  - One PR for the shared HTTP layer, the signed and retrying webhook, and the body
    change.
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
