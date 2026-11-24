# Historical Gmail import

Status: implemented for synthetic local validation. OAuth provisioning, production
migration, activation and real-mail import require explicit operator execution. This is
a historical migration, not Gmail synchronization or archive-gap recovery. The backfill
is to be finished from Google Takeout instead
([ADR 0004](adr/0004-gmail-takeout-import-and-copy-grouping.md)); the connector run
stopped on 2026-11-12 after 4,810 messages (internal dates 2026-08-24T09:21:29Z to
2026-11-11T16:59:42Z, measured 2026-11-17 14:10 UTC). Ongoing capture of Gmail SENT mail
after the frozen cutoff is planned separately in the [roadmap](roadmap.md) (owner,
2026-11-17 17:37 UTC) and is not implemented.

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

The API transports hold a whole message in memory, so they accept originals up to 25
MiB; the Takeout transport has no size limit (below). Imported mail has no common limit:
Email Routing's 25 MiB applies only to live capture (owner, 2026-11-23 17:55 UTC). The
unchanged MIME input limit is 4 MiB. Larger originals remain archived with explicit
blocked extraction and omitted search coverage; immediate dispatch does not make them
searchable. Gmail internal date is a provider fact; it is not a claimed SMTP receipt
date. There is no fabricated SMTP envelope or forwarding success for historical sources.

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

The API transports bound raw MIME at 25 MiB, a memory bound of these transports, not
an import limit. The transport incrementally
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

## Google Takeout transport

Status: implemented, tested with synthetic mbox files, and run in production for three
accounts (see [production runs](#production-takeout-runs)). It follows
[ADR 0004](adr/0004-gmail-takeout-import-and-copy-grouping.md).

An operator stores each account's Takeout mbox files in the private R2 bucket
`fumi-takeout` (binding `TAKEOUT_ARCHIVE`) and sets the optional Worker secret
`GMAIL_TAKEOUT_CONFIG`. R2 bindings cannot be read-only, so the ADR's read-only binding
is kept in code: only the Workflow reads the bucket, and nothing in fumi writes it. It
is the only way to configure a run; HTTP and mail cannot choose objects, accounts or
behaviour:

```json
{
  "runId": "takeout-main-2026-11",
  "accountNamespace": "gmail-…",
  "objects": [{ "key": "<namespace>/<date>/part-001.mbox", "size": 2147483648 }],
  "onConflict": "stop",
  "checkIdDate": true,
  "attempt": 0,
  "skip": []
}
```

- The objects are read in order as one byte stream, so a mailbox split across Takeout
  parts is one run. Each object must have exactly the configured size before any
  entry is read; otherwise the run stops with `takeout_object_size_mismatch`.
- The five-minute cron starts the `TakeoutImport` Workflow (`fumi-gmail-takeout`, one
  instance at a time) for a configured run that is still `running`, and starts a new
  instance when the previous one ended. Each Workflow step takes the run's lease and
  processes at most 100 entries from the checkpoint. When a step still fails after its
  five retries, the Workflow stops the run with that step's fixed code (or
  `takeout_import_failed`), so a broken run does not restart every five minutes. Only
  the instance the run last started can stop it; a step that timed out may still
  hold the lease, so every entry write is also fenced on the run still `running`.
- [`src/gmail-takeout-mbox.ts`](../src/gmail-takeout-mbox.ts) splits entries. The stored
  raw bytes are the entry with the `From_` line, `X-GM-THRID`, `X-Gmail-Labels` and
  Takeout's separator removed, and with one `>` removed from each line of one or more
  `>` followed by `From` and a space (mboxrd escaping; the splitter returns the escaped
  bytes and the import calls `unescapeMboxrd` per entry). A malformed or cut-off stream
  stops the run with the splitter's fixed code and stream offset, once every entry split
  before the error is processed. An `X-GM-THRID` or `X-Gmail-Labels` header may have at
  most 65,536 bytes before its last CRLF, folds included; a longer one stops with
  `takeout_header_limit`. Where the reads split the stream never changes the entries,
  the code or the offset.
- The format was measured on the main account's export of 2026-11-23 (40,598 entries and
  4 over 25 MiB, 3,952,532,507 bytes), against the 4,810 messages the connector
  had already stored for that account:
  - Takeout folds a long `X-Gmail-Labels` onto lines that start with a space (159
    entries). The splitter unfolds them: it removes the CRLF and keeps the space. A
    valid message cannot start with a space or tab, so every line after the labels
    that starts with one is read as a fold. An invalid message that does start with
    one would lose that line to the labels, and stops only if the labels then fail a
    check (UTF-8, the header limit or `takeout_labels_too_long`); this risk is
    accepted with the owner's choice below.
  - A message that ends in a bare LF gets only the separator CRLF (241 entries); a
    message without a final line break gets a CRLF before the separator.
  - No body line starts with `From` and a space; 291 lines start with `>From` and 12
    with `>>From`, each followed by a space. All 44 stored messages with such lines
    match their stored SHA-256 once one `>` is removed, so the export is mboxrd.
  - 4,693 of the 4,810 stored messages have the same raw SHA-256 after splitting. 114
    differ only by the CRLF Takeout added to a message without a final line break,
    which cannot be told apart from a real one, so it is kept. 3 are 653 to 1,856
    bytes larger in Takeout for reasons not yet known. Those 117 are `conflict`
    entries below; the stored originals are kept.
  - Every entry's Gmail ID agrees with its `From_` date (`checkIdDate` below). The
    `From_` date is not Gmail's `internalDate`: for the 4,810 stored messages it is
    later by up to a minute for most, by up to an hour for 227, by more for 27, and
    earlier for 38.
  - The owner chose to unfold labels, accept LF endings and remove mboxrd escaping,
    and to keep the added CRLF (2026-11-23 02:36 UTC).
