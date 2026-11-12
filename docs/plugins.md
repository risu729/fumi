# Owner-maintained integration plugins

Status: strict owner manifest/adoption contracts have a
[bounded CEL shadow implementation](routing-shadow.md) and a private-configured
[durable offer and dispatch runtime](routing-dispatch.md). Production endpoint
configuration, specialist-owner activation and real acceptance remain separate.
No plugin is called without explicit private configuration and capability grants.

## Ownership and adoption

An integration such as Kogane owns its match rules, handler, domain-specific
parsers and state. It publishes a versioned manifest from its own repository or
authenticated Worker. fumi does not become the source of truth for those rules.

fumi holds an adoption record: plugin ID, trusted origin, pinned manifest version
and digest, enabled state, priority, allowed input fields, capability grant,
configured binding/endpoint reference, timeout and fallback policy. Endpoint
credentials and private configuration are not part of the public repository.
Installing a new version is an explicit adoption update, not an unreviewed fetch
of a moving `main` branch on every incoming message.

The manifest can contain declarative CEL expressions for cheap static matching,
its input schema, requested capabilities, supported protocol version and handler
contract. Rules are authored and released upstream. fumi may keep a validated
immutable runtime cache for availability; it is a derived artifact, not an edited
fork of the plugin's rules. A digest pins bytes but does not authenticate the
publisher: authenticate the distribution channel or verify a signature against an
explicitly trusted key as well.

No arbitrary JavaScript is evaluated in the fumi isolate. Domain-specific code
runs in the owner's Worker through a Service Binding (when available) or an
authenticated HTTPS adapter. A manifest cannot grant itself capabilities, select
new destinations, fetch arbitrary URLs or read the whole archive.

## Offer and claim protocol

1. Apply fumi's global safety and privacy policy, then bounded adopted match rules
   over the fields that owner has been allowed to see.
2. Offer only the necessary data with a stable event/idempotency key and manifest
   version. Keep logical operation identity separate from manifest version and
   attempt number so an upgrade does not replay an external action. Attachments
   are permission-scoped references, not bulk inline data.
3. The owner atomically checks current state and claims/handles the offer. For OTP,
   matching an active, unexpired request belongs to the owner, not to fumi or an LLM.
4. Interpret the result according to the declared contract:

| Result                                      | Meaning                                                           | fumi action                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `handled`                                   | Owner durably accepted responsibility and can deduplicate retries | Record receipt, stop this exclusive routing lane                               |
| `not_applicable`                            | No side effect and no claim was made                              | Try the next plugin, then normal rules/model/webhook processing                |
| `retryable_error`                           | Owner guarantees no side effect or durable claim was made         | Retry the same key with a bounded policy                                       |
| `rejected`                                  | Known permanent failure, such as unsupported contract             | Record failure and follow explicit operator policy                             |
| timeout / connection loss / malformed reply | Result may already have committed                                 | Mark uncertain; query receipt or retry idempotently; do not treat as unmatched |

The owner provides receipt/status lookup, or an equivalent idempotent re-offer
that returns the durable previous outcome. Expired claims and receipts need
specified retention. Plugins must not use a separate check-then-act call as a
claim: an OTP can expire or be consumed between those calls.

Distinguish exclusive consumers (such as OTP handling) from explicitly permitted
observers. Use deterministic priority; do not broadcast authentication codes to every
plugin. Limit the number of offers, hop count, evaluation cost and overall time. fumi
retains ownership of normal fallback; plugins do not recursively forward mail back to
fumi. Revoking an adoption immediately blocks further data disclosure.

Gmail forwarding and archival are independent delivery lanes. A plugin's
`handled` result suppresses the ordinary action webhook for that lane; it does
not suppress Gmail forwarding or raw archival during the initial phase.
Gmail forwarding is temporary; after retirement, plugin handling preserves raw
archival and normal webhook fallback without requiring a Gmail delivery lane.

## Kogane integration gap

The inspected
[Kogane email handler](https://github.com/risu729/kogane/blob/02a915ac67bb28412e1294fe531ea4c4ba121089/services/collector-vpoint/src/worker.ts)
uses a Cloudflare email event and forwards mail itself. Its
[session object](https://github.com/risu729/kogane/blob/02a915ac67bb28412e1294fe531ea4c4ba121089/services/collector-vpoint/src/session.ts)
exposes a pending-challenge check and code completion, not the generic offer
protocol above. The adapter and atomic claim/receipt semantics must be implemented
in Kogane; they are not existing features. While Gmail forwarding remains enabled,
designate exactly one forwarding owner to prevent duplicate delivery. Retirement
must also remove specialist forwarding so adopted routes do not retain a hidden
Gmail dependency.

## Acceptance cases

Requested OTP is handled once; unrelated OTP falls through; expired request is
not accepted; two simultaneous offers cannot consume one request twice; a timeout
after commit does not fall through; revoked adoption leaks no payload; version or
digest mismatch is held for review; invalid rules cannot block the Gmail lane;
plugin upgrade and rollback remain reproducible.
