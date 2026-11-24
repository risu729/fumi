# Sent mail body search

Status: implemented with synthetic tests; not yet verified in production. Written
2026-11-23 02:30 UTC and approved by the owner on 2026-11-24 02:14 UTC (see
[owner decisions](#owner-decisions)), as part 2 of the owner's request (2026-11-23,
before 00:14 UTC) to make sent mail searchable over MCP. Part 1, metadata search, is
implemented; see [searching sent mail](agent-mail.md#searching-sent-mail). The archive
side is described in [content search](content-search.md);
[managed retrieval](managed-mail-search.md) stays archive-only.

## Summary

- Add a lexical index of the bodies of mail each principal sent through fumi, in its
  own tables (`sent_search_chunks`, `sent_search_fts`), apart from the archive's
  `mail_search_*` tables. Archive search statements never read them.
- Every query of the sent index joins `outbound_operations` on the caller's verified
  principal ID, so results, excerpts and counts only ever come from the caller's own
  sends.
- `search_mail_content` searches the caller's sent bodies beside the archive, with
  `in:sent` and `in:inbox` in `filters`, as part 1 does for `search_emails`. Sent
  matches come first, then archive matches, behind one continuation token.
- A scheduled, bounded stage reads each operation's SHA-256-verified `input.json` and
  indexes its plain-text body, five operations per five-minute run, newest first. A new
  send becomes searchable at the next run unless more than five arrived since the last.
- `search_mail_semantic` stays archive-only. Managed AI Search cannot isolate one
  principal's bodies inside fumi's single shared instance (see
  [semantic search](#semantic-search)).
- One new migration,
  [`0024_sent_body_search.sql`](../migrations/0024_sent_body_search.sql). Code:
  `src/sent-body-search.ts` (indexing stage, sent statement, coverage),
  `searchMailContent` in `src/content-search.ts` (phases and tokens), chunking shared in
  `src/search-text.ts`, and the `/text` download in `handleMailResource` (`src/mcp.ts`)
  and `getSentText` (`src/outbound.ts`).

## What existed before

These facts, from the code on main at
[199d333](https://github.com/risu729/fumi/commit/199d333), constrained the design.

- A send stores its composed message once, at
  `outbound/sent/<operation_id>/input.json` in R2, and its SHA-256 as
  `outbound_operations.input_hash`. Readers fetch it with a 6 MiB bound and compare the
  digest (`getSentMailImpl` and `projectSentSearch` in `src/outbound.ts`). The object is
  never rewritten.

- `input.json` holds the composed message: a reply's Gmail-style quote and a forward's
  block are already part of `payload.text` and `payload.html`. The author's own text is
  not stored separately, except in a draft.

  ```json
  {
    "version": "outbound-v1",
    "input": {
      "to": ["recipient@example.invalid"],
      "cc": [],
      "bcc": ["hidden@example.invalid"],
      "from_address": "owner@example.invalid",
      "subject": "Re: Invoice",
      "payload": {
        "text": "The revised total is 48,200 yen.\n\nOn Tue, Nov 17, 2026 at 11:13 PM Sato <sato@example.invalid> wrote:\n\n> Could you confirm the total?",
        "attachments": []
      },
      "reply_message_id": "…",
      "headers": { "In-Reply-To": "<…>", "References": "<…>" }
    },
    "draft": null,
    "forward_message_id": null
  }
  ```

- Text and HTML bodies together are at most 256 KiB (`OUTBOUND_LIMITS.bodyBytes`).

- Sent records belong to one principal (`outbound_operations.principal_id`). The
  archive is single-owner: `mail:read` reads every archived message.

- `/api/mail/sent_<id>/body` answers `{"input": …}` as JSON: the composed message,
  including Bcc, with attachment object keys removed and `reply_message_id` rewritten to
  a `mail_` ID (or `null`) by `publicResult` in `src/mcp.ts`. It has no state, draft or
  `forward_message_id`, its bytes are not `input.json`, and they can change with the
  catalog. Any other download of a `sent_` ID answered HTTP 404 `mail_unavailable`
  (`handleMailResource`); `/text` now serves the plain-text body (see [API](#api)).

- The archive index (`0007_content_search.sql`) is an external-content FTS5 table,
  `mail_search_fts(text, content='mail_search_chunks', content_rowid='id',
  tokenize='trigram')`. Pages walk `rowid` (the chunk ID) in descending order and stop
  after `max_results + 1` matches.

- `search_mail_content` and `search_mail_semantic` parsed `filters` with
  `parseMailSearch`, which rejects `in:`. `search_mail_content` now uses
  `parseContentSearch`, which accepts it; `search_mail_semantic` still rejects it.

## Isolation

### Separate tables

[`0024_sent_body_search.sql`](../migrations/0024_sent_body_search.sql) adds:

```sql
-- Rebuildable private index of fumi-sent bodies. Each operation's input.json stays
-- authoritative. Searches always join outbound_operations on the caller's principal.
ALTER TABLE outbound_operations ADD COLUMN body_search_json TEXT;
-- Operations the scheduled stage still has to index or mark.
CREATE INDEX outbound_operations_body_unindexed ON outbound_operations (created_at)
  WHERE body_search_json IS NULL;
CREATE TABLE sent_search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES outbound_operations(operation_id),
  part TEXT NOT NULL CHECK (part = 'body'),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE (operation_id, part, ordinal)
);
CREATE VIRTUAL TABLE sent_search_fts USING fts5(
  text, content='sent_search_chunks', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER sent_search_chunk_insert AFTER INSERT ON sent_search_chunks BEGIN
  INSERT INTO sent_search_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER sent_search_chunk_delete AFTER DELETE ON sent_search_chunks BEGIN
  INSERT INTO sent_search_fts(sent_search_fts,rowid,text) VALUES('delete',old.id,old.text);
END;
CREATE TRIGGER sent_search_operation_delete AFTER DELETE ON outbound_operations BEGIN
  DELETE FROM sent_search_chunks WHERE operation_id=old.operation_id;
END;
```

The `UNIQUE` constraint's index already serves lookups and deletes by `operation_id`,
so no separate index is added (`0007` has one for `raw_key` next to its `UNIQUE`).

Example rows:

| `id` | `operation_id` | `part` | `ordinal` | `text` (start) | `sha256` |
| --- | --- | --- | --- | --- | --- |
| 41 | `send_0b6c…` | `body` | 0 | `The revised total is 48,200 yen.…` | `3f1a…` |
| 42 | `send_7d2e…` | `body` | 0 | `Please find the minutes below.…` | `9c40…` |
| 43 | `send_7d2e…` | `body` | 1 | `…action items for next week…` | `9c40…` |

`sha256` is the digest of the UTF-8 bytes of the whole `payload.text`, before the
100,000-unit cut, as the archive index stores the digest of the whole body text object
its `/text` download serves. Every chunk of one body carries the same value.

`outbound_operations.body_search_json` records each operation's indexing outcome:

| Value | Meaning |
| --- | --- |
| `NULL` | Not indexed yet; the partial index lists it |
| `{"version":"sent-text-v1","status":"ready","chunks":2,"omitted":[],"composed":"reply"}` | Indexed. `composed` is `forward` when `forward_message_id` is set, else `reply` when `reply_message_id` is, else `new`; `omitted` can hold `body_truncated` or `html_only_body` (then `chunks` is 0) |
| `{"version":"sent-text-v1","status":"unavailable"}` | `input.json` missing, over 6 MiB, not its digest, or not the expected JSON; not read again |
| `{"version":"sent-text-v1","status":"not_sent"}` | `rejected`; never indexed or read |

A column on `outbound_operations` rather than a separate documents table keeps the work
list a partial index, as `0021` does with `attachment_count IS NULL`, so the scheduled
stage does not scan every operation to find unindexed ones. It also lets the caller's
coverage counts read only the caller's rows.

### Why a separate FTS5 table

- **Separate table (chosen).** `mail_search_fts` and every archive statement stay as
  they are, so no archive filter mistake can return a sent chunk, and the archive's
  global coverage counts never include sent mail. Sent chunk IDs come from their own
  sequence.
- **Shared table with a principal column.** One index, but every archive statement would
  need `principal_id IS NULL`, and one missed clause would expose another principal's
  sent bodies to every `mail:read` caller. Rejected.
- **One FTS5 table per principal.** The only physical separation, but principals come
  from the `MAIL_GRANTS` secret at runtime and migrations are static; the Worker would
  have to create tables from request data. Rejected.

FTS5 content options:

- **External content with triggers (chosen).** As in `0007`: the chunk table holds
  the text once, `snippet()` works, and the delete trigger passes the exact old text
  that FTS5's `'delete'` command needs.
- **Regular FTS5 table with `UNINDEXED` operation columns.** One table, but `UNINDEXED`
  columns cannot be indexed, so deleting or replacing one operation's chunks would scan
  the whole table. Rejected.
- **Contentless (`content=''`, or `contentless_delete=1`).** Saves no storage, because
  excerpts need the chunk text anyway, and `contentless_delete` needs SQLite 3.43 or
  later, which would need checking on D1. Rejected.
- `detail=column` or `detail=none` would make the index smaller but disable the phrase
  queries the trigram search depends on. The default `detail=full` stays.

### Keeping MATCH and the principal filter bounded

Sent-phase statement (`searchSentBodies`):

```sql
SELECT c.id, o.operation_id, c.part, c.ordinal, c.sha256, c.text, o.input_hash,
       snippet(sent_search_fts,0,'','','…',48) AS excerpt, o.body_search_json
FROM sent_search_fts
JOIN sent_search_chunks c ON c.id = sent_search_fts.rowid
JOIN outbound_operations o ON o.operation_id = c.operation_id
WHERE sent_search_fts MATCH ?            -- the quoted phrase
  AND sent_search_fts.rowid < ?          -- token position
  AND o.principal_id = ?                 -- verified caller, never an argument
  AND o.state IN ('accepted','unknown','submitting')
  AND json_extract(o.body_search_json,'$.status') = 'ready'
  AND <sentFilterSql clauses over o>     -- from:, to:, subject:, after:, before:, has:
ORDER BY sent_search_fts.rowid DESC
LIMIT ?
```

FTS5 returns matches in descending `rowid`, and each passes or fails the principal,
state and filter checks through two primary-key lookups. `snippet()` and the excerpt
are computed only for rows that pass. The walk stops after `limit + 1` passing rows.

The walk also visits other principals' matching chunks and the caller's chunks that the
filters reject, like the archive search with a selective filter
([content search](content-search.md#coverage-and-resource-bounds)). In fumi's
single-owner deployments the other principals are the owner's own agents, and their
sends are few next to the archive. The alternative, a second FTS5 column holding a
fixed-length principal key (`principal_key:"<hex>" AND text:"<phrase>"`), would let
FTS5 intersect the two before any row lookup, but every query would then read the
position lists of every chunk of the caller (about 14 trigram lists for a 16-character
key). Which is cheaper depends on data this design does not have, so it is proposed
only as a later change, after measuring with synthetic data (question 6); see
[measurements](#measurements).

### Scopes

`search_mail_content` keeps requiring `mail:read` only, as `read_email` on a `sent_` ID
and part 1 do. `mail:send` or `mail:draft` is not required and does not grant this
search: a principal that can send but not read cannot read its sent records today. A
`mail:read` principal that never sent through fumi gets no sent matches and counts of
zero.

## What is indexed

| Content | Indexed | Reason |
| --- | --- | --- |
| `payload.text` | Yes, the first 100,000 UTF-16 code units | Same cap, 3,500-unit chunks with a 200-unit overlap and surrogate-pair rules as the archive ([content search](content-search.md#coverage-and-resource-bounds)); `body_truncated` when cut |
| Reply quote inside `payload.text` | Yes | It is what was sent, and Gmail's Sent search matches quoted text. fumi stores only the composed text, so separating the quote would mean parsing it back out |
| Forward block inside `payload.text` | Yes | Same reasons (question 2) |
| `payload.html` when `payload.text` exists | No | The archive also indexes only the text part of received mail; a reply or forward puts the same quote in both parts |
| HTML-only send | No, `html_only_body` | As the archive omits HTML-only bodies (question 3) |
| Subject | No | `subject:` in `filters` already matches it through `outbound_operations.subject` (`0021`) |
| Attachment names and contents | No | No download serves sent attachments for a citation; a forward's original attachments are already indexed under their `mail_` ID (question 4) |
| To, Cc, Bcc, sender | No | `from:` and `to:` in `filters` cover To and Cc; Bcc is never indexed or searched |

States follow part 1: operations in `accepted` and `unknown` (including a surviving
`submitting` claim) are indexed and searched. `prepared` operations stay unindexed until
they move on, `rejected` ones are marked `not_sent`, and drafts are not operations. The
state check is repeated at query time, so an indexed operation whose state later
changes to one that is not searched stops matching.

Forwards and quotes repeat archive content in the sent index. A phrase from a forwarded
original then matches both the archived `mail_` message and the `sent_` record;
`in:sent` or `in:inbox` narrows to one side. This grants no new access: the same
principal can read both the archive and its own `input.json` with `mail:read`. The
repeated text also stays searchable after its archived extraction stops being current,
as it stays readable through `read_email` on the `sent_` ID. A future retention policy
has to decide whether deleting archived mail also removes copies quoted or forwarded in
sent records (see
[deletion and retention](#deletion-and-retention)).

A reply quoting a long thread stores the thread again in each reply. The 100,000-unit
cap bounds this per operation.

## Indexing pipeline

A scheduled stage, `sent_body_search` (`indexSentBodies`), runs in the five-minute
scheduled handler after `sent_search_projection`, with its own `try` block: its failure
marks the run failed but does not skip later stages. It logs only counts:
`{"event":"sent_body_search","indexed":3,"unavailable":0,"skipped":1,"deferred":0}`,
where `skipped` counts `rejected` rows marked `not_sent`.

1. Select at most five operations, newest first, so a new send is indexed in the next
   run even while older sends are being backfilled:

   ```sql
   SELECT operation_id, input_key, input_hash, state FROM outbound_operations
   WHERE body_search_json IS NULL
     AND state IN ('accepted','unknown','submitting','rejected')
   ORDER BY created_at DESC LIMIT 5
   ```

2. A `rejected` row gets `not_sent` without reading R2.

3. Otherwise read `input.json` with the 6 MiB bound and compare its SHA-256 with
   `input_hash`, as `sentSearchFields` does. Missing, oversized, mismatched or malformed
   input gets `unavailable` and is not read again.

4. Chunk `payload.text` with the archive's chunking: `chunks()` in
   `src/content-search.ts`, moved to a shared module, and `truncateCodeUnits` from
   `src/utf16.ts`.

5. Publish in one D1 batch, which commits atomically:

   ```sql
   DELETE FROM sent_search_chunks WHERE operation_id=?
     AND EXISTS (SELECT 1 FROM outbound_operations
                 WHERE operation_id=? AND input_hash=? AND body_search_json IS NULL);
   INSERT INTO sent_search_chunks(operation_id,part,ordinal,text,sha256)
     SELECT ?,'body',?,?,? WHERE EXISTS (…same guard…);   -- one per chunk
   UPDATE outbound_operations SET body_search_json=?
     WHERE operation_id=? AND input_hash=? AND body_search_json IS NULL;
   ```

- **Idempotence.** `input.json` never changes, so a repeat produces the same chunks. The
  guard makes the batch a no-op once another run has published, and an overlapping run
  that loses the race writes nothing.
- **Retries.** A D1 or R2 request failure leaves the row `NULL`, counts it as
  `deferred` and moves on to the next row; the next run selects it again. A run with a
  deferred row logs its counts as an error and marks the scheduled run failed, so
  repeated failures are visible. A row that keeps failing takes one of the five places
  per run: newer sends still come first, but five such rows would stop the backfill of
  older sends until they succeed.
- **Latency.** Five operations per five-minute run: a burst of 15 sends is indexed
  within about three runs, and the first backfill of 1,000 earlier sends takes about 200
  runs (about 17 hours). `pending` in coverage shows the remainder.
- **Bounds.** Each operation reads one object of at most 6 MiB and writes at most 31
  chunks (100,000 units at a 3,300-unit stride), one operation in memory at a time.
- **Migration safety.** The running Worker does not know `body_search_json`; its new
  operations get `NULL` and are indexed by the next run of the new version. The
  migration adds a nullable column, new tables, a partial index and triggers that fire
  only on statements the running Worker never issues.
- **Re-indexing.** A later change to what is indexed bumps `version` and resets
  `body_search_json` to `NULL` for older versions in its own migration; the stage then
  rebuilds them, five per run.

Indexing at send time is not proposed. The send path would gain D1 writes after the
provider accepted the message, and an indexing failure must never turn an accepted send
into an error. The cost is a delay of at least one scheduled run, more during bursts or
backfill (see the latency bullet above; question 5).

## API

### `search_mail_content`

- `filters` accepts `in:sent` and `in:inbox`, which ignore case. Without `in:`, the
  caller's sent bodies and the archive are both searched, as in `search_emails`.
  `in:sent` searches sent bodies and archived Gmail messages labeled `SENT`;
  `in:inbox` searches only the archive, as live ingress or Gmail `INBOX`. Other values
  fail with `unsupported_query`.
- Other operators apply to sent mail exactly as in part 1 (`sentFilterSql`): `to:`
  matches To and Cc, `after:` and `before:` the operation's `created_at`.
- The archive statement gains `LEFT JOIN gmail_messages g` so the `in:` clauses of
  `archiveFilterSql` can read labels; its other clauses are unchanged.
- `get_profile`'s `search_coverage` text, which today says `search_mail_content` and
  `search_mail_semantic` are "both over archived mail only", names the caller's sent
  bodies for `search_mail_content`. The `search_mail_content` tool description mentions
  sent mail and `in:`.

Order and pages: matches are not ordered by relevance or time today; they follow index
entries. Sent and archive chunk IDs are separate sequences and cannot be merged into one
order, so a traversal returns every sent match first, newest chunk first, then every
archive match, as today. One page can hold the last sent matches and the first archive
matches. The continuation token gains the phase:

```json
{ "version": 2, "phase": "sent", "before": 43, "query": "48,200", "filter": "" }
```

`phase` is `sent` or `archive`, and `before` is the chunk ID in that phase's index. The
archive phase starts below the highest possible ID, as the first page does today, so
the archive part of a traversal behaves exactly as it does now. A sent chunk indexed
during a traversal has a higher ID than `before` and is not returned by later pages.
While the deploy job runs, a page served by the previous Worker version reads a
version-2 token as an archive token with the same `before`; a sent-phase token can then
skip matches for the rest of that traversal. This lasts only until the new version is
live.
Tokens without `version` were issued before sent mail joined content search. They keep
working as archive-phase tokens with the same `before`, `query` and `filter`, so a
traversal started before the change continues through the archive with the order and
results it had (owner decision, 2026-11-24). The token is not
bound to a principal: another principal holding it gets only its own matches.

A sent match keeps every field of an archive match, so clients parse both alike:

```json
{
  "message_id": "sent_send_0b6c…",
  "group_id": null,
  "excerpt": "The revised total is 48,200 yen.\n\nOn Tue, Nov 17, 2026 at 11:13 PM Sato…",
  "citation": {
    "part": "body",
    "chunk": 0,
    "sha256": "3f1a…",
    "representation": "original_text",
    "original_sha256": "3f1a…",
    "file_uri": "https://fumi.example.invalid/api/mail/sent_send_0b6c…/text",
    "original_file_uri": "https://fumi.example.invalid/api/mail/sent_send_0b6c…/text",
    "input_sha256": "77b0…",
    "record_uri": "https://fumi.example.invalid/api/mail/sent_send_0b6c…/body"
  },
  "coverage": {
    "version": "sent-text-v1",
    "status": "ready",
    "chunks": 1,
    "omitted": [],
    "composed": "reply"
  }
}
```

- `file_uri` is a new download, `GET` or `HEAD /api/mail/sent_<operation_id>/text`: the
  exact UTF-8 bytes of `payload.text` from the verified `input.json`, as
  `text/plain; charset=utf-8` with the headers `/body` already sends. `sha256` is the
  digest of those bytes, as archive body citations hash their `/text` download. It needs
  `mail:read` and the caller's own operation, and answers HTTP 404 `mail_unavailable`
  otherwise, as other `sent_` downloads do. It contains no recipients, so no Bcc.
- Citing `/body` instead would not work: its bytes are JSON of the whole record,
  rewritten by `publicResult`, and can change after the citation is made. It is
  returned as `record_uri`, and `input_sha256` is the operation's `input_hash`, the
  digest of the archived `input.json`, which no route serves byte for byte.
- `group_id` is always `null`; sent records are never grouped (ADR
  [0004](adr/0004-gmail-takeout-import-and-copy-grouping.md)). `expand_copies` affects
  only archive matches.

Top-level coverage gains `sent_operations`, counted over the caller's own operations
only:

```json
"sent_operations": {
  "searched": true,
  "principal": "this_principal_only",
  "states": ["accepted", "unknown"],
  "indexed": 412,
  "pending": 3,
  "unavailable": 1,
  "html_only": 2
}
```

or `{ "searched": false }` with `in:inbox`. `pending` counts searchable operations with
`body_search_json` still `NULL`, so a caller can tell that a send from the last few
minutes may not be found yet. `html_only` counts indexed operations without a text part,
so it is part of `indexed`. The archive's existing global counts are unchanged and
never include sent mail.

### Semantic search

`search_mail_semantic` stays archive-only, and its `filters` keep rejecting `in:`
(question 1).

Managed AI Search cannot be isolated per principal within fumi's design:

- An operator provisions one instance and binds it as `MANAGED_MAIL_SEARCH`. Principals
  come from the `MAIL_GRANTS` secret at runtime, and the Worker never creates or changes
  instances, so one instance per principal is not possible.
- Putting sent bodies into the shared instance would leave isolation to a provider-side
  filter over a shared index, which fumi's adapter does not use today. Without one, the
  adapter takes at most 30 ranked candidates and filters them locally: another
  principal's sent bodies would take candidate places and show up in
  `omitted_candidates`.
- Local invalidation does not delete remote items
  ([managed retrieval](managed-mail-search.md#evidence-returned-through-mcp)), so sent
  bodies uploaded once would stay with the provider until a cleanup decision exists.
- Uploads are paid and count against the configured budgets.

A dedicated second instance limited to one principal named in operator configuration
would avoid the first two points, at the cost of another provisioned instance and the
same remote retention question. It is not proposed now.

## Cost and limits

Estimates, except where [measurements](#measurements) give a number.

- **Bound parameters.** The sent statement binds the phrase, the cursor, the principal
  and the limit, plus at most two values for each of up to 33 operators: 70 of D1's
  100. `MAX_SEARCH_FILTERS` stays 33.
- **D1 rows written.** At most 31 chunk rows per operation, each with the FTS5 rows
  its trigger writes, and one update. For example, 30 sends a day of about 3,000 UTF-16
  units each add 30 chunk rows a day, about 11,000 a year.
- **Storage.** Chunk text is at most 100,000 UTF-16 code units per operation plus the
  200-unit overlaps, and never more than the 256 KiB body limit plus those overlaps:
  about 280 KB of UTF-8 at worst, for example for Japanese text. A trigram index is
  larger than the text it indexes; the size ratio for fumi's mail has not been measured.
- **D1 rows read per search.** The sent walk reads two primary-key rows per visited
  match. The coverage counts read the caller's own operations through
  `outbound_operations_sent` (`0021`), so they grow with the caller's sends, as part
  1's `metadata_unavailable` count does.
- **Scheduled run.** One partial-index read of at most five rows, at most five R2 reads
  and SHA-256 digests of up to 6 MiB each, and five D1 batches of at most 33
  statements.
- **CPU.** Chunking and hashing at most 256 KiB of body text per operation; the
  `input.json` digest dominates.

## Security

- **Untrusted content.** Sent bodies hold text written by agents and models, and quoted
  or forwarded third-party mail. Excerpts are untrusted data, as archive excerpts are,
  and nothing in them selects tools, recipients, credentials or permissions. Indexing
  never fetches URLs from the text.
- **No cross-principal results.** The principal comes only from the verified Access
  identity. Every sent statement filters on `o.principal_id`, so another principal's
  chunks never reach a result row, `snippet()`, an excerpt or a citation.
- **No cross-principal counts.** `sent_operations` counts only the caller's operations.
  The archive's aggregate counts never include sent mail.
- **Tokens.** A token holds the caller's query, filters, phase and the ID of the
  caller's own last chunk. Like part 1's snapshot, that ID grows with every principal's
  indexed chunks, so the gap between two of a caller's IDs shows roughly how much other
  principals sent between them; part 1 accepted the same for `outbound_operations`
  rowids. A forged `before` returns only the caller's own matches.
- **Timing.** The walk visits other principals' matching chunks, so response time grows
  with them. With every principal configured by the owner, this is accepted rather than
  closed; question 6 names the alternative.
- **Bcc.** Bcc addresses are never indexed or matched by `to:`, and the `/text`
  download and citations contain no recipients. Text the author typed into the body is
  indexed as written.
- **Downloads.** `/text` is served with `Content-Disposition: attachment`, `nosniff`
  and the sandbox CSP, as `/body` is. `/body` sets `Cache-Control: private, no-store`,
  and `secured()` in `src/http.ts` replaces it with `no-store` on every `/api/mail/`
  response.

## Deletion and retention

Nothing deletes sent records today; retention and deletion are an open roadmap item
([phase 2A](roadmap.md#phase-2a-historical-import-and-attachment-aware-retrieval)). The
index is rebuildable from `input.json`. The `sent_search_operation_delete` trigger
removes an operation's chunks when its row is deleted, so a future deletion of a sent
record needs to delete the row and `input.json`; deleting only the R2 object would leave
its chunks searchable. Removing a principal from `MAIL_GRANTS` makes its chunks
unreachable but does not delete them. Archive content repeated in forwards and quotes is
covered by the retention decision, not by this change.

## Measurements

Measured in workerd's local D1 with synthetic rows (`test/sent-body-search.test.ts`), on
2026-11-24; production D1 work was not measured.

- The sent statement's query plan is a descending FTS5 rowid walk bounded by the token,
  with no temporary sort, with and without filters.
- 2,000 of the caller's own chunks match: each page of 20 reads fewer than 500 rows, as
  the archive search does.
- 2,000 matching chunks of another principal sit below 20 of the caller's: a page of 20
  read 4,079 rows, about two per visited match (the test bounds it below 2.1), because
  the walk looks for a 21st match of the caller through all of them. This is the
  response-time signal the owner accepted; with one principal today, no principal-key
  column is added (question 6).
- The trigram index size for real mail was not measured: repeated synthetic text
  compresses unlike mail.

## Tests

`test/sent-body-search.test.ts`, all synthetic, covers:

- Two principals sending the same phrase: each finds only its own, with matching counts,
  and a token from one returns only the other's own matches.
- `in:sent`, `in:inbox`, `to:` with a Bcc-only address, `after:`/`before:`, and every
  state: `prepared`, `rejected`, `accepted`, `unknown`, a surviving `submitting`.
- A traversal that crosses from the sent phase into the archive phase in one page; sends
  indexed during a traversal; a token without `version`.
- `input.json` missing, oversized, mismatched and malformed; a stage run racing another;
  a running-Worker insert without the new column; operation deletion.
- Japanese phrases, exact numbers, a phrase across a chunk boundary, and the `/text`
  digest equal to the citation's `sha256`.
- Query plans without a temporary sort, and rows read bounded like the archive search.

## Owner decisions

On 2026-11-24 02:14 UTC the owner approved this design with the recommended answer to
each question below, and with two further choices:

- **Timing.** The response-time signal from other principals' matching chunks
  ([security](#security)) is accepted. fumi has one principal today, so a principal-key
  FTS5 column or per-principal indexes are not added for it; question 6 still allows the
  column if measurements show other principals' matches dominate the walk.
- **Old tokens.** Continuation tokens issued before this change keep working as
  archive-phase tokens instead of failing with `invalid_page_token`.

## Questions answered by the owner

The recommended answer of each question was approved on 2026-11-24.

1. **Semantic search of sent mail.** Recommended: keep `search_mail_semantic`
   archive-only and keep it rejecting `in:`. Alternative: accept `in:` there for
   archived Gmail labels only and report `sent_operations: { "searched": false }`, or
   provision a dedicated instance for one principal later.
2. **Forwarded originals.** Recommended: index the composed body as sent, including the
   forwarded block, so it behaves like Gmail's Sent. Alternative: index only the note
   above `---------- Forwarded message ---------`, found by parsing fumi's own block,
   to avoid matching the original twice.
3. **HTML-only sends.** Recommended: skip them, counted as `html_only`, as the archive
   skips HTML-only bodies. Alternative: index `htmlToText` output (already in
   `src/outbound-compose.ts`) labeled `html_to_text`, with `/text` serving that derived
   text.
4. **Attachments.** Recommended: not in this change. Alternative: index uploaded UTF-8
   `text/plain` attachments with the archive's caps, which needs a sent attachment
   download for citations.
5. **Indexing latency.** Recommended: scheduled only, up to about five minutes after a
   send, with `pending` in coverage. Alternative: also index right after provider
   acceptance with `waitUntil`, never failing the send.
6. **Principal filter in FTS5.** Recommended: filter by joining `outbound_operations`,
   and measure; add a principal-key FTS5 column only if measurements show other
   principals' matches dominate the walk.
7. **Sent first in a traversal.** Recommended: sent matches before archive matches.
   Alternative: archive first, which keeps the first archive page identical to today's.
8. **New `/text` route for `sent_` IDs.** Recommended: add it for byte-exact citations.
   Alternative: cite `/body` with `input_sha256` only, which a client cannot check
   against downloaded bytes.
