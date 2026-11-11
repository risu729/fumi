# Bounded routing shadow foundation

Status: bounded routing library and scheduled shadow persistence adapter. No
notification, model call, plugin handler call, manifest fetch, or dispatch is enabled.
Absent administrator configuration disables the adapter. No production configuration
or private rules are included.

## Administrator and owner boundary

`compileShadowRouter(configJson, published)` validates administrator-owned JSON and
authenticated owner manifest snapshots. Configuration and manifests must never come
from mail, retrieved documents, or model output. The caller authenticates the owner
distribution channel before providing `authenticatedOrigin`; a claimed origin string
alone is not authentication. This module performs no network request.

The strict manifest v1 contract contains `schemaVersion: 1`, `pluginId`, `version`,
`protocol: "fumi-offer-v1"`, `mode: "exclusive" | "observer"`, `inputFields`,
`capabilities: ["offer"]`, and a CEL `match` expression. Owners publish and maintain
these exact bytes. Administrator adoptions separately contain `pluginId`, HTTPS
`origin`, `version`, `manifestSha256`, `enabled`, `priority`, `inputFields`,
`capabilities: ["offer"]`, `handlerRef`, `timeoutMs`, and `onFailure: "hold"`.
The handler reference is a symbolic, administrator-owned binding name, never a URL
selected by a message or manifest. It is reserved for a future adapter; this library
neither resolves it nor calls it. No other capability is currently accepted.

An enabled adoption must have an authenticated matching origin, exact version and
SHA-256 of the original manifest UTF-8 bytes. Required owner input fields must be a
subset of administrator grants. Duplicate plugin IDs, rule IDs and field grants are
rejected. Disabled adoptions do not load or evaluate owner rules. Revocation requires
replacing the compiled snapshot in the eventual caller; an old snapshot is not a
live grant store. Invalid configuration rejects the whole compilation with a generic
error and cannot become an empty set of successful matches. Error text excludes
private expressions, addresses and configuration values.

Administrator configuration also contains `schemaVersion: 1`, `rules`, and `fallback`.
Each ordinary rule has `id`, `priority`, `match`, and `outcome`. Symbolic outcomes are
`review`, `ignore`, and `unresolved`; none names an external account or destination.
Lower numeric priority wins; equal priorities use binary ID order. Specialist
candidates are ordered independently before ordinary fallback. Observers are
explicitly identified and never consume the exclusive lane.

## CEL implementation and bounds

