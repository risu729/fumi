# Content search

Status: the bounded lexical baseline was verified in production on 2026-11-12,
including authenticated source downloads and citation SHA-256 comparisons. Private
acceptance evidence is retained outside this repository. New environments require
the additive `0007_content_search.sql` migration and a reviewed Worker deployment.
No embedding service, model call or new Cloudflare resource is required.
An optional [attachment conversion](attachment-conversion.md) pipeline now adds
completed managed document/OCR text and verified local ZIP text. Its separate
private activation can use paid services; the lexical baseline remains local.

`search_mail_content` requires `mail:read` and returns matching chunks with the
Fumi message ID, an untrusted excerpt and an authenticated source citation. The
citation identifies the MIME body or attachment, its SHA-256 and chunk ordinal.
The original MIME and versioned derivatives remain authoritative. Body citations
download the decoded UTF-8 plain text through `/api/mail/<id>/text`; attachment
citations download the exact decoded bytes. Each digest hashes the download bytes.
Use `read_email` to inspect the message metadata and any omitted representations.

Search, indexing and repair use only a current extraction, the definition in
[agent mail](agent-mail.md#tools-and-bounded-results) and `get_mail_health`: status
`complete`, original `present` in the catalog, and the extraction's original SHA-256
equal to the catalog's. Chunks indexed before the original went missing or changed stay
in D1 but are not returned, and repair does not index such an extraction. A retry that
blocks the extraction removes its chunks through the existing trigger.

The `query` is a literal, case-insensitive phrase of 3–200 UTF-16 code units, with
at least three Unicode characters. Japanese phrases and exact numeric strings
work without whitespace segmentation. Quotes and FTS operators are treated as
data. The optional `filters` argument uses the existing `from:`, `to:`, `subject:`,
`after:`, `before:` and `has:attachment` metadata syntax, with the same limit of
1,000 characters and 33 operators ([agent mail](agent-mail.md)). Shorter phrases fail
explicitly instead of silently producing empty results. This is lexical retrieval,
not semantic or hybrid retrieval; AI Search and Vectorize evaluation remains open.

Only archived mail is indexed, and `filters` do not accept `in:`. Bodies of mail sent
through fumi are not searched yet; see
[searching sent mail](agent-mail.md#searching-sent-mail) for the proposal.

## Coverage and resource bounds

Each successful MIME Workflow attempts a separate, retryable lexical index step for its
own source after MIME completion and immediate routing. It uses the same bounded reads,
digests and projection transaction, additionally fenced to the current processing
instance and present original. Replays reuse a ready projection. Index failures retain
MIME success and a projection retry for scheduled repair; they do not emit another
lifecycle event or invoke paid conversion/semantic calls. The step skips its Workflow
retries when R2 answers for a selected object but the object is missing, over its read
bound, not its recorded SHA-256 or not UTF-8 text (the body text or a converted
attachment text; a `text/plain` attachment that is not UTF-8 is only omitted), because
reading the same object again gives the same answer. D1 and R2 request failures still
use the step retries.

The scheduled repair indexes at most three extracted messages per invocation. It selects
present Email Routing sources before historical Gmail sources, then uses remaining
capacity for backfill. Retry delays still apply within both groups. Each invocation
reports `indexed`, the messages whose projection it published, and `deferred`, the
messages it left for a later pass, in the `content_search_repair` log and the archive
repair `content_search` stage. A failed read waits for its retry delay. An extraction or
conversion change during the invocation publishes nothing, and the next invocation
selects the message again, without a delay, while its extraction stays complete. It
processes messages and attachments sequentially. It indexes at most the first 100,000
UTF-16 code units of the decoded plain-text body and the first 16,000 of up to eight
UTF-8 `text/plain` attachments, each at most 64 KiB. Chunks start every 3,300 units and
contain 3,500, so a 200-unit overlap lets supported phrases cross chunk boundaries. No
limit, chunk boundary or excerpt edge splits a surrogate pair: an end inside a pair
moves one unit earlier to leave it out, and a start inside a pair moves one unit earlier
to include it. A chunk can therefore hold 3,501 units, and an overlap 199 to 201, which
still holds any 200-unit phrase. Citations name the chunk ordinal, not offsets, so they
still point to the chunk that holds the text. Documents indexed before this rule keep
their stored chunks until an extraction or conversion change invalidates their
projection and repair rebuilds it. One source can produce multiple hits. Results are
ordered by index entry, newest chunk ID first, not by relevance, with at most 50 chunks
per page.

The full-text index row ID is the chunk ID, so the search orders and bounds pages on it
and FTS5 returns matches already in that order. A page stops after the matches that fill
it plus one more, instead of sorting every match of the phrase first: in workerd's D1 a
first page over 2,000 matching chunks read about 100 rows this way and 12,000 when every
match was sorted. Synthetic tests check that the local query plan has no temporary sort
and bound that row count; production D1 work was not measured. Metadata filters are
checked per match during that walk, so a filter that rejects most matches still walks
them until a page fills, and one that rejects them all walks every match of the phrase
below the cursor. The order, results and continuation tokens are those of earlier
versions, and their tokens still work.

Completed searchable conversion derivatives add at most four attachments and 64,000
UTF-16 code units per message; a derivative cut one unit short to keep a pair whole
still uses the rest of that budget. Derived citations expose both derivative and
original hashes/URLs, with the representation explicitly labeled. Decrypted PDF
binaries, ZIP extraction manifests, HTML-only bodies and non-UTF-8 text are not silently
treated as text. Unsupported, pending or blocked conversion is excluded. Per-message
coverage lists conversion state and omitted or truncated content. Aggregate coverage
reports indexed versus extracted messages; pending/blocked MIME extraction, and an
extraction whose original is missing or changed, is excluded from this denominator. A
zero-hit search is not proof that a phrase is absent from every original or attachment.
Metadata search and authenticated downloads remain available independently of content
indexing.

Every derivative is read within a byte bound and checked against its recorded
SHA-256. Missing or changed bytes defer the whole projection; partial chunks are
never published. A fixed retry delay allows other mail to proceed. No message
content, paths or exception details are emitted in scheduled logs.

## Consistency and recovery

D1 atomically replaces one message's chunks and coverage under an extraction
manifest and conversion-state snapshot fence. Conversion changes invalidate its
projection. Extraction removal or manifest replacement removes its old
projection through triggers. Stale workers cannot publish against an invalidated
manifest. Index rows use monotonic IDs; continuation tokens bind the query and
filters and move backwards through those IDs. New or rebuilt entries do not
enter later pages. Concurrent removal/reindexing can omit results, so restart a
search after indexing settles when completeness matters.

The index is rebuildable from MIME derivatives. It does not delete originals or
implement a retention policy. Keep the index private with the existing D1 archive
catalog. A future retention operation must delete the extraction row as well as
its derivative bytes; deleting only R2 bytes is not a complete deletion operation.

After activation, verify the indexed/extracted counts, a Japanese phrase, an exact
number, an attachment phrase and all source hashes with authorized test messages.
Synthetic tests establish implementation behavior, not production coverage.

References:
[D1 SQL support](https://developers.cloudflare.com/d1/sql-api/sql-statements/),
[FTS5 trigram tokenizer](https://sqlite.org/fts5.html#the_trigram_tokenizer),
[atomic D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
