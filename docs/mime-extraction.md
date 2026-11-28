# MIME extraction

Status: implemented and activated in production on 2026-11-11. Controlled acceptance
verified original, body and attachment bytes and durable extraction state. Private
evidence stays outside the repository; repository tests use synthetic mail only.

## Stored representations

`mime-v1` runs after catalog observation in the existing Workflow. It reads the
original from R2, validates its ingress identity and SHA-256 metadata, and verifies
the actual bytes before parsing with pinned `postal-mime@4.2.1`. It never replaces
or reserializes the original. Separate SMTP deliveries remain separate catalog
and extraction rows even when their bytes match.

D1 `mail_extractions` holds `(raw_key, extractor_version)`, coverage state, original
digest/size, the responsible Workflow instance and bounded JSON metadata. Selected
headers include subject, sender/recipients, date, Message-ID, In-Reply-To and
References. These are untrusted message claims, separate from the SMTP envelope.
No thread grouping or identity/authenticity inference is performed.

R2 stores body JSON, available text/HTML parts, decoded attachment bytes and a
manifest containing their hashes and sizes. Keys use extractor version, original
digest, representation kind and derivative digest; a filename or Content-ID never
chooses a key. Attachment array indexes preserve distinct parts even when identical
bytes share an object. The manifest records the parser version, original digest and
attachment metadata. D1 links each source to that manifest.

HTML is stored as opaque downloadable bytes, without sanitization, rendering or
remote resource fetching. Consumers must not render it directly. Attached
`message/rfc822` remains an attachment and is not merged into its parent's body.
MIME decoding does not open ZIP/PDF files, decrypt, OCR, classify or index them.
After MIME completion, the Workflow separately attempts the bounded local lexical
projection. Its retries cannot mark a successful extraction failed. Attachment
conversion and managed semantic calls remain separately configured repair work;
completed conversion changes invalidate lexical coverage for the existing repair.

## Limits and coverage

Extraction accepts originals up to Email Routing's 25 MiB ingress limit. Imports
can archive larger originals (Takeout entries over 25 MiB stream into R2); those stay
`blocked` with `input_too_large`.

| Bound | Limit |
| --- | --- |
| Original MIME input | 25 MiB |
| Parser header budget, across parts | 64 KiB |
| MIME nesting | 16 |
| MIME parts | 64 |
| Decoded attachments | 32 |
| Each decoded text or HTML body | 4 MiB |
| Each decoded attachment | 25 MiB |
| Total decoded body/attachment bytes | 32 MiB |
| Body JSON, including escaped characters | 8 MiB |
| Each metadata JSON value | 32 KiB |
| Selected string fields | 4 KiB |
| Original stream read | 10 seconds |

The parser's header budget charges a minimum per line, so it may reject many small
headers before their literal byte count reaches 64 KiB. Input, structure and
decoded-output limits are complementary. Input whose first line is not a header is
blocked as `invalid_mime` at any size. Input that starts with a header but has no
blank line ending the header section within the 64 KiB header budget is
`parser_limit` when the input is longer than the budget, and `invalid_mime` when the
input ends first. Other malformed mail may be parsed tolerantly by the library.
Successful decoding is not proof of RFC conformance, safe HTML, a safe attachment, or
complete search coverage.

### Input limit decision and memory measurements

On 2026-11-28 13:02 UTC the owner approved raising the provisional 4 MiB input limit
as far as measurements allow. At that time 212 `mime-v1` extractions were `blocked`
with `input_too_large` (4,196,105 to 29,789,263 bytes): 2 live captures, 195 Gmail
imports and 15 Outlook PST items. 207 of them are at most 25 MiB.

A Worker isolate has 128 MB for its heap and `ArrayBuffer`s, shared by every request
the isolate runs. Extraction holds the whole original, and postal-mime decodes each
attachment into 100 KiB chunks and then joins them through a `Blob` into one
`ArrayBuffer`, so while it finishes the largest attachment it holds the original plus
three copies of that attachment. Passing postal-mime the whole `ArrayBuffer` instead
of a `Uint8Array` view avoids its copy of the original (2026-11-28 change).

