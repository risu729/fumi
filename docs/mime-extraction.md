# MIME extraction

Status: implemented and tested locally, 2026-11-11. The production catalog pipeline
has not yet been upgraded to this stage. No real mail is parsed by repository tests.

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

## Limits and coverage

The ingress archive limit remains unchanged. Extraction deliberately supports a
smaller bounded subset until larger messages are measured in the actual runtime.

| Bound | Limit |
| --- | --- |
| Original MIME input | 4 MiB |
| Parser header budget, across parts | 64 KiB |
| MIME nesting | 16 |
| MIME parts | 64 |
| Decoded attachments | 32 |
| Each decoded body or attachment | 4 MiB |
| Total decoded body/attachment bytes | 8 MiB |
| Body JSON, including escaped characters | 8 MiB |
| Each metadata JSON value | 32 KiB |
| Selected string fields | 4 KiB |
| Original stream read | 10 seconds |

The parser's header budget charges a minimum per line, so it may reject many small
headers before their literal byte count reaches 64 KiB. Input, structure and
decoded-output limits are complementary. Headerless input is blocked; other
malformed mail may be parsed tolerantly by the library. Successful decoding is not
proof of RFC conformance, safe HTML, a safe attachment, or complete search coverage.

Permanent coverage failures are recorded as `blocked` with fixed codes, including
missing/changed originals, invalid metadata, input/structure/output limits or a
conflicting derivative. A blocked extraction does not mark the processing job
complete. Storage/service outages throw fixed diagnostics for Workflow retries.
No exception text, body, address, filename or subject enters Workflow results/logs.

## Persistence and retries

Derived writes are conditional and content-addressed. Retries validate an already
stored object's size and SHA-256 rather than overwrite it. The manifest is written
last; D1 completion follows all R2 writes and a final original-version check.
Every D1 mutation requires the matching running `mime-v1` instance. A stale attempt
may leave harmless derivative objects but cannot publish a completion record.
Partial writes remain unreferenced until a successful retry; automatic orphan
deletion is not implemented.

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