The evaluator is pinned to `@bufbuild/cel@0.6.2` and its locked dependencies. Buf's
[CEL-ES](https://github.com/bufbuild/cel-es) is an independent ECMAScript CEL
implementation, currently beta, rather than a Google-maintained JavaScript runtime.
The [CEL language](https://cel.dev/overview/cel-overview) uses parse/check/evaluate
phases. fumi parses at configuration compilation, validates the supported AST and
types itself, and uses Buf's reusable evaluation plan. This does not claim support
for the full CEL specification or for arbitrary upstream CEL programs.

Supported inputs are flat `subject`, `from`, `to` strings and `hasAttachments` boolean.
They describe normalized message metadata, not verified sender identity. A subject
or address match cannot establish an active OTP request or authorize an action.
No body, attachment bytes, headers, object references, secrets, tools or host
functions are exposed. Owner activations contain only explicitly granted fields.

The supported CEL subset is booleans, double-quoted string literals, declared field
identifiers, parentheses, `!`, `&&`, `||`, `==`, `!=`, and string `contains`,
`startsWith`, `endsWith`. AST validation enforces operand types and boolean results.
Macros, collections, indexing, property selection, regex, arithmetic, conversions,
timestamps, optional types and arbitrary functions are rejected. Double unary
negation, comments, single-quoted strings and non-JSON string escapes are outside
this deliberately narrow contract.

Before parsing, a token allowlist limits expression UTF-8 bytes to 2048, nesting to
16 and tokens to 384. AST checking then limits nodes to 128 and depth to 16. This
prevents using rejected macros to expand arbitrary programs during parsing.
Configuration is at most 64 KiB; each manifest at most 8 KiB; there are at most
16 plugins and 32 ordinary rules. Each mail string is at most 4096 UTF-8 bytes.
With no loops, regex or string construction in the subset, each decision has a fixed
upper bound of 48 predicates with at most 128 AST nodes each over bounded strings.
This is a structural operation/input bound, not a hard millisecond deadline or a
promise about elapsed time under platform contention. A promise race cannot cancel
synchronous CEL execution; the library does not pretend to impose such a timeout.
`timeoutMs` is an adoption contract for a future asynchronous owner adapter only.

Synthetic tests run this exact package inside local workerd, including Japanese
text, malformed input, forbidden constructs, parser/AST/aggregate bounds and
repeated maximum-sized fields. Worker runtime tests establish local compatibility;
they do not establish deployed routing activation or production delivery.

## Shadow output and claim semantics

`router.evaluate(metadata, provenance)` returns `configurationSha256`, evaluator
version, ordered matching candidates with manifest version/digest, and the first
ordinary rule outcome or default fallback. The configuration hash covers the
evaluator version and validated administrator snapshot, including owner digests.
Config whitespace is immaterial; owner manifest whitespace changes its exact pin.
The result contains no message fields or handler endpoints and always has
`dispatchAllowed: false`. Callers may store this private result with their own
trusted event identity. The scheduled adapter persists private, rebuildable results
in the migration-defined `routing_shadow_decisions` table.

Provenance is a separate trusted argument from archive/source metadata, never a
header or model inference. `historical` returns `historical_suppressed` before rule
evaluation, with no candidate or selected ordinary rule. Invalid metadata and
evaluation failures are explicit nonactionable statuses, never successful claims.

`shadowClaimState` is a pure protocol simulator for exclusive candidates, not a
receipt verifier or owner handler. A match starts at `awaiting_claim`. A durable
`handled` receipt stops the lane. Only `not_applicable` advances to the next owner
and eventually ordinary fallback. `retryable_error` and `rejected` hold the lane;
timeout, connection loss or malformed reply must be supplied as `uncertain` and
never cause fallback. Results in a different owner order hold the lane. Observers
cannot claim the exclusive lane. Every path remains shadow-only.

Future activation still needs authenticated adapters, atomic owner claims and
receipt lookup, stable event/operation identities, bounded retries, a durable
outbox, and the active-destination generation fence. Gmail forwarding and raw
archival remain separate lanes. Private inbox policy, thread/case-state checks,
acknowledgements and urgent escalation are not ported by this foundation.

## Scheduled persistence and private configuration

`repairRoutingShadow(env)` reads only the fixed private R2 object
`config/routing-shadow-v1.json`. Its strict JSON shape is `schemaVersion: 1`,
`configJson` (a string containing administrator configuration), and `manifests`
(an array of `{json, authenticatedOrigin}`). Provisioning this object is an explicit
administrator action outside this change. Only the administrator may write that
key, and must verify each owner's authenticated distribution channel before
attesting `authenticatedOrigin`. The JSON value itself is not authentication.
No HTTP origin fetch or key selected by message content is permitted.

The artifact is bounded to 256 KiB and read through an exact-size buffer with a
five-second stream deadline. Absent configuration returns `disabled`; malformed or
unsupported configuration returns `invalid_config` before scanning mail. Storage
failure returns `unavailable`. The adapter does not silently substitute permissive
defaults, log private configuration, or emit mail lifecycle events.

Migration `0009_routing_shadow.sql` adds decision rows keyed by raw object key and
configuration digest, plus a per-configuration scan cursor. At most five complete
MIME extractions are selected per invocation. Source metadata must be present in
the private archive catalog. Only `source_kind = email_routing` with trusted
`notify_events = 1` is eligible for live shadow evaluation. Other provenance,
including imported historical sources and pre-notification archive records, is
suppressed. The adapter ignores mail-supplied provenance fields. It reads bounded
MIME metadata, not body or attachment objects. `from` is the parsed header mailbox
address, `to` is a comma-joined list of parsed mailbox addresses, and attachment
presence comes from the extractor's attachment count. Invalid/group address shapes
are explicitly blocked rather than guessed.

Each source/extraction/provenance snapshot is fenced in the final D1 write.
An unchanged record is idempotent. Changed extraction, raw digest, provenance or
catalog identity becomes eligible again; a new configuration produces a separate
decision version. Invalid metadata, evaluation errors and source-identity mismatch
have fixed blocked codes and become eligible after the relevant source changes.
An individual write failure advances the cyclic keyset cursor so later messages
still progress; unwritten work is retried when the cursor wraps. A database outage
returns `unavailable` and leaves source data intact. Concurrent scans may duplicate
pure evaluations; the primary key collapses writes without external actions.

The scheduled mount is the only integration point: call the bounded repair helper
after the other archive maintenance stages. Removing the configuration object
disables further decisions while preserving existing evidence. This library never
creates an outbox entry, sends mail, calls a plugin, or notifies a destination,
regardless of the configured outcome or a message's contents.
