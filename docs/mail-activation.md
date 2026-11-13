# Mail API activation

The native configuration declares `fumi.takuk.me`, a delivery-event consumer
and its dead-letter queue. These declarations and a passing build do not prove
that production resources or authentication are active. Keep account IDs,
sender addresses, grants and acceptance evidence outside Git.

## Prepare and deploy

Apply the catalog migrations and configure the secrets described in the
[agent mail API](agent-mail.md#authentication-and-sender-policy) before deploying the
new code. `API_ORIGIN` must be `https://fumi.takuk.me`, with no trailing slash. `/mcp`,
`/api/mail/*` and `/api/admin/gmail-import/*` must be covered by the owner-only Access
application; retain the Worker's JWT checks. Keep Workers.dev and preview URLs disabled.

This hostname is the requested target configuration. Before changing the current
deployment, reconcile its Worker domain, Access application and protected paths,
and `API_ORIGIN` together. Verify denied anonymous access and authenticated MCP
at the new hostname. Editing configuration alone does not move an existing endpoint
or change secrets, DNS or Access policy.

Verify the intended sending domains are enabled and review current quotas.
Inspect existing Queues, consumers and subscriptions before creating anything;
reuse matching resources. Run these commands from the repository with its locked
tools and an already authorized operator identity.

## Queues and consumer

Create missing queues, with the same jurisdiction for both:

```sh
mise exec -- cf queues create --queue-name fumi-delivery-events-dlq
mise exec -- cf queues create --queue-name fumi-delivery-events
```

Keep the returned IDs private. After the new Worker code is deployed, create the
consumer only if one is absent. Set `DELIVERY_QUEUE_ID` to the verified main queue
ID in the operator's environment:

```sh
mise exec -- cf queues consumers create "$DELIVERY_QUEUE_ID" \
  --type worker --script-name fumi \
  --dead-letter-queue fumi-delivery-events-dlq \
  --settings-batch-size 10 --settings-max-retries 5
```

This targets `POST /accounts/{account}/queues/{queue}/consumers`; it does not
deploy unrelated triggers. Read back the consumer's Worker, batch size, retry
limit and DLQ. Do not attach fumi as the DLQ consumer: its handler intentionally
accepts only `fumi-delivery-events`. Inspect and recover DLQ records separately;
they are not retained indefinitely.

## Email Sending subscriptions

Create one subscription per enabled sending domain, even when both use the same
queue. In the ignored `work/` directory, prepare `delivery-subscription.json`
with the verified zone ID, exact sending domain and main queue ID replacing the
uppercase values:

```json
{
  "name": "fumi-delivery-SENDING_DOMAIN",
  "enabled": true,
  "source": {
    "type": "email.sending",
    "zone_id": "ZONE_ID",
    "domain": "SENDING_DOMAIN"
  },
  "destination": {
    "type": "queues.queue",
    "queue_id": "DELIVERY_QUEUE_ID"
  },
  "events": [
    "message.delivered",
    "message.deferred",
    "message.bounced",
    "message.failed",
    "message.rejected",
    "message.complained"
  ]
}
```

```sh
mise exec -- cf queues subscriptions create --body @work/delivery-subscription.json --dry-run
mise exec -- cf queues subscriptions create --body @work/delivery-subscription.json
```

The endpoint is `POST /accounts/{account}/event_subscriptions/subscriptions`.
The pinned cf version's source flags omit `email.sending`; raw `--body` supports
the request. Subscription configuration uses `zone_id`, while delivered event
envelopes use `zoneId`. Read back the enabled subscription, source domain and
zone, queue ID and six event names. Repeat for the other sending domain.

## Protected hostname and trigger synchronization

After the Access policy, secrets and code are ready, inspect the domain's DNS and
current Worker association. The native `worker.domains` configuration can be
applied with the full trigger command:

```sh
mise run build
mise exec -- cf workers triggers deploy --prebuilt --mode production --worker fumi --dry-run
mise exec -- cf workers triggers deploy --prebuilt --mode production --worker fumi
```

This synchronizes all configured trigger categories, including Cron, Workflows,
queue consumers and domains. A dry run does not prove remote configuration.
Review the complete desired configuration before using it. When applying only
the hostname, the targeted API is
`PUT /accounts/{account}/workers/domains`, with `hostname`, `service: "fumi"`,
the verified `zone_id`, `enabled: true` and `previews_enabled: false`. The pinned
cf version does not expose a `workers domains` command. Read back the hostname
association and verify unauthenticated access is blocked before owner testing.
An existing Cloudflare One/WARP owner session can authenticate a direct request
without an explicit token header. That request is not a negative authentication
test; use a separate genuinely unauthenticated context to check denial.
Leave the manual deployment workflow unchanged; a versions deployment does not
apply these resource settings.

## Owner login and acceptance

First reuse an existing owner Access session, including an accepted WARP session,
and verify the authenticated profile. A new login is unnecessary when that works.
Otherwise, the pinned cf CLI manages its cloudflared helper; a separate executable
on PATH is not required. Use the existing Access user policy and complete the
browser login as the owner. Quiet login suppresses JWT output:

```sh
mise exec -- cf access login --quiet https://fumi.takuk.me
mise exec -- cf access curl https://fumi.takuk.me/mcp -- \
  --request POST --header 'Content-Type: application/json' \
  --header 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"fumi-owner-check","version":"1"}}}'
```

`access curl` injects the application token. Do not print or copy it into logs or
create a service token for this interactive test. An allowed Access identity
still needs its server-side `MAIL_GRANTS` entry. Verify MCP initialization and
scoped tools, authenticated downloads, one authorized send and its received copy,
then provider-event projection and signed MCP notifications separately.

Email Sending events exclude Email Routing forwards, routing replies and
deliveries to verified routing recipients. Sending to the Gmail forwarding
destination may prove receipt while producing no delivery event. To validate
the Queue path, use an explicitly authorized controlled recipient outside that
category; correlate its provider message ID, queue event and catalog outcome.
Do not resend automatically to manufacture event evidence.

## Signed MCP Events acceptance (temporary)

Signed MCP Events are accepted against a short-lived receiver, not a permanent
consumer. [`tools/events-receiver`](../tools/events-receiver/) answers callback
verification, checks Standard Webhooks signatures against two per-run secrets and
keeps only `webhook-id`, the event name, signature results and receipt times for
signed requests; unsigned or wrongly signed requests only increment a counter.
The payload body is not stored, but `webhook-id` embeds the event's own ID, such
as `received:<ingestId>` or `send:<operationId>:<status>`. The inbound
subscriptions are unfiltered, so every live inbound message during a run
produces `email.received` and `email.ready` deliveries to the receiver.

The `Events acceptance` workflow runs from `main` by manual dispatch only. The
hostname must be an unused `fumi-events-check.<zone>` name; the run refuses one
that already resolves or serves another Worker. Dispatching a run is the
explicit authorization for its two controlled sends. One run:

1. Generates two signing secrets and a read token, and deploys the receiver on the
   dispatched hostname. The hostname is a workflow input, not committed.
2. Calls `/mcp` with an Access service token, subscribes to `email.received`,
   `email.ready` and `email.send_status_changed`, and sends one controlled
   message from the principal's first sender address to itself.
3. Requires each of the three events to arrive with exactly one signature, valid
   under the first secret.
4. About 70 seconds before a five-minute Cron boundary, sends a second message
   and resubscribes with the second secret. The next scheduled delivery must
   carry two signatures, one per secret.
5. Unsubscribes, writes only booleans and counts to the job summary, deletes
   the receiver Worker even when a check fails, and checks that no custom
   domain remains for it.

Prerequisites are owner-provisioned and removed after acceptance: an Access
service token allowed by the fumi Access application, its client ID and secret
as the `FUMI_EVENTS_ACCESS_CLIENT_ID` and `FUMI_EVENTS_ACCESS_CLIENT_SECRET`
`production` environment secrets, a `MAIL_GRANTS` entry for
`service:<client ID>` with `mail:read`, `mail:send`, `mail:events` and one
sender address that fumi receives, and the receiver origin in `WEBHOOK_ORIGINS`.
After acceptance, remove those, then this workflow and the receiver code.

References:
[subscription source type](https://github.com/cloudflare/workers-sdk/blob/d434f33d2f7d85c07ac6381822461267891a8ef8/packages/wrangler/src/queues/subscription-types.ts),
[Email Sending events](https://developers.cloudflare.com/email-service/reference/event-subscriptions/),
[DLQ behavior](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/),
[native domains configuration](https://developers.cloudflare.com/cf/projects/config-explorer/#domains),
[domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/),
[interactive Access identity](https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/).
