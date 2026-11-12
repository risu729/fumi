# Attachment conversion and local ZIP extraction

Status: implemented with synthetic Workers tests. Controlled production checks
on 2026-11-12 verified local ZIP extraction, isolated child PDF decryption and
managed DOCX conversion, plus managed OCR of the decrypted PDF and a PNG, under a
private source allowlist. All four conversions completed; eleven authenticated
original/derivative/member downloads passed full hash and provenance checks, and
the expected text and amounts were present. All four lexical marker queries also
passed exact original/derivative hash, authenticated URI and supported-excerpt
checks. Conversion opt-in was then disabled; the three reserved managed calls
remained complete with no additional submissions. A separate bounded historical
text-source sample verified lexical, semantic and hybrid retrieval with supported
excerpts and authenticated text/raw hashes. This does not establish semantic
coverage of every converted attachment, archive-wide conversion coverage or
hostile-input CPU/memory limit enforcement.
Production evidence and exact source identities remain private. The service does
not require converting each original into a custom `.txt` before managed ingestion.

## Supported paths

| Input | Processing | Representation |
| --- | --- | --- |
| DOCX, XLSX/XLSM/XLSB/XLS, ODT/ODS, CSV, HTML | Workers AI `AI.toMarkdown(original Blob)` with embedded image conversion disabled | `managed_document_text` |
| PDF, PNG, JPEG, WebP | Dedicated AI Search instance with OCR enabled: upload original Blob, poll item, retrieve indexed chunks | `managed_ocr_indexed_text` |
| ZIP, including AES and ZipCrypto | Local `@zip.js/zip.js` 2.24.0 custom core; verify authentication/CRC before saving members | `local_zip_text` or `local_zip_manifest` |
| Password-protected PDF | Fresh isolated LibPDF child; verify authentication, unencrypted save and reopen before storing; optional OCR on the decrypted derivative | `local_decrypted_pdf`, optionally `managed_ocr_indexed_text` |
| Other or oversized input | Explicit fixed coverage reason | Blocked, never claimed indexed |

Managed OCR output can include recognized text and managed document conversion;
it is a derived indexed representation. AI Search chunk byte ranges describe its
indexed representation, not original PDF byte offsets. Page numbers are not
invented. Image descriptions from Markdown conversion are not called OCR: that
conversion path and embedded image generation are disabled here.