- No entry is too large to import. The splitter returns an entry of at most 25 MiB
  (the buffer limit, a memory bound) with its bytes, and a larger one as `large`: the
  same fields with the stream offset and size of its message instead of the bytes. The
  import reads a large message again from the Takeout objects in 8 MiB ranges, across
  object boundaries, and removes the mboxrd escaping in a streaming pass that holds at
  most six bytes between reads. A first pass computes the SHA-256 and size; a second
  streams the bytes into one conditional R2 put with that length and SHA-256, which R2
  checks, so bytes that changed between the passes are never stored. A large entry then
  goes through the same `verified`, `conflict` and `imported` outcomes as any other.
  Until this change (2026-11-23), an entry over 25 MiB was recorded as `oversize` and
  not stored. No run had reached the 4 such entries in the main account's export
  then, so its run imports them; a run that already recorded `oversize` entries needs a
  new run to store them.
- The splitter's memory is bounded. Between reads it keeps at most the buffer limit plus
  149 bytes of unread stream (what a boundary check needs), or 131,206 bytes of `From_`
  line and Gmail headers. With 8 MiB reads its buffer therefore never exceeds 25 MiB +
  149 + 8 MiB = 34,603,157 bytes (33.0 MiB). The first full read allocates the buffer at
  that size, so a normal run never grows it by copying; a buffer smaller than one read
  (after short reads at the end of an object) doubles until a read needs more, and is
  then replaced by one of that size. Each entry's raw bytes are a view of the buffer,
  handled before the next read, so the splitter makes no copy of a message. The import
  makes one unescaped copy, at most the buffer limit, only for an entry with an escaped
  line, and drops it before the next entry; the R2 binding still copies the bytes it
  uploads, at most the buffer limit, outside the JavaScript heap during the put. A large
  entry adds one 8 MiB read and its unescaped copy while it is hashed or streamed. A
  step holds about 41.0 MiB of Takeout data in the JavaScript heap (the buffer and one
  read), at most 66.0 MiB while an unescaped copy exists, and at most 49.0 MiB while a
  small buffer is replaced (no copy exists then), of the 128 MB the Worker shares with
  the rest of the isolate. The buffer is released when the stream ends or fails.
  `test/gmail-takeout-mbox.test.ts` checks the bound for an entry at the buffer limit
  that starts 1000 bytes before the end of a read.
