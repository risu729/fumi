# Historical Gmail import

Status: implemented for synthetic local validation. OAuth provisioning, production
migration, activation and real-mail import require explicit operator execution.
This is a historical migration, not Gmail synchronization or archive-gap recovery.
Ongoing capture of Gmail SENT mail after the frozen cutoff is planned separately
in the [roadmap](roadmap.md) (owner, 2026-11-17 17:37 UTC) and is not implemented.

## Trusted operator surface

`startGmailImport` and `runGmailImportPage` implement the import. The separate
`handleGmailImport` adapter exposes these operations behind the existing origin
and JWT checks and a dedicated `mail:import` grant:

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/admin/gmail-import/start` | Create or verify the configured immutable run |
| GET | `/api/admin/gmail-import/status` | Counts, pending size, revision, lease state and [downstream coverage](#downstream-coverage-per-run) |
| POST | `/api/admin/gmail-import/page` | Process one persisted page of at most ten IDs |

Requests have no body. Only status accepts one optional `after` query parameter, a
provider message ID that positions its coverage window inside the configured run; start
and page accept no query parameters. Requests cannot supply tokens, runs, account
namespaces, Gmail queries, destinations or cutoffs. The adapter is mounted after
`authenticate` and the same-origin check; it is not a standalone authentication
boundary. It is deliberately absent from ordinary MCP mail tools.

The two import secrets are optional and are not native `bindings.secret()`
declarations: the pinned cf configuration converter marks those declarations as
required before upload. Optional runtime types are declared beside the adapter.
Without either secret, ordinary mail routes remain available and an authorized
import request receives `gmail_import_not_configured`. Provisioning credentials
remains an explicit activation step. Before activation, verify that the selected
versions upload inherits both optional secret bindings and verify import status
again after deployment; do not infer credential persistence from compilation or
declarations. The installed upload encoder supports retaining `secret_text` and
`secret_key` through `keep_bindings`, and the full cf deployment path sets
`keepSecrets`, but this is not a production readback of import credentials.
[Secret configuration and required-secret validation](https://developers.cloudflare.com/workers/configuration/secrets/).

`gmailImportRuntime` reads server-owned `GMAIL_IMPORT_CONFIG` and
`GMAIL_IMPORT_ACCESS_TOKEN`. Both remain private configuration. The configuration
contains `importId`, `expectedAccountHash`, and `scope`: an opaque `accountNamespace`, a
fixed `before` Unix timestamp in seconds, optional `after`, and explicit
`includeSpamTrash`. `expectedAccountHash` is the SHA-256 hex digest of the expected
Gmail profile email address after trimming and lowercasing. Before the first mailbox
operation and whenever the access token changes, the transport verifies
`/users/me/profile` against that hash. The exact verified token is then used for the
operation. A token for another mailbox fails before listing or fetching mail. Do not
reuse an account namespace with a different Google account. The token must be
provisioned with exactly `https://www.googleapis.com/auth/gmail.readonly`. The runtime
does not implement consent, token storage, refresh-token exchange or grant changes. An
expired token stops the page; replace it through trusted secret configuration and retry.
A trusted embedding can inject a refreshing token provider into
`createReadonlyGmailTransport` instead. Scope declarations do not inspect or prove the
scopes of an externally provisioned token.

The transport has only fixed-host GET profile, list and `format=raw` operations, and
never follows a redirect. It requests with `redirect: "manual"`, because the Workers
runtime refuses `redirect: "error"` on every request, and a 3xx response stops at once
as `gmail_invalid_response` without a retry, so the bearer token is never sent to
another host. No Gmail label, read-state, draft, send, delete, insert or import
method exists. The word import here means copying out of Gmail into Fumi.

## Durability, identity and coverage

The list query uses the frozen date interval without an INBOX filter, so historical
SENT mail is included. Spam/Trash inclusion is explicitly configured. Gmail internal
date, Gmail message and thread IDs, label IDs and the first import timestamp are
preserved in private R2 provenance and `gmail_messages`. Header dates, Message-ID,
thread headers, bodies and original attachment encodings remain in exact raw MIME.
The normal MIME pipeline produces attachment hashes and versioned derivatives.
After each source commits, the importer immediately requests its existing durable
`mime-v1` Workflow, overlapping at most three dispatch-and-item-record tasks for
the at most ten sources per page. Raw reads and archive/catalog commits remain
sequential, retaining only one bounded original in memory. Every launched task
settles before checkpoint advancement or account-lease release, including when a
later raw read or ledger operation fails. Replayed sources
use the same job identity. A dispatch ambiguity remains in the pending job ledger
for bounded repair; an error before a durable job can be created retains the
import's pending page and original for replay. The importer does not wait for MIME
completion, and its archive checkpoint is not a claim of search completeness.
Successful extraction separately attempts bounded lexical indexing. Historical
sources still emit no mail lifecycle events or routing notifications.

