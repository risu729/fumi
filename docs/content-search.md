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

The `query` is a literal, case-insensitive phrase of 3–200 UTF-16 code units, with
at least three Unicode characters. Japanese phrases and exact numeric strings
work without whitespace segmentation. Quotes and FTS operators are treated as
data. The optional `filters` argument uses the existing `from:`, `to:`, `subject:`,
`after:`, `before:` and `has:attachment` metadata syntax. Shorter terms fail
explicitly instead of silently producing empty results. This is lexical retrieval,
not semantic or hybrid retrieval; AI Search and Vectorize evaluation remains open.

## Coverage and resource bounds

The scheduled repair indexes at most three extracted messages per invocation.
It selects present Email Routing sources before historical Gmail sources, then
uses remaining capacity for backfill. Retry delays still apply within both groups.
It processes messages and attachments sequentially. It indexes at most the first
100,000 characters of the decoded plain-text body and the first 16,000 characters
of up to eight UTF-8 `text/plain` attachments, each at most 64 KiB. Chunks contain
3,500 characters with a 200-character overlap so supported phrases can cross
chunk boundaries. One source can produce multiple hits. Results are ordered by
index entry, not relevance, with at most 50 chunks per page.

Completed searchable conversion derivatives add at most four attachments and
64,000 characters per message. Derived citations expose both derivative and
original hashes/URLs, with the representation explicitly labeled. Decrypted PDF
binaries, ZIP extraction manifests, HTML-only bodies and non-UTF-8 text are not
silently treated as text. Unsupported, pending or blocked conversion is excluded.
Per-message coverage lists conversion state and omitted or truncated content.
Aggregate coverage reports indexed versus extracted messages; pending/blocked
MIME extraction is excluded from this denominator. A zero-hit search is not proof
that a phrase is absent from every original or attachment. Metadata search and
authenticated downloads remain available independently of content indexing.

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
