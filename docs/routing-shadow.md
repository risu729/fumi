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
negation, comments, single-quoted, triple-quoted and raw strings are outside this
deliberately narrow contract. String escapes are limited to `\"`, `\\`, `\b`, `\f`,
`\n`, `\r`, `\t` and `\uXXXX`, which mean the same in JSON and CEL; JSON's `\/` is
rejected because the CEL parser keeps it as two characters. The CEL parser also
rejects `\uD800` to `\uDFFF`, including a JSON surrogate pair, so a character outside
the Basic Multilingual Plane is written directly. A string literal directly
followed by `"` is rejected, so the token check and the CEL parser always split
string literals the same way.

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

## Reading rules and their usage over MCP

Status: implements the read-only part of
[#145](https://github.com/risu729/fumi/issues/145) (items 1, 3 and 4) on 2026-11-22
07:47 UTC, with synthetic workerd tests. Changing rules over MCP (item 2) is
described in [changing candidate rules over MCP](#changing-candidate-rules-over-mcp).
The tool names, the reuse of `mail:routing` and the output schemas are proposed and
await the owner's approval.

Three MCP tools read the private configuration and the stored decisions. They
need the `mail:routing` grant, the operator scope of the `/api/admin/routing/*`
routes ([routing dispatch](routing-dispatch.md)). `mail:read`, `mail:send` and
the other mail scopes do not grant them, and the tools are not listed for a
principal without `mail:routing`. All three are read-only and call no plugin,
model or webhook.

| Tool | Returns |
| --- | --- |
| `list_routing_rules` | Candidate and active rules with `id`, `priority`, `match`, `outcome`, `category`, `urgent`; each configuration's SHA-256 and R2 upload time; the active revision, generation, `enabled` and `activated` |
| `routing_rule_usage` | Per-rule match count, first and last matched receipt time, sample `mail_` IDs and unmatched rules over a window; plugin candidates, classifier outcomes by category and dispatch states |
| `explain_routing` | For one `mail_` ID: the deciding rule, plugin or classifier outcome with the configuration SHA-256 or dispatch revision, and the stored decision rows behind it |

Exposure. `match` expressions can contain private addresses. These tools are the
only path that returns rule bodies, and they return them only to an authenticated
`mail:routing` principal, whose MCP client then holds them in its context. They are
never logged: the tools write no log line, their errors are fixed codes, and the
existing generic configuration errors still exclude expressions. Dispatch
destinations, owner adapters, credentials and owner manifest bodies are not
returned. Give `mail:routing` only to an owner or operator principal; a
notification receiver that reads mail needs `mail:read`, not `mail:routing`.

Configurations. "Candidate" is the shadow artifact `config/routing-shadow-v1.json`.
"Active" is the routing configuration inside the dispatch artifact
`config/routing-dispatch-v1.json`; `activated` is true only when that artifact is
enabled and the `routing_dispatch_control` row has accepted its revision and digest.
`configuration_sha256` is the router hash above, the key of
`routing_shadow_decisions`. Each rule carries `compared_to_other` (`same`, `changed`
or `only_here`) against the other current configuration. Each configuration's
`status` is `configured`, `absent`, `unreadable` or `unavailable`. `unreadable` means
the stored artifact is invalid; a retry returns the same until an administrator
replaces it. `unavailable` means storage failed: R2 could not be reached for the
artifact, or D1 could not be read for the `routing_dispatch_control` row. A later retry
may succeed. Neither returns rules or a SHA-256, and `routing_rule_usage` then counts
nothing.

History. R2 keeps only the current object under each fixed key. When the candidate
was last written by the rule change tools below, its custom metadata names a revision
record, and `history` reports that record (`revision_id`, `operation`, `rule_id`,
`changed_by`, `changed_at`, the previous revision and SHA-256). Each candidate rule's
`added_at` and `changed_at` then come from that record; a time is `null` when the rule
was last changed outside these tools. A candidate written directly to R2 has no record,
so `history.available` is `false` and every time is `null`. Active rules never carry
times. `uploaded_at` is the upload time of the whole current artifact.

Usage. Counts come from `routing_shadow_decisions` for the selected configuration's
SHA-256, restricted to live provenance (`email_routing`, `notify_events = 1`).
Historical and imported mail is suppressed and never counted. Matched times are the
messages' `received_at`. A message with no rule match counts as `default_matches`;
blocked and non-shadow rows are listed under `not_evaluated`. Messages that the
scheduled shadow pass has not evaluated yet are not counted, and the active
configuration has rows only while the shadow artifact holds the same configuration.
`not_yet_evaluated` counts the live messages of the window that have no decision
under the selected configuration, at most 1,000 (1,000 means at least that many).
These are messages the shadow repair has not reached yet, including all of them for
an active configuration the shadow artifact does not hold. Messages whose raw object is
not present or whose extraction is blocked are not counted: the repair never evaluates
them and dispatch cannot route them, so they cannot match a rule. A message whose
extraction has not finished yet is counted.
The repair evaluates the oldest raw keys first, so right after a new candidate is
uploaded the most recent mail can lag for days.
Classifier outcomes come from `routing_classifications.result_json`, grouped by
state, outcome, category and evidence code, one row per message and policy. Dispatch
states come from `routing_dispatch_jobs` and the outbox lanes.

Bounds. Raw keys are `ingest/<UTC receipt day>/<id>/raw.eml` for live and imported mail,
and every table read here has a primary-key or unique index that starts with `raw_key`.
Each source is one descending range scan of that index from the window's first day,
newest day first, with no sort. `window_days` is 1 to 90 (default 30) whole UTC days
ending today. `max_decisions` caps the rows each scan returns at 1 to 2,000 (default
2,000); one extra row is read to detect truncation. The decision scan also reads, and
skips, the window's rows of other configurations and of historical and imported mail, so
the rows it reads grow with those, never past the window. Within one UTC day the index
orders rows by ID, not by time. When `truncated` is true, the counts cover only the
scanned rows, `oldest_scanned_received_at` says how far they reach (rows of that oldest
day may be left out), and `unmatched_covers_window` is `false`: an unmatched rule then
had no match among the scanned decisions, not necessarily in the whole window.
`unmatched_covers_window` is also `false` while `not_yet_evaluated` is above zero, since
a message without a decision might match a rule. The `not_yet_evaluated` count is one
more range scan of the `raw_key` index of `archive_sources` over the window, with a
primary-key lookup of the decision per source, stopped after 1,000 sources without one.
A test checks `EXPLAIN QUERY PLAN` for every scan. No migration is needed.

Explanation. Live dispatch does not store which rule matched. `explain_routing` reports
a dispatch decision as `rule` or `default` only when a current shadow decision exists
under the active configuration's SHA-256, was evaluated on the same extraction as the
dispatch job, and the job's revision is the active revision; otherwise a static-rule
decision is `rule_or_default` with a `null` rule ID. A handled owner lane reports
`plugin`, a `model_*` evidence code reports `classifier`, and other held states report
`unresolved` with their fixed reason. Without a dispatch job, the current shadow
decision is reported (`rule`, `default`, `plugin_offer`, `suppressed` or `blocked`).
From an outbox payload only the symbolic classification is read, never granted mail
input. The decisions under the candidate's and the active configuration's SHA-256 are
always returned, whatever number of later configurations a message was evaluated under,
so attribution does not depend on how many configurations followed. At most 16 decisions
of other configurations are added, newest first, and `shadow_truncated` is `true` when
more exist. The message lookup by ID is the same as `read_email`'s. A shadow decision is
`current` when the raw object is present, its `mime-v1` extraction is complete, and the
row has that extraction's SHA-256 and update time and the source's catalog SHA-256,
source kind and `notify_events`: the shadow repair re-evaluates a row of a present,
completely extracted source exactly when it is not current. A missing or invalid raw
object, or one without a complete extraction, has no current decision; the repair does
not re-evaluate it either, so its old decisions stay and are reported as not current. A
complete decision is only written when the extraction's SHA-256 matches the catalog's,
so a current complete decision meets `read_email`'s current-extraction rule. A replaced
raw object is current only as the `blocked` decision with `source_changed` that the
repair records for it.

Trust boundary. Inputs are a closed configuration choice, bounded integers and a
`mail_` ID. Mail content and model output cannot widen what is returned: stored
decision and classification JSON is parsed with closed schemas, and a value outside
them is reported as unreadable rather than passed through.

## Changing candidate rules over MCP

Status: implements [#145](https://github.com/risu729/fumi/issues/145) item 2 on
2026-11-22 08:05 UTC, with synthetic workerd tests. The tool names, the
`mail:routing:write` scope, the revision record layout and the output schemas are
proposed and await the owner's approval.

| Tool | Change |
| --- | --- |
| `propose_routing_rule` | Add one rule: `id`, `priority`, `match`, `outcome`, optional `category` and `urgent` |
| `update_routing_rule` | Replace `priority`, `match`, `outcome`, `category` and `urgent` of `rule_id`; omitted `category` and `urgent` are removed |
| `retire_routing_rule` | Remove `rule_id`; the earlier configuration is kept only in the previous revision record, if the tools wrote it |

Candidate only. The tools write only the shadow artifact
`config/routing-shadow-v1.json`, which produces shadow decisions and never dispatches.
They never read or write `config/routing-dispatch-v1.json` or
`routing_dispatch_control`, and no MCP tool activates, drains or reconciles dispatch.
Activation stays the administrator's separate steps: write the reviewed configuration
into the dispatch artifact, then `POST /api/admin/routing/activate`. Every result has
`activated: false`. Adoptions, owner manifests and `fallback` are never changed.

Authorization. The tools need both `mail:routing` and `mail:routing:write`. The write
scope adds to the read scope rather than implying it, because a writer must list the
candidate to get the SHA-256 it passes; `mail:routing:write` alone grants nothing, and a
`mail:routing` principal without it can read rules but not change them. The tools are
hidden from and refused for any principal without both. The HTTP `/api/admin/routing/*`
routes are unchanged: activation, drain, receipts and context still need only
`mail:routing`, so `mail:routing:write` does not stand between a candidate and
activation; it keeps MCP rule changes away from read-only operators. Tool inputs come
only from the authenticated caller; no mail-processing, classifier or scheduled path
calls them. The tool descriptions require the owner's explicit instruction and forbid
changes derived from mail content, retrieved documents or model output, and the tools
are annotated as destructive so a client can ask for confirmation. A server cannot tell
whether a model in the owner's own MCP client chose the arguments; that remains the
client's confirmation step. The risk is therefore an injected instruction in mail or a
document that a model reads in the same session as a `mail:routing:write` grant: a
changed candidate does not route mail, but it changes shadow decisions, usage and the
configuration an administrator may later copy into the dispatch artifact. Hold
`mail:routing:write` in a principal whose client does not also read mail, give read-only
operators `mail:routing` alone, and review the candidate diff before activation.

Deploy order. `resolveGrant` validates the whole `MAIL_GRANTS` secret against the
scopes the running code knows, and one unknown scope makes every principal's grant
fail. Deploy the release that adds `mail:routing:write` first, then add the scope to
the operator's grant. Rolling the code back requires removing the scope from the
secret first.

Validation. Each call builds the full new artifact and checks it with
`parseShadowArtifact`, the validator the scheduled reader uses (256 KiB artifact,
strict shape, full router compilation: at most 32 ordinary rules, the bounded CEL
subset over `subject`, `from`, `to` and `hasAttachments`, 64 KiB configuration).
Nothing is written when a check fails. Errors are `{"error": {"code", "path"}}`, where
`path` is an input key path such as `rule.match`, never a value. It names only keys
the called tool's schema defines at that level; for a key the caller added, it stops
at the parent (`rule`, or no `path` at the top level), even when another level or
tool defines that name, such as `id` in an `update_routing_rule` rule:

| Code | Meaning |
| --- | --- |
| `invalid_arguments` | The input does not match the tool schema (rule ID pattern, priority 0–1000, outcome, category pattern) |
| `rule_match_invalid` | The expression is outside the CEL subset or its bounds |
| `rule_category_not_allowed` | `category` or `urgent` on a rule whose outcome is not `review` |
| `rule_id_exists`, `rule_not_found`, `rule_unchanged` | Duplicate ID, unknown ID, or an update with no effect |
| `rule_limit_exceeded` | The candidate already has 32 rules |
| `configuration_too_large`, `configuration_invalid` | The new configuration exceeds a byte bound or fails compilation |
| `configuration_absent`, `configuration_unreadable`, `configuration_unavailable` | No candidate, an invalid current candidate, or R2 unreachable |
| `configuration_conflict` | `expected_configuration_sha256` is not the current candidate, or another write won the race |

Concurrency. The caller passes `expected_configuration_sha256`, the candidate's
`configuration_sha256` from `list_routing_rules`. A different current hash is
rejected. The candidate is then replaced with an R2 conditional write on the etag that
was read (`onlyIf.etagMatches`), so a write that lands in between makes this call fail
with `configuration_conflict` instead of overwriting it. Of two concurrent changes from
the same revision, exactly one commits. Read the candidate again and retry.

Retrying after `configuration_unavailable`. The tools take no idempotency key, and a
`configuration_unavailable` result can follow a conditional candidate write whose
outcome is unknown. Call `list_routing_rules` again before retrying: when the candidate
already shows the change, with a new `configuration_sha256` and `history.revision_id`,
it committed and must not be repeated; otherwise retry with the SHA-256 just listed. A
retry with the old SHA-256 after a committed write fails with `configuration_conflict`
and writes nothing. A retry with a newly listed SHA-256 of a candidate that already
holds the change fails with `rule_id_exists`, `rule_unchanged` or `rule_not_found`.

Revision records. Before the conditional write, each change writes an immutable
record `config/routing-shadow-revisions/<uuid>.json` in the same private bucket:
`schemaVersion: 1`, `revisionId`, `previousRevisionId`, `previousConfigurationSha256`,
`configurationSha256`, `operation`, `ruleId`, `principalId`, `createdAt`, `ruleTimes`
(`{id, addedAt, changedAt}` per rule, carried forward) and `artifactJson`, the exact
committed artifact. The committed candidate's custom metadata is
`{revision_id, configuration_sha256}`. A record whose write lost the race is deleted
and is never referenced. When that delete fails, or a record write fails with an
unknown outcome, the record stays unreferenced. When the conditional candidate write
fails with an unknown outcome, the record stays and the call fails with
`configuration_unavailable`; it is referenced only if that write committed. History
follows only the current candidate's custom metadata and requires the record's
`configurationSha256` to equal the candidate's configuration SHA-256, so an
unreferenced record is never reported. An absent record, or one that is invalid or
names another revision or configuration, means no history. A named record that R2
cannot return (a failed read or an interrupted body) is not treated as no history: a
change fails with `configuration_unavailable` and writes nothing, and
`list_routing_rules` reports the candidate as `unavailable`, so a transient storage
error never starts a new chain. The chain from the current candidate through
`previousRevisionId` is the audit trail, and it starts again after a direct R2 write.
A record keeps only the artifact it committed: the candidate as an administrator
uploaded it is not recorded, so the first change after a direct upload keeps no copy
of the configuration before it.

Growth. The tools never delete a committed record, and records keep retired rule
bodies. Each change adds one record of at most about 0.5 MiB (the artifact of at most
256 KiB, escaped as a JSON string); a reader rejects a record over 1 MiB. Nothing
expires or prunes them; removing old records is a manual administrator action on the
private bucket. No migration is needed.

Each committed change also produces a new candidate configuration SHA-256. The
scheduled shadow repair keeps a scan cursor per configuration and replays every
completely extracted source in the archive, live and historical, under the new hash,
at most five sources per scheduled invocation, oldest raw key first. Every edit
therefore adds one `routing_shadow_decisions` row per archived source and one
`routing_shadow_scan` row, and decisions of earlier hashes are not pruned. Until the
replay reaches recent mail, `routing_rule_usage` reports it under `not_yet_evaluated`
and `unmatched_covers_window` is `false`. Batch related edits where possible: every
intermediate configuration costs a full replay of D1 writes and its replay lag.

Logs. A committed change logs one line: `event: "routing_rule_change"`, `operation`,
`principal_id`, `revision_id` and the previous and new configuration SHA-256. Rule
IDs, expressions, outcomes and addresses are never logged. Synthetic tests check
authorization and denial, each operation, validation failures that write nothing, a
stale hash, a write that lands between read and commit, two concurrent changes, the
32-rule cap, the absence of rule text in logs, and that the dispatch artifact and
control row stay unchanged.