References:
[Workers AI binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/),
[conversion behavior](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/),
[formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/),
[AI Search OCR](https://developers.cloudflare.com/ai-search/configuration/data-source/),
[instance binding](https://developers.cloudflare.com/ai-search/api/instances/workers-binding/),
[upload, status and chunks](https://developers.cloudflare.com/ai-search/api/items/workers-binding/).

## Private activation

Apply migration `0011_attachment_conversion.sql`. Call
`repairAttachmentConversions(env)` from the scheduled handler before
`repairContentSearch(env)`. The former is disabled without private opt-in.
Provisioning an AI binding or OCR instance is an operator action, not a side effect
of mail receipt. The application never creates/updates an AI Search instance,
changes its OCR settings, or enables a public endpoint.

The optional private `ATTACHMENT_CONVERSION_CONFIG` must match this strict schema:

```json
{"version":1,"enabled":true,"revision":"operator-reviewed-v1","maxCalls":20,"documents":true,"ocr":false,"zip":true,"pdf":false}
```

For synthetic-only acceptance, the optional `sourceRawKeys` array restricts discovery,
claims and processing to one through ten distinct exact canonical original keys.
Use `ingest/YYYY-MM-DD/<UUID-v4>/raw.eml`, the shared layout for Email Routing and
imported Gmail originals. Receipt keys, prefixes, invalid dates, duplicates and
noncanonical paths are rejected. Keys come from trusted catalog observations,
never from a message or MCP argument. An absent array retains archive-wide
processing; an empty array is invalid. The allowlist participates in the policy
hash, so changing or removing it deliberately starts a new policy budget and can
reprocess selected parts. A call cap alone does not restrict processing to test
mail. Existing completed downloads remain governed by current MIME provenance.

`enabled:false` disables work. `documents` also requires an `AI` binding. `ocr`
requires `ATTACHMENT_OCR`, a server-owned **instance** binding, and its `info()`
must confirm `indexing_options.use_ocr:true` before upload. Use a dedicated private
instance; copies of opted-in originals enter its built-in storage and retention
must be managed there separately. No instance name, model, URL or credentials can
come from a message or MCP request. Absent configuration/bindings makes no paid
requests. Synthetic tests inject these documented binding methods locally.

`maxCalls` is a finite reservation cap (1–1000) for the exact canonical policy,
including revision and options. A reservation precedes each potentially billable
document conversion or OCR upload and is never refunded after an uncertain
outcome. It limits requests, not currency, tokens, provider retries or OCR pages;
approve provider pricing and instance settings before activation. Policy changes
create a new budget and reprocess previously covered parts, so change them
deliberately. Bump revision to retry an uncertain outcome or permanent failure.

Paid attempt identities bind raw key, original MIME SHA, part index, exact uploaded
attachment hash/size/MIME and policy. Rebuildable manifest/object paths are fences,
not paid identities. Their receipts survive projection deletion: rediscovery of
the same immutable source bytes restores
known submitted/completed outcomes or quarantines a prior unknown/reserved attempt,
never automatically bills the same identity again. A provider receipt accepted
during MIME invalidation remains durable but is exposed only through a current
fenced projection. A late known receipt can recover a quarantined projection.

Bindings and secrets are optional runtime capabilities; adding a TypeScript type
does not provision or preserve them across deployment. Verify native configuration,
binding persistence and a protected synthetic acceptance before enabling real mail.

Local PDF decryption additionally requires `pdf:true` and `PDF_LOADER`. The exact
locked native `cf/config` API supplies `bindings.workerLoader()`; the build flag
`FUMI_PDF_PARSER_ENABLED=1` includes that binding, absent by default. It points to
no external resource. This opt-in is separate from the conversion policy. The
pinned parser is bundled by `mise run build:attachment-parser` before type checks,
tests and application builds. Its generated JavaScript is imported as **text**,
never executed inside the archive isolate. Console calls are dropped from this
child bundle, including library diagnostics.

## Durability and bounds

Discovery examines at most three complete MIME manifests per invocation and
processes at most two parts sequentially. A D1 lease serializes scheduled runs.
Every source is bounded to 2 MiB and checked against its MIME part SHA-256 and
size before local processing or external upload. Outputs are bounded to 100,000
characters and 256 KiB. Provider methods have a five-second parent deadline;
timeout does not cancel an already accepted provider request. Unknown submission
outcomes are retained as `unknown` and are not automatically submitted again.

OCR submission persists the item ID before a later invocation polls. Queued/running
items defer for five minutes; polling never uploads again. Complete ingestion must
fit one page of at most 32 indexed chunks, all returned with matching item identity
and complete pagination. Partial/oversized output is blocked. Polling stops after
24 hours with explicit coverage. Fixed diagnostics omit provider exception text.

The ledger distinguishes `pending`, `running`, `submitted`, `complete`, `blocked`
and `unknown`. Each result records source manifest, original key/hash/size/MIME,
policy hash, representation, derivative key/hash/size and provider provenance.
Writes are fenced by the current extraction, exact part identity and lease token.
A crash after a paid call cannot cause automatic duplicate submission. R2 artifacts
are content-addressed; D1 exposes them only after durable verification/commit.
MIME invalidation removes conversion and search projections, preserving originals.
Conversion emits no mail events, sends or historical notifications.

## Passwords and ZIP members

The trusted `AttachmentPasswordResolver` callback receives only canonical raw key,
attachment SHA-256 and candidate limit eight. The scheduled pipeline supplies the
bounded related-mail resolver: same source kind/namespace, sender and recipient set,
within 30 days, and the same parsed RFC thread, normalized subject or an exact
attachment-filename reference. It checks at most 12 metadata candidates and reads at
most four verified UTF-8 bodies, each at most 24 KiB, with one-second get/stream
deadlines and a four-second lookup window. Password-shaped English or Japanese hints
remain guesses until cryptographic verification. Untrusted message text never grants
archive access. A private `ATTACHMENT_PASSWORDS` JSON dictionary keyed by original
SHA-256 supplies optional manual candidates. Both sources are validated and combined
with at most eight distinct strings of 1–128 characters. No credential is accepted
through MCP or attachment HTTP routes. Password lookup has a five-second deadline.
Candidate strings and provider/parser exceptions are never persisted in the ledger,
exposed through MCP or logged.

Cryptographic verification decides success. ZIP processing permits eight entries,
2 MiB per member, 4 MiB total expansion, a maximum 40:1 declared expansion ratio,
and a shared five-second abort signal. It rejects unsafe paths, corrupt payloads,
and nested processing; no filesystem, worker scripts or WASM are used. Password
required/rejected coverage is reconsidered hourly for at most eight lookup rounds,
allowing a later password message to arrive. Further attempts require a deliberate
policy revision. Other permanent failures are not retried automatically.

Verified members are separate immutable R2 derivatives. UTF-8 `.txt`, `.md` and
`.csv` members contribute searchable text; other members remain downloadable with
explicit `unsupported_member` coverage. Nested documents/archives are not recursively
converted. A ZIP without supported text still exposes an extraction manifest and
members without falsely indexing manifest metadata as document evidence. Candidate
values are redacted from newly generated searchable ZIP text before hashing it.
This does not retroactively remove password text already present in original mail.

## Search and authenticated downloads

Completed searchable derivatives enter the existing lexical index. Each message
adds at most four converted attachments and 64,000 derived characters; omitted
and truncated projections are explicit. Search and `read_email`/`read_attachment`
expose conversion coverage. A conversion-state snapshot fences index replacement
so an in-flight rebuild cannot publish stale derivative citations.

Derived citations have `representation`, derivative `sha256`, original
`original_sha256`, `file_uri` and `original_file_uri`. The derivative URL is
`/api/mail/<id>/conversions/part_<index>/<sha256>`. Verified ZIP member descriptors
add `/members/<index>/<sha256>`. All downloads require the existing same-origin,
Access/JWT and `mail:read` checks, verify current MIME identity and exact bytes,
and use opaque attachment responses with no-store and a sandbox CSP. Original
attachments and MIME remain available independently. OCR is not proof that a scan
was transcribed correctly; inspect original visual evidence when accuracy matters.

Retention must reconcile archive, extracted members, local text and remote OCR
storage, including paid-attempt receipts/tombstones. This implementation does not
delete originals or remote AI Search items.

## Isolated encrypted PDF bounds and evidence

`pdf-lib`'s `ignoreEncryption` bypasses a guard and does not decrypt. PDF.js accepts
passwords but renderer assumptions and resource limits need separate evaluation.
LibPDF 0.5.3 is a stronger pure-JS candidate: a synthetic AES-256 PDF was decrypted,
saved unencrypted and reopened in actual workerd, including a fresh Worker Loader
child with no bindings/network and configured CPU/subrequest limits. Wrong-password
`PDF.load()` can return an unauthenticated document: `getSecurity().authenticatedAs`
must be checked before claiming success. New RC4/AES-128 fixture generation is not
supported by that version, despite decryption APIs covering older revisions.

The parser never runs in the archive isolate. Each candidate gets a fresh Dynamic
Worker containing only trusted build-time code, with no bindings, no outbound
network, zero subrequests and a fixed 2,000 ms CPU ceiling. The parent bounds each
RPC to five seconds and the candidate sequence to ten seconds. Inputs and saved
PDFs are at most 2 MiB; parsed page counts are limited to 100 and the registry's
next object number to 2,000. The decrypted PDF is saved and reopened without
credentials to verify removal of encryption and page-count consistency. Original
encrypted bytes are retained, including when parsing fails.

LibPDF exposes no decoded-stream byte/depth budget and uses `pako.inflate()`. A
parent timeout cannot interrupt synchronous parsing; the child isolate and platform
128 MiB memory limit contain that parser independently. There is no configurable
per-child memory ceiling here. CPU, memory or RPC failures become fixed
`pdf_resource_limit_or_unavailable` coverage; malformed PDFs, excess structure,
and invalid credentials have explicit results. Local workerd tests prove child
execution, compressed AES-256 decryption, wrong-password rejection, 101-page
rejection, malformed compressed input and parent output/resource-failure handling.
The native built artifact test runs the complete synthetic capture/MIME/scheduled
decryption/R2 path. Controlled production acceptance also verified the isolated
decryption path. Hostile-input limit enforcement still needs separate synthetic
production acceptance; no CPU or OOM enforcement is claimed from a successful
decryption. No brittle PDF token filter substitutes for isolation.

Without OCR the decrypted PDF is downloadable and explicitly excluded from text
indexing. With opted-in OCR, the managed service receives the verified decrypted
PDF, and provenance retains both original encrypted and decrypted hashes. Before
indexing returned OCR text, candidates are resolved and verified again for
redaction; loss of a password defers the existing submission instead of uploading
again. The first upload's identity remains durable throughout that wait.

References: [LibPDF](https://github.com/LibPDF-js/core),
[pdf-lib encryption](https://github.com/Hopding/pdf-lib#encryption-handling),
[Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/getting-started/),
[custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[zip.js custom core](https://gildas-lormeau.github.io/zip.js/api/).