The three-dispatch bound is independent of the declared 25-instance
[Workflow concurrency cap](processing-workflows.md). A dispatch can be queued for
capacity after acknowledgment; archive progress is not a processing-start or
search-completion measurement.

Raw import supports originals up to 25 MiB, while the unchanged MIME input limit
is 4 MiB. Larger originals remain archived with explicit blocked extraction and
omitted search coverage; immediate dispatch does not make them searchable.
Gmail internal date is a provider fact; it is not a claimed SMTP receipt date.
There is no fabricated SMTP envelope or forwarding success for historical sources.

SHA-256 of the trusted namespace and provider message ID produces a deterministic
UUID-shaped public Fumi identity. Gmail originals use the existing validated
`ingest/<internal-date>/<uuid>/raw.eml` key shape and a distinct
`gmail-import-v1` provenance receipt. Catalog source kind is `gmail`. Equal MIME
hashes never collapse live SMTP deliveries or different Gmail messages/accounts.
Existing Gmail source bytes and the first label/thread snapshot are immutable.
Retries verify existing R2 checksums and provenance rather than replacing evidence.

The runner persists the current list of IDs and next token before retrieving mail. It
retrieves and archives one original at a time; the client spaces Gmail requests by at
least 250 ms and retries transient network failures, HTTP 429 and server failures up to
four attempts. A response body that fails mid-stream, including one cut off by the
request deadline, is a transient network failure: it shares those attempts and ends as
`gmail_unavailable`, while malformed content stops at once as `gmail_invalid_response`.
Numeric Retry-After values up to thirty seconds are honored; longer or
unsupported retry dates stop cleanly for later operator retry. HTTP 401/403/404 stop
without discarding IDs or advancing the page. In particular, a message deleted from
Gmail after listing remains an unresolved coverage gap unless already archived.

Raw R2 and provenance writes precede an atomic catalog/provider-provenance D1 commit.
Only then is the import item recorded. The page token and unique-message count move
after every listed item is durable. An item ledger prevents repeated IDs on later
pages from inflating counts. A lost response can replay the same page safely; durable
items are validated locally without another Gmail read. Counts describe unique IDs
committed by this run, not newly created archive originals. An account-scoped ten-minute
lease fences simultaneous runs and page checkpoints, renewing before each message.
Expired or superseded runners cannot advance checkpoints. R2 conditional writes keep
their late attempts from overwriting originals. A failed final checkpoint leaves the
same pending page replayable.

The final checkpoint also releases the lease, and the `imported` value in a page
response comes from that same fenced statement: it counts only the items that page
added, even when another runner claims and finishes the next page immediately after.
A runner that stops without checkpointing releases its lease explicitly. If that
release fails in D1, the response keeps the page outcome (its fixed error code, or a
checkpoint that already committed), the Worker logs only
`{"event":"gmail_import_lease_release","status":"failed"}`, and the lease fences the
import as `busy` until it expires on its own, after which the page replays.

Gmail list traversal is not treated as a transactional mailbox snapshot. `complete`
means this bounded traversal ended, not proof that a changing mailbox has no gaps.
For final migration acceptance, compare scoped Gmail and import counts, inspect all
stopped pages, and repeat the frozen interval under a new run ID. Provider IDs make
overlap idempotent. Invalid/expired page tokens require operator investigation or a
new run; the runner never silently resets the traversal.

## Bounds and integration

Raw MIME is bounded at 25 MiB, matching live capture. The transport incrementally
decodes the base64 raw field into a bounded buffer, retains at most 32 KiB of JSON
metadata, and applies a fifteen-second deadline to each attempt. With up to four
attempts and 1, 2 and 4 second backoff between them, one request that keeps timing
out takes about 68 seconds before `gmail_unavailable`; honored Retry-After waits of up
to thirty seconds can extend that. Up to one hundred label
IDs of at most 128 characters are accepted without truncation. Unsupported or
oversized messages retain their pending page and an explicit fixed error code;
there is no silent exclusion. The independent MIME stage currently blocks originals
larger than 4 MiB while retaining the archived original and coverage reason.