- With `checkIdDate` (the default), each entry's Gmail message ID must agree with its
  `From_` date: a Gmail ID's high bits (`id >> 20`) are the receipt time in
  milliseconds, and the `From_` date is that time cut to seconds, so the difference
  must be 0 to 999 ms. A mismatch stops the run with `takeout_id_date_mismatch`. This
  catches a message body that imitates a Takeout separator with a made-up ID.
  - A sender cannot write a full separator into a body: Takeout escapes every body line
    that starts with `From` and a space (above), so such a line never reaches the
    boundary check unescaped.
  - Some genuine messages could break the rule, for example mail added through the
    Gmail API or fetched by POP. None did in the 2026-11-23 export. A reviewed entry
    is passed with `skip` rather than by turning the check off.
- The checkpoint `gmail_takeout_runs.next_offset` is the stream offset of the next
  unprocessed entry. It advances in the same D1 batch that records the entry in
  `gmail_takeout_items` with one outcome:
  - `imported`: stored through the same path as the API transports, with receipt schema
    `gmail-takeout-v1` (below). The entry's pending `mime-v1` processing job is inserted
    in the same batch, and jobs are started after their batch commits, 25 at a time with
    one `createBatch` and at the end of the step, even a failed one. Each step first
    starts up to 100 due jobs that were never started, such as those of a step that
    stopped before its end; a start that is not acknowledged stays pending with
    `dispatch_unavailable` for that and for the
    [processing repair](processing-workflows.md). The instance status is checked by the
    processing repair five minutes later, not right after the start. If the Worker stops
    after storing the entry but before recording it, the retry finds this run's own
    receipt at the same offset and records `imported`, with its job.
  - `verified`: the account already has this message ID with the same raw SHA-256.
  - `conflict`: the account already has this message ID with a different raw
    SHA-256. The stored original is kept. With `onConflict: "stop"` (the default) the
    run stops at that entry with `takeout_raw_conflict`. After review, the same run
    resumes with `onConflict: "record"`; a stopped run accepts a changed
    configuration only when its account and objects are unchanged.
  - `oversize`: no longer recorded; until 2026-11-23 an entry over 25 MiB got it and
    was not stored. The value stays allowed in D1 for older rows.
  - `skipped`: its stream offset is in the configuration's `skip` list; not stored.
- A stopped run resumes from its checkpoint when the configuration changes. Raise
  `attempt` after a transient failure. For a stop a split entry causes
  (`takeout_id_date_mismatch`, `takeout_labels_too_long`, `takeout_receipt_too_large`,
  `takeout_invalid_provenance` or `takeout_existing_source_invalid`), add the
  reviewed `stop_offset` to `skip`, which records that one entry as `skipped`. If a
  step that timed out stored the entry anyway, it is recorded as `imported`. The
  splitter's own stops come before any entry exists and need a repaired export.
- Other stop codes: `takeout_existing_source_invalid` (the account's existing source
  for this message ID is missing or not present in R2), `takeout_labels_too_long`,
  `takeout_receipt_too_large` and `takeout_invalid_provenance`.
- The ingest ID is the same `gmail-import-v1` identity as the API transports, so a
  message has one archive source per account whichever transport saw it first.

The `gmail-takeout-v1` receipt has the `gmail-import-v1` fields plus
`takeout: { runId, objectKey, entryOffset, labels }`. `internalDate` is the `From_`
date in milliseconds, which has second precision. `labelIds` is empty, because Takeout
holds label names, not API label IDs. The names (localized, possibly RFC 2047
encoded, at most 8 KiB in UTF-8) are kept as stored in `gmail_takeout_labels`, keyed
by raw key with the run ID and entry offset. For an imported entry the row comes from
its receipt, so the reconciler rebuilds it. For a `verified` entry the message was
stored by another transport, so the row comes from the run instead and the first run
to see the message keeps it. A `conflict` entry adds no row, because its labels
describe the differing Takeout copy, not the stored original. The `label_ids` search
filter still matches API IDs only. The ADR's per-entry SHA-256 is not recorded
separately: the raw SHA-256 and the entry offset identify the entry.

