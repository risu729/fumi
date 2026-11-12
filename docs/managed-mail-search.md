# Optional managed body corpus and semantic retrieval

This adapter incrementally uploads verified MIME plain-text bodies and completed
attachment conversion/OCR text to a dedicated
private AI Search instance. `search_mail_semantic` retrieves evidence using managed
vector search (`mode: semantic`) or vector/keyword fusion (`mode: hybrid`). It does
not generate answers or execute mail instructions. The existing local literal
phrase search remains available independently.

Implementation and synthetic tests do not establish a production corpus, search
quality, account configuration or paid processing. No resources or credentials are
created by this code.

## Activation and scope

Apply migration `0013_managed_mail_search.sql`. An administrator must separately
provision a dedicated **instance** binding named `MANAGED_MAIL_SEARCH`, review its
privacy, retention and pricing, and privately set `MANAGED_MAIL_SEARCH_CONFIG`:

```json
{"version":1,"enabled":true,"revision":"operator-reviewed-v1","instanceId":"private-corpus","maxUploads":100,"maxQueries":100,"hybrid":true}
```

Absent configuration, `enabled:false`, or an absent binding disables ingestion and
makes the semantic tool return `managed_search_not_configured`. A strict enabled
configuration requires version one, an immutable revision, expected instance ID,
finite upload/query caps (1–10,000 each), and the hybrid flag. The binding's `info()`
must match the configured ID and report vector indexing; hybrid retrieval also
requires keyword indexing. The application never changes instance configuration.
Bindings and configuration are operator capabilities, never mail/MCP arguments.

Mount `repairManagedMailCorpus(env)` after MIME extraction repair in the scheduled
handler. It discovers at most three current bodies and processes at most two
parts per invocation. It includes live and imported archive sources without
forwarding, sending, generating mail events or enabling historical notifications.

The corpus includes UTF-8 MIME plain-text bodies up to one MiB and at most four
completed searchable attachment derivatives per message, each up to 256 KiB. It reads
the immutable MIME manifest, verifies its own content-addressed SHA-256, verifies
the original MIME SHA and exact body/attachment reference, then checks the complete text
bytes/hash before upload. It uploads that existing body representation unchanged;
it does not ask an LLM to rewrite messages. HTML-only bodies, oversized text and
binary attachments are excluded. The independently optional migration0011
attachment projection supplies only current complete `managed_document_text`,
`managed_ocr_indexed_text` and `local_zip_text` derivatives. Its exact original part,
manifest, conversion policy, representation and result hash are fenced throughout
ingestion and retrieval. A local decrypted PDF or ZIP extraction manifest is not
searchable text. Attachment OCR/conversion keeps separate provider bindings,
ledgers, provenance and retention; this corpus copies only its verified local text
into the dedicated retrieval instance. If migration0011 is absent, body retrieval
continues with explicit disabled attachment coverage.

## Durability and budgets

The per-part ledger pins original MIME SHA, current extraction manifest, source text
key/hash, original attachment key/hash where applicable, conversion policy,
configuration policy hash, generated remote item key and provider item ID. Remote keys
are derived from immutable source/part/text/policy identities; filenames or message
content cannot choose URLs, remote destinations or object paths.

Each conditional source lease precedes asynchronous work. An atomic D1 batch
reserves one upload and marks `uploading` before the remote call. A crash or timeout
after that point becomes `unknown`, which never resubmits automatically. A unique
upload-attempt identity remains in the call ledger even if MIME invalidation
removes its rebuildable projection. Rediscovering the same original MIME/part/text
and policy therefore preserves uncertainty even if re-extraction changes the
manifest or derivative keys. If the prior
response durably recorded a provider item ID, rediscovery can poll that same item.
Received
item IDs are persisted as `submitted`; later runs poll that exact ID/key until
`completed`, a fixed failure, or a 24-hour indexing deadline. Submitted polling
never uploads again. Source invalidation removes the local projection and prevents
late completion or search results from becoming visible.

If a projection is rebuilt while an older upload remains in flight, it can remain
quarantined even if the old response later records an item ID. This conservative
case requires reviewed reconciliation or a deliberate new policy revision; it
never starts an automatic duplicate upload.

Upload and query reservations are separate finite counters for the exact validated
configuration. They are not refunded after uncertain outcomes. Changing revision
or other policy fields establishes new counters and reprocesses the corpus, so do
so deliberately. Caps count application calls, not currency, tokens, documents
processed internally by the provider, or provider retries. Query text and provider
exceptions are never written to this ledger or logs. Provider methods and bounded
source streams have five-second parent deadlines; timeout cannot cancel an already
accepted provider request.

## Evidence returned through MCP

`search_mail_semantic` requires `mail:read`. Query length is 1–1,000 characters and
results are limited to ten. Metadata filters use the existing archive operators;
`archive_source` and retained label IDs are optional. The tool requests at most
thirty ranked provider candidates and applies these filters locally. This may
return fewer matches even when additional relevant documents exist. It reports
that coverage explicitly and offers no pagination or completeness guarantee.

The current AI Search binding performs retrieval only, with query rewriting,
reranking, similarity cache and answer generation disabled. `return_on_failure`
is false so a provider failure becomes an explicit unavailable result rather than
a successful empty search. Provider scores rank candidate relevance; they do not
establish factual accuracy.

Every returned item key must resolve to a current, ready local ledger entry under the
current policy. The adapter reads and hashes the local source text again and requires
the returned passage to occur verbatim in that source. It checks the current manifest
once more after reading. Unmapped, stale, corrupt or transformed passages are omitted.
Returned excerpts are at most 800 characters and remain untrusted mail content. Body
citations contain the exact body SHA and authenticated `/text` URL. Attachment citations
distinguish derivative SHA and `/conversions/part_N/<sha>` from original attachment SHA
and `/attachments/part_N`. Both include original MIME SHA and `/raw` URL. Provider chunk
IDs are descriptive metadata; they never become download paths or authorization.

Local invalidation does not delete remote items or prior revision copies. Private
remote retention and eventual cleanup require a separate reviewed decision. Local
source fences keep those old copies out of tool results, and original archive
bytes remain preserved independently.

References:
[AI Search search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/),
[item uploads and polling](https://developers.cloudflare.com/ai-search/api/items/workers-binding/),
[instance information](https://developers.cloudflare.com/ai-search/api/instances/workers-binding/),
[search modes](https://developers.cloudflare.com/ai-search/concepts/search-modes/).