`0008_gmail_import.sql` preserves existing source fields and sparse rowids used by
metadata-search cursor snapshots, admits Gmail source identities, and adds run, unique
item and provider-provenance tables. Apply it before deploying this code, including when
OAuth is still unconfigured: ordinary mail reads also join the new provider-provenance
table. The reconciler understands Gmail receipts, reconstructs catalog and provider
provenance, and records incomplete raw/receipt pairs without fabricating forwarding or
stopping unrelated pages. Catalog discovery feeds the existing bounded MIME processing
repair loop. Import completion establishes archival durability; MIME completion and
search coverage are separate checks, reported per run as
[downstream coverage](#downstream-coverage-per-run).

Historical sources always have `notify_events=0`; this is enforced by the catalog
schema as well as the runner. Import and later MIME completion emit neither received,
ready nor failed-mail historical notifications. Import does not forward mail.

No real mailbox or credentials belong in repository fixtures, logs or API errors.
Operator status returns counts and fixed codes, plus at most one provider message ID of
the configured run as its coverage cursor; provider bodies and exceptions become fixed
codes. Keep OAuth material, private import configuration and acceptance evidence outside
source control.

## Downstream coverage per run

Status `complete` and `imported_count` describe archival import only. The status
response adds `downstream`, which classifies up to 1,000 of the run's import items
per request in provider message ID order. `window.items` counts the classified items,
and `window.truncated` is true when more remain. Then `window.next_after` is the last
classified provider message ID: pass it as `?after=` to read the next window, and
sum the windows. Without `after`, the first window is returned. Example for a
completed run of four sources:

```json
{
  "status": "complete",
  "imported_count": 4,
  "revision": 1,
  "pending_count": 0,
  "busy": false,
  "downstream": {
    "window": { "after": null, "items": 4, "limit": 1000, "truncated": false, "next_after": null, "order": "provider_message_id" },
    "archive": { "original_present": 4, "original_missing_or_unknown": 0 },
    "mime": { "complete": 2, "blocked": 1, "failed": 0, "pending": 1, "unknown": 0, "blocked_reasons": { "input_too_large": 1 }, "failed_reasons": {} },
    "lexical_index": { "ready": 1, "retry": 0, "pending": 1, "not_applicable": 2, "ready_with_omissions": 0 },
    "managed_corpus": { "ready": 0, "in_progress": 0, "attention": 0, "none": 4 }
  }
}
```

Each item counts once in every group:

| Group | Values |
| --- | --- |
| `archive` | `original_present`: the catalog observes the original; otherwise `original_missing_or_unknown` |
| `mime` | `complete`: a `mime-v1` extraction matching the present original's hash. `blocked`: a durable extraction coverage reason, counted by fixed code in `blocked_reasons`. `failed`: no extraction and a failed `mime-v1` job, counted by fixed job code in `failed_reasons`. `pending`: no extraction yet, with the original present. `unknown`: anything else, such as an extraction over a missing or changed original |
| `lexical_index` | Only for MIME `complete`: `ready` (indexed for the current manifest, with `ready_with_omissions` as the subset whose coverage lists omitted or truncated parts), `retry` (a deferred indexing attempt is scheduled), `pending` (not indexed yet). Every other item is `not_applicable` |
| `managed_corpus` | Optional managed retrieval rows of any policy: `ready` (all rows ready), `attention` (any `blocked` or `unknown` row), `in_progress` (any other row state), `none` (no rows, such as a source never selected for managed retrieval). Existing rows are still counted by state after managed retrieval is disabled or a source leaves its scope, and rows of an earlier policy until repair replaces them |

The window reads the run's items by the existing `(import_id,message_id)` key and
looks each one up by primary or unique key in the catalog, extraction, processing,
lexical and managed tables. It needs no migration and scans no other rows. The
import row and the coverage window are separate reads, and windows are not one
transactional snapshot: sum them after processing settles when exact totals matter.
If the coverage read fails, `downstream` is `{"status": "unknown", "reason": "<code>"}`
with a fixed code, and the archival fields remain.
The response contains counts, fixed codes and the cursor only: no object keys,
addresses, message content or provider error text. Coverage does not list R2,
re-verify originals or retry anything. Use the existing
[processing repair](processing-workflows.md) and [content search](content-search.md)
repair paths for pending, failed or deferred stages. Overlapping runs count a shared
source in each run.

Synthetic workerd tests cover pending, blocked, failed, indexed, deferred and mixed
runs, managed row states, window continuation, cursor validation, a failed coverage
read and the query plan. They do not establish production import coverage.

## Primary references

- [Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail raw message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Gmail account profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail message fields and internal date](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Gmail errors and retry guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Gmail date search](https://developers.google.com/workspace/gmail/api/guides/filtering)
- [R2 conditional writes and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