Progress and outcomes are D1 rows. The run's `status`, `stop_code` and `stop_offset`,
and the per-outcome counts and `from_date` range in `gmail_takeout_items`, are the
evidence for the per-account verification in the ADR.

### Import speed

Measured: about 5.5 s per entry (risu.minecraft, 1,137 entries in 6,234 s on
2026-11-23), so the main account's 40,600 entries would take about 62 h and
larva06online's 5,407 about 8.3 h. Almost all of
it is network time. Each new entry makes its calls one after another: 10 D1 calls, 4 R2
calls on `fumi-mail` and 3 Workflows API calls. `fumi-catalog`'s primary is in APAC
(served by HKG) and `fumi-mail` is APAC, while fumi's Workflow calls ran from DFW, LHR
and AMS. Workers Observability spans (sampled, 2026-11-20..24, medians):

| Call | From DFW, LHR, AMS | From HKG |
| --- | --- | --- |
| D1 query | 203..259 ms (of which SQL 0.2 ms) | 5 ms |
| R2 `get` | 287..498 ms | 130 ms |
| R2 `put` | 542..843 ms | not sampled |

The owner chose (2026-11-24 04:59 UTC):

1. Create each Takeout Workflow instance with `locationHint: "apac"`
   (`TAKEOUT_LOCATION_HINT`). The hint is best effort. The option is in the Workers
   runtime types (`WorkflowInstanceCreateOptions.locationHint`) and in the Cloudflare
   API schema (`location_hint` on
   `POST /accounts/{account_id}/workflows/{name}/instances`), but the
   [Workflows Workers API guide](https://developers.cloudflare.com/workflows/build/workers-api/)
   does not describe it yet. If `create` with the hint fails for any reason, the cron
   logs `{"event":"gmail_takeout_create","status":"retry_without_hint","error":"Error"}`
   (the error's name only) and creates the same instance without the hint, which then
   runs wherever Workflows places it. It applies to instances created after the change;
   a running instance keeps its place.
2. Cut the sequential calls per new entry from 10 D1, 4 R2 and 3 Workflows calls to 3 D1
   calls (the message lookup, the catalog commit and the outcome batch) and 2 R2 puts,
   plus a few calls per 25 entries to start their processing jobs (above):
   - `storeGmailSource` skips its `gmail_messages` lookup when the caller has just found
     no row (`absent`), and shares one `archive_scan` read across a step's stores
     (`checkpoint`), reading it again only after a refused commit. The commit accepts
     `revision >= <value read>` when this raw key was not observed since, so an older
     value stays valid for keys written after it was read.
   - For every caller, an in-memory original goes straight to its conditional put (a
     refused put is still compared with `head`, and a streamed original is still
     checked first), and the receipt is read back only when its conditional put is
     refused. A receipt over 16 KiB is refused before anything is written.
   - The existing-message lookup reads `archive_sources` with a left join, so a
     `gmail_messages` row without its source stops the run with
     `takeout_existing_source_invalid` instead of being stored again.
3. Decide on handling several entries of one read concurrently only after measuring 1
   and 2 on the larva06online run (5,407 entries), which waits for them.

Measured after 1 and 2 ([#196](https://github.com/risu729/fumi/pull/196),
[#197](https://github.com/risu729/fumi/pull/197), deployed 2026-11-24 05:31 UTC): the
larva06online run imported 730 entries from 05:36:18 to 05:43:35 UTC, about 0.6 s per
entry, nine times faster. Change 2 alone was estimated at about 2.3 s per entry from
outside APAC, so the hint took effect. At this rate the main account's 40,600 entries
take about 7 h. The owner chose not to handle entries concurrently (2026-11-24 05:44
UTC): the main account is the only large import left, and 7 h does not justify a more
complex import loop.

### Production Takeout runs

One row per account, checked with read-only queries on the production D1 catalog. The
namespace is `gmail-` plus the first 24 hex digits of the SHA-256 of the address.

| Account | Run | Entries | Outcomes | `from_date` range (UTC) | Checked |
| --- | --- | --- | --- | --- | --- |
| momonga | `takeout-d592e62e-2026-11-22` | 379 (17,012,473 bytes, one object) | 379 `imported` | 2022-07-11 01:04:54 .. 2026-11-08 08:24:05 | 2026-11-23 18:12 UTC |
| risu.minecraft | `takeout-32483026-2026-11-23` | 1,137 (15,440,548 bytes, one object) | 1,137 `imported` | 2022-06-14 18:29:43 .. 2026-11-22 20:41:01 | 2026-11-23 20:21 UTC |
| larva06online | `takeout-cdd6472a-2026-11-23` | 5,407 (175,910,760 bytes, one object) | 5,407 `imported` | 2023-01-09 12:33:29 .. 2026-11-22 20:54:41 | 2026-11-24 07:18 UTC |

- momonga (`gmail-d592e62e47726b6d49238fa2`, run started 2026-11-23 14:16 UTC): the
  run is `complete` with no stop code, and `next_offset` equals `total_bytes`. The 379
  entries have 379 distinct Gmail IDs; `gmail_messages` holds 379 rows for the
  namespace (342 threads, imported 14:16:15..14:52:43 UTC, about 5.8 s per entry) and
  `gmail_takeout_labels` 379. All 379 have a complete `mime-v1` extraction and a
  complete processing job, so the one blocked extraction and one failed processing job
  that mail health showed at 15:06 UTC are not from this run. The newest of each is one
  live-capture source of 2026-11-18 (`input_too_large`, `workflow_failed`). The count
  agrees with the 379 messages counted in the export before it was uploaded.
- Production had no `fumi-gmail-takeout` Workflow before the momonga run. CI deploys a
  version with `deploy-triggers: false`, which does not register a new Workflow, so it
  was created through the Cloudflare API on 2026-11-23 before the momonga run started.
- risu.minecraft (`gmail-3248302638620a7725a9706e`, run started about 2026-11-23 18:26
  UTC after the owner's go at 18:22 UTC; `GMAIL_TAKEOUT_CONFIG` was replaced at about
  18:23 UTC): the run is `complete` with no stop code, and
  `next_offset` equals `total_bytes`. The 1,137 entries have 1,137 distinct Gmail IDs
  (15,293,276 raw bytes, largest 224,012); `gmail_messages` holds 1,137 rows for the
  namespace (1,047 threads, imported 18:26:17..20:10:11 UTC, about 5.5 s per entry) and
  `gmail_takeout_labels` 1,137 for the run. All 1,137 have a complete `mime-v1`
  extraction and a complete processing job. The count agrees with the 1,137 messages
  counted in the export before it was uploaded.
- larva06online (`gmail-cdd6472a601c7ebf1388bfd2`, owner's go 2026-11-24 02:15 UTC;
  held for the [speed-up](#import-speed) and started after it, with
  `GMAIL_TAKEOUT_CONFIG` replaced at 05:35 UTC): the export came from the owner's
  computer, and the uploaded object's SHA-256 read back from R2 equals the extracted
  mbox's. The run is `complete` with no stop code, and `next_offset` equals
  `total_bytes`. The 5,407 entries have 5,407 distinct Gmail IDs (174,652,160 raw bytes,
  largest 3,996,609, none over the 4 MiB MIME limit); `gmail_messages` holds 5,407 rows
  for the namespace (2,825 threads, imported 05:36:18..07:11:39 UTC, about 1.1 s per
  entry over the whole run) and `gmail_takeout_labels` 5,407 for the run. All 5,407
  have a complete `mime-v1` extraction and one complete processing job. The count
  agrees with the 5,407 messages counted in the export before it was uploaded.
- The main account is not started; it waits for the owner's go.

## Primary references

- [Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail raw message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Gmail account profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail message fields and internal date](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Gmail errors and retry guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Gmail date search](https://developers.google.com/workspace/gmail/api/guides/filtering)
- [R2 conditional writes and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