The peak was measured on synthetic messages with the same code and postal-mime in V8
(Node 26), as live heap plus `ArrayBuffer` bytes after a forced GC at each `Blob` join
and R2 write, counting each join as two extra copies as in workerd. Before and after
the change, at 25 MiB:

| Message shape (25 MiB) | Before | After | CPU |
| --- | --- | --- | --- |
| One base64 attachment | 106.6 MiB | 81.5 MiB | 0.6 s |
| Ten base64 attachments | 75.5 MiB | 50.4 MiB | 0.8 s |
| Thirty base64 images | 71.9 MiB | 46.8 MiB | 1.4 s |
| 2 MiB quoted-printable HTML and eight images | 72.6 MiB | 54.6 MiB | 0.9 s |
| One 8bit text attachment | 76.1 MiB | 76.1 MiB | 0.9 s |

With one large base64 attachment the peak is about 3.25 times the original (94.3 MiB
at 29.2 MiB, 104 MiB at 32 MiB), which leaves too little of the 128 MB for the
Worker's own heap and other requests in the same isolate above 25 MiB. The input limit
is therefore 25 MiB. Bodies keep their 4 MiB bound because search indexing and body
reads load them whole; only attachments may be larger. Two large extractions in one
isolate can still exceed the memory limit; the failed job then keeps its original and
can be retried with the operator primitive. Raising the limit further needs a parser
that joins decoded chunks without the extra copies.

Permanent coverage failures are recorded as `blocked` with fixed codes, including
missing/changed originals, invalid metadata, input/structure/output limits or a
conflicting derivative. A blocked extraction does not mark the processing job
complete. A blocked row keeps the earlier derived keys, but no reader serves them; see
[agent mail](agent-mail.md#tools-and-bounded-results).
Storage/service outages throw fixed diagnostics for Workflow retries.
No exception text, body, address, filename or subject enters Workflow results/logs.

## Persistence and retries

Derived writes are conditional and content-addressed. Retries validate an already stored
object's size and SHA-256 rather than overwrite it. Every input, structure,
decoded-output and metadata bound, including the stored attachment records with their
keys and digests, is checked before the first derivative write. A permanent coverage
block therefore writes no derivative; only a conflicting derivative or a source change
found after the writes can block a partly written attempt. The manifest is written last;
D1 completion follows all R2 writes and a final original-version check. Every D1
mutation requires the matching running `mime-v1` instance. A stale attempt may leave
harmless derivative objects but cannot publish a completion record. Partial writes
remain unreferenced until a successful retry; automatic orphan deletion is not
implemented.

An existing extraction digest cannot silently be replaced with another original.
As with the archive, originals must remain immutable: R2 and D1 cannot atomically
lock an original against an independent external overwrite after the final check.
The D1 coverage record and manifest are durable; Workflow history is not their
source of truth. Retry of a failed job uses the existing fenced operator primitive.
No public retry API is exposed.

## Rollout

1. Review and authorize the existing archive scope. The upgraded scheduled repair
   discovers up to ten sources without a `mime-v1` job, including originals already
   completed by `catalog-v1`. It does not import Gmail or send notifications.
2. Apply additive migration `0003_mail_extractions.sql` to the intended D1 database
   before Worker activation. Preserve the catalog and prior processing ledger.
3. Activate the reviewed Worker version. Existing catalog jobs retain their original
   step names and identities; pending legacy dispatches continue to be repaired.
4. Separately verify synthetic production forwarding, original hash, body/attachment
   hashes, D1 coverage and Workflow completion. Confirm blocked coverage and resource
   usage separately; CI passing is not production acceptance.

Rollback to the previous catalog Worker leaves data intact but no longer repairs
MIME jobs. Inspect active instances and retain a version that understands their
pipeline until they are reconciled. Do not delete extraction rows to force retries.

## References

- [postal-mime source and options](https://github.com/postalsys/postal-mime)
- [Workflow execution rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
