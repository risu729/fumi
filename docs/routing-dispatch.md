# Durable owner offers and ordinary routing dispatch

Status: private-configured runtime with synthetic local workerd validation. Absent
configuration disables external calls. No real endpoint, account, credential or
policy is provisioned by this change. Production delivery and the specialist-owner
implementation require separate acceptance. MCP Events callbacks remain a separate,
deferred consumer; they are not this ordinary action webhook.

A private owner-only RPC adoption and its first durable decline were verified on
2026-11-12 with a controlled incoming message containing no verification code. The first
readback recorded one owner attempt and `not_applicable` receipt, held fallback without
a configured notification destination, and no ordinary action operation. Repeat-receipt
verification is pending. This acceptance does not establish handled OTP, financial
authentication, classification or ordinary webhook delivery. See
[owner adoption status](plugins.md#kogane-implementation-and-adoption-status).

## Runtime and ownership

`dispatchRoutingSource(env, rawKey, runtime)` is the immediate post-MIME hook. The
application Workflow calls it after successful extraction; specialist OTP messages must
not wait for the five-minute scheduled sweep. This targeted path evaluates the bounded
CEL router against the current source directly, independently of shadow-row persistence.
It uses the same durable leases and outbox as `repairRoutingDispatch(env, runtime)`, the
bounded Cron repair path. A transient guaranteed-no-effect owner error gets at most two
immediate retries after two and four seconds. Later repair retries remain bounded by the
total attempt budget. No detached promise is started by either helper.

Only complete current MIME sources with `source_kind=email_routing`,
`notify_events=1`, a present original and matching catalog/extraction SHA can enter
the path. Historical/imported mail creates no offers or notifications. Per-source
leases let an urgent owner proceed independently of another source's asynchronous
classification. At most three sources, three offers and three status lookups are
processed per repair invocation; the targeted path reconciles only its own source.
Each adapter call is capped at five seconds, response data at 4 KiB, and injected
asynchronous classification at 45 seconds and gating at ten seconds per call.

Specialist matches run first in deterministic CEL priority order. Only a durable
`not_applicable` allows the next exclusive owner and normal fallback. `handled`
stops the exclusive lane. Rejection, exhausted retries and unknown results cannot
fall through. Existing handled or unknown owner operations remain authoritative
when a new manifest stops matching or an adoption is removed. Observer matches
remain shadow-only; this executor implements exclusive owner claims.

Ordinary `review` rules may attach a bounded generic `category` identifier and
urgency. The default has no category and is nonurgent. These values are evidence
for the receiver, never a destination, account or bot selection. Non-review rules
cannot set a category or urgency. Unresolved mail invokes the trusted optional
`resolveFallback(source, decision)` callback.
`gateNotification(source, resolution, operationId)` runs after asynchronous resolution
and again after the final source/configuration read, immediately before the atomic
sending claim. It supplies trusted acknowledgement, case and thread policy; absent
gating holds notifications. Mail/model content cannot configure the callback, grant
itself authority, or choose an endpoint or credential.

Existing handled, HTTP-accepted and uncertain outcomes are checked before new owner
offers, including after adoption upgrades. An ordinary notification cannot be
retroactively rerouted to a newly adopted owner. A gate's `ignore` result records a
terminal ignored job and revokes a ready/no-effect retry outbox; Cron does not
repeatedly query acknowledged sources. Explicit targeted re-evaluation after an
administrator context change, a new source revision or a new configuration revision
can reconsider a policy ignore. Completed and uncertain operations stay protected.

## Private administrator artifact

The only configuration object is `config/routing-dispatch-v1.json` in private R2.
Its strict v1 fields are:

- `schemaVersion: 1`, positive integer `revision` and `generation`, and `enabled`.
- `routing: {configJson, manifests}`: the existing strict adopted CEL configuration
  and authenticated owner snapshots. A manifest-origin string is an administrator
  attestation after authenticating the owner channel, not self-authentication.
- `destination: {id, adapter, offerFields}` or explicit `null`: one configured
  generic endpoint, or owner-only dispatch without ordinary notifications. The
  field remains required; omission is invalid.
- `owners: [{handlerRef, adapter, offerFields}]`: administrator-provisioned adapters
  for enabled owner adoptions. There are at most sixteen.

Configuration is bounded to 256 KiB. A revision is immutable: changing bytes requires
a larger revision. A destination change requires a larger generation as well.
Lower/stale revisions, generation rollback and same-generation destination changes
are rejected. Missing, disabled, invalid or uncredentialed configuration cannot send.
Keep private rule sets, real endpoint details and credentials outside Git.

With `destination: null`, adopted owners still receive only their granted inputs.
An owner claim remains exclusive; declined or unmatched mail is durably held with
`notification_not_configured`. No classifier, notification gate or ordinary
webhook is called. This permits owner adoption while a receiver remains deferred,
without inventing an endpoint or forwarding unmatched mail to the owner.
Activation and status responses expose the observed `mode`: `owner_only`,
`configured_destination`, or `unobserved` before a control row exists. This is
configuration evidence, not proof of delivery or owner readiness.

Adding or removing a destination still requires a newer revision and generation.
Prior accepted/handled and uncertain operations retain their original identities;
handoff waits for reconciliation and never re-offers a handled source. Existing
archive and Gmail-forwarding lanes are unchanged. Deploying this support does not
create a Service Binding, pin/adopt an owner manifest, activate private policy or
perform a real OTP/provider operation; each remains a separate operator step.

An adapter is either `{kind: "rpc", serviceRef, timeoutMs}` or
`{kind: "https" | "service", offerUrl, statusUrl, authRef, serviceRef, timeoutMs}`.
HTTPS uses only the exact administrator URLs, HTTPS without credentials, fragments,
query strings, custom ports or private/reserved host syntax. Its DNS must be trusted
by the operator; Workers fetch cannot pin the resolved address while retaining TLS
SNI. No redirects are followed: `redirect: "manual"` is used and non-200 responses
remain uncertain. HTTP adapters use bearer credentials resolved from the private
optional `ROUTING_DISPATCH_AUTH` secret map. Bound HTTP/RPC services use trusted
capability mappings, never mail-selected bindings. A default optional
`ROUTING_DISPATCH_SERVICE` or `ROUTING_DISPATCH_RPC` binding maps to `serviceRef`
`default`; injected trusted transports can map separately configured bindings.
No optional secret/service is declared required by deployment.

Native deployment can opt into that RPC capability with the paired production
variables `FUMI_ROUTING_RPC_WORKER` (lowercase Worker identifier, at most 63
characters) and `FUMI_ROUTING_RPC_ENTRYPOINT` (export identifier, at most 128
characters). Both absent/empty omits the binding; a partial or invalid pair fails
the build. The locked cf configuration API declares this service binding as
`bindings.worker({worker, exportName})`. It becomes `ROUTING_DISPATCH_RPC` and maps
to `serviceRef: "default"`; neither mail nor an owner manifest selects its target.
The deployment workflow carries both variables so later reviewed deployments
preserve the same declared capability. There is no default target.

Before owner activation, verify the target deployment and named entrypoint,
authenticate its manifest distribution, pin the exact manifest bytes/version/hash,
and explicitly adopt only the required match/offer fields. Then privately configure
the matching owner adapter and `destination: null` with a reviewed revision and
generation. The native artifact test can bind a synthetic local named export to
prove opt-in serialization/RPC wiring; it does not exercise a production owner.

HTTP endpoint credentials are fingerprinted privately without persisting their
values. The fingerprint participates in active destination generation identity and
is frozen with each outbox operation. A different credential under the same reference
cannot query an old operation's status or reoffer it. Keep separate immutable
credential references for old/new endpoints until all old uncertainty is resolved;
do not repurpose an active reference. Rotations require an explicit new revision
and generation. Private RPC/service binding targets are opaque capabilities and
must likewise retain their operator-verified identity per reference; replacing their
endpoint/owner identity requires the same deliberate generation handoff.

The ordinary destination additionally accepts `{kind: "webhook", url, authRef,
timeoutMs}` for a provider that consumes the bounded notification JSON without the
owner receipt protocol. It makes one bounded authenticated POST without following
redirects. HTTP 2xx records the distinct terminal outbox state `accepted`, meaning
HTTP acceptance only; it does not establish delivery, reading or durable downstream
processing. Any non-2xx, timeout or transport loss is uncertain and is never
automatically resubmitted. No status endpoint is invented: verified operator evidence
is required to reconcile uncertainty, which blocks destination handoff meanwhile.
Manual `not_found` or `retryable_error` cannot reset a generic webhook. Actual
endpoint, authentication and input semantics require separate verification before
activation. No real receiver endpoint is configured here. Fumi owns this configurable
outbound handler only; Techo owns later bot routing and any active bot-account choice.
No Techo receiver is implemented by this change.

## Input disclosure and source integrity

Match `inputFields` remain the four bounded metadata fields. The owner manifest
and adoption can separately declare `offerInputFields`, defaulting to their
existing metadata input grants for compatibility. Allowed offer fields are
`subject`, `from`, `to`, `hasAttachments`, `envelope` and `text`. The dispatch adapter's
`offerFields` must be a subset of both the owner's requested fields and the explicit
administrator adoption grant. No arbitrary JavaScript or private archive credential
is supplied to an owner.

Envelope fields come from a validated SMTP receipt tied to the exact raw object key,
SHA and received time. Parsed MIME `To` remains an untrusted claim and never becomes
SMTP-recipient authorization. A text grant reads at most 16 KiB from the D1-selected
derivative, verifies its source SHA, path, length and content SHA against the MIME
manifest, and never grants a handler archive access. Missing, unsupported, oversized
or altered text is held. External payloads contain an opaque event ID and source
SHA, not an R2 object key, raw MIME or archive URL.

## Idempotency, receipts and attempt expiry

Migration `0010_routing_dispatch.sql` adds private control, source job and outbox
tables. Logical IDs are SHA-256 of JSON arrays: `['fumi-routing-v1', rawKey, lane]`,
where the ordinary lane is `action` and specialist lanes are `owner:<pluginId>`.
They do not contain manifest version, config hash, generation or retry number.
An accepted operation therefore cannot replay when a plugin or endpoint is upgraded.
The first bounded payload and its request hash are frozen before any network call.
Retries reuse them. A changed source revision, grant or symbolic decision is held
when it conflicts with an attempted payload; it cannot silently send stale content
or mutate the meaning of an idempotency key. Current source revisions are retained
in the source job even when such a conflict is held.

An immutable owner request contains `schemaVersion: 1`, `kind: "owner"`,
`operationId`, `source: {eventId, rawSha256, receivedAt}`, `pluginId`, manifest version
and digest, and the granted `input` object. Notification requests use
`kind: "notification"` and `classification: {outcome: "review", category, urgent,
evidenceCode}` instead of plugin identity. Review does not imply the user has an
action to take: valuable notices can carry informational classification evidence.
Canonical JSON recursively sorts object keys, preserves array order and
uses normal JSON primitive encoding; protocol values have no floating-point numbers.
The lower-case SHA-256 of its UTF-8 bytes is `requestSha256`.

HTTP carries that hash in `X-Fumi-Request-Sha256` and the operation ID in
`Idempotency-Key`. RPC exposes `offer(request)` and `receipt(statusRequest)` on an
explicitly bound WorkerEntrypoint. RPC offer parameters additionally contain
`requestSha256` and `attempt: {generation, expiresAt}`; these two fields are excluded
from the immutable request hash. The equivalent HTTP attempt fields are
`X-Fumi-Generation` and `X-Fumi-Attempt-Expires-At`.

Every strict-protocol receiver must enforce attempt expiry immediately before its atomic
durable claim, rejecting an expired new attempt without an effect. The host stamps
expiry before the D1 sending claim and delays unknown-result reconciliation until expiry
has passed. This prevents a paused old Worker from later committing an old-target
request after a generation switch. An existing durable receipt may be returned
regardless of attempt expiry. A generic webhook does not claim this stronger receipt
contract: its accepted/uncertain behavior and blocked ambiguous handoff apply instead.

Receipts have exactly `schemaVersion: 1`, `operationId`, `requestSha256`, and `result`:

| Result | Required meaning | Host behavior |
| --- | --- | --- |
| `handled` | Owner durably accepted responsibility; strict notification adapter completed its declared endpoint action | Terminal; no ordinary fallback or other-endpoint replay |
| `not_applicable` | No claim/effect; owner durably declines this operation | Advance exclusive lane; invalid as a notification success |
| `retryable_error` | Guaranteed no claim/effect or pending action | Retry the same key/body within budget |
| `rejected` | Permanent failure | Dead-letter/hold; never infer unmatched |
| `uncertain` | Outcome unknown | Status reconciliation; no offer/fallback |
| `not_found` | Status only: no durable claim/effect or pending action for the key/hash | Reoffer the same frozen body after expiry, within budget |

Any timeout, transport error, redirect, malformed/oversized reply, HTTP error or
mismatched identity/hash is uncertain. For the strict receipt protocol, HTTP 2xx
alone does not establish a valid receipt. A receiver
must atomically check current domain state and operation identity, claim and act;
an OTP check-then-act RPC sequence is insufficient. Changed body under an existing
operation ID must be rejected. The specialist's legacy email path must share its
claim gate to avoid competing consumption.

## Handoff, revocation and recovery

Observing a new desired revision first closes new claims. Ready/retry operations from
the old revision are revoked without action. A new active generation cannot activate
while any previous operation is sending or uncertain. Both activation and claim
conditions are enforced in D1 statements. The source, extraction revision, manifest,
live provenance, active config and exact source lease are checked again after
asynchronous policy work. New configuration is reloaded just before the final claim. The
destination never comes from a payload or classifier result.

Already transmitted actions cannot be recalled. Revocation stops new offers, while
minimal identity/hash status queries may reconcile a previous uncertain action
using its previously adopted endpoint. Removing its credential or all configuration
also stops those calls and leaves uncertainty held. Handoff is blocked rather than
guessing that a timeout means nothing happened.

Known no-effect failures use at most five offers with bounded exponential backoff.
Unknown outcomes receive at most five automatic status queries, then remain
quarantined with `reconciliation_exhausted`; they still block handoff. Permanent or
retry-exhausted operations remain visible as dead letters. Source jobs preserve
fixed failure codes without logging mail, endpoint details, credentials or raw
adapter error text. Invalid-source jobs yield to later sources.

Administrative functions are intended only for root wiring behind `mail:routing`:
`activateRoutingDispatch`, `drainRoutingDispatch`, `routingDispatchStatus`,
`reconcileRoutingDispatch` (status-only), and `recordRoutingDispatchReceipt`. Drain
pauses new claims. Explicit activation requires a current enabled artifact and settled
old attempts. Administrators must drain before changing an endpoint or revoking an
adoption: artifact writes are observed asynchronously and cannot recall an already
authorized in-flight attempt. Status returns bounded counts and held operations/jobs,
not payloads. Manual receipt recording requires independently verified receipt evidence
matching the stored operation/hash; it cannot invent a missing result or blindly reset
an uncertain operation.

The application mounts these controls after same-origin and Access JWT validation:
`GET /api/admin/routing/status`, and bodyless `POST` requests to
`/api/admin/routing/activate`, `/drain`, `/reconcile`, and `/retry/<mail_id>` under
the same routing prefix. Retry deliberately re-evaluates one current source after
an operator context update; it cannot reset accepted or uncertain operations.
`POST /api/admin/routing/receipt` accepts only the strict receipt JSON backed by
independently verified evidence. These controls require `mail:routing`; normal
mail read/send permissions do not grant them. Context routes are documented in
[private policy](routing-policy.md).

Synthetic tests cover owner fallthrough/claims/timeouts, expiry, concurrent repairs,
generation drain, upgrades, revocation, source and body integrity, input grants,
historical suppression, retries, dead letters, status reconciliation and admin
controls. They establish local runtime behavior, not real provider notification delivery
or production Kogane acceptance.

References: [D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/),
[Workers Request behavior](https://developers.cloudflare.com/workers/runtime-apis/request/).

The authenticated GET /api/admin/routing/owner-manifest control requires the
mail:routing grant and accepts no query selectors or body. It reads only
ROUTING_DISPATCH_RPC.manifest() on the default service capability under a shared
five-second deadline. The owner must return {json, sha256}; Fumi validates the
bounded 8 KiB UTF-8 JSON publication with the existing manifest/CEL restrictions
and verifies its exact-byte SHA-256 before returning the unchanged JSON, digest
and fixed binding attestation. Missing capability is 503; invalid, unavailable or
timed-out publication is a redacted 502. This read invokes neither offer nor
receipt and grants no adoption. The binding attestation identifies a private RPC
capability, not an authenticated public website origin. The administrator still
reviews the publication, pins its exact bytes/version/hash and supplies the
explicit adoption origin and field grants before activation.

The native binding also emits its Worker/export identity as deploy metadata.
Dispatch snapshots and hashes that identity into the existing durable credential
fence. Changing the bound Worker or export cannot query the new owner's status
for an old uncertain operation or release it for re-offer/fallback. Previously
handled claims stay handled. An unresolved old operation requires verified
reconciliation with its original owner; changing the default binding is not
evidence of non-delivery. RPC notification destination changes also require a
generation advance. Custom injected RPC transports may supply `rpcIdentities`
under their trusted service references for the same protection.
