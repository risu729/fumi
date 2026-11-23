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

Status: implemented and tested with synthetic mbox files; no Takeout run has been
configured in production. It follows
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
  - `imported`: stored through the same path as the API transports, with receipt
    schema `gmail-takeout-v1` (below), then dispatched for processing. If the Worker
    stops after storing the entry but before recording it, the retry finds this run's
    own receipt at the same offset and records `imported`.
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

## Primary references

- [Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail raw message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Gmail account profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail message fields and internal date](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Gmail errors and retry guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Gmail date search](https://developers.google.com/workspace/gmail/api/guides/filtering)
- [R2 conditional writes and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
