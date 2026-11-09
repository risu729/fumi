# Cloudflare feature evaluation

Reviewed against official documentation and the pinned `cf@1.0.0-beta.28`
configuration/runtime types on 2026-11-10. Adoption decisions below are separate
from production verification. The current pipeline archives MIME in R2, preserves
Gmail forwarding, catalogs metadata in D1, and uses Workflows for durable catalog
processing and repair. Search, attachment conversion, model classification, and
outbound MCP sending remain future work.

## Adopt for the current pipeline

| Feature | Decision and purpose | Availability and constraints |
| --- | --- | --- |
| Workers Issues | Enable built-in failure grouping. Keep diagnostic fields fixed and sanitized. Do not configure external automations as part of enablement. | Open beta, available to all Workers accounts and free during beta. It processes new traffic, not historical failures. |
| Workflow instance concurrency | Set the catalog Workflow's concurrent-instance limit to **5**, allowing bursts to queue instead of overwhelming catalog work. This is an initial operating limit, not a measured throughput optimum. | Supported by the pinned native `exports.workflow({ concurrency: { limit: 5 } })` configuration. It does not provide per-message locking or exactly-once external effects. |
| Explicit Workflow retention | Preserve the existing three-day success/error retention and the durable D1 ledger. | Paid defaults changed to seven days for newer Workflows; explicit configuration avoids relying on a changing default. |

[Issues documentation](https://developers.cloudflare.com/workers/observability/issues/)
describes grouping uncaught exceptions, failed invocations, HTTP `5xx` responses,
and logged errors. The native setting is
`worker.observability.issues.enabled`. Source maps improve stack locations.
Handled operational failures must remain visible without logging mail, attachment
content, recipient addresses, SQL parameters, or raw service errors. Enabling
Issues alone does not prove a failure occurrence was captured.

The [Workflow API](https://developers.cloudflare.com/api/resources/workflows/)
defines a per-Workflow concurrency limit: excess instances queue until capacity
is available. This differs from account-scoped **step concurrency keys**, whose
API can return `403` when the account is not enabled. Step concurrency keys are
not a dependency of this change.

The [current limits](https://developers.cloudflare.com/workflows/reference/limits/)
allow 50,000 running instances/account on Paid, but that platform maximum is not
an appropriate application target. Waiting instances do not consume running
slots. Workflow retention is not archival retention or a substitute for the D1
terminal-state ledger.

[Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
includes CPU, requests, steps, and persisted state. Paid includes 500,000 steps
and 1 GB-month of state; overages are $0.80 per 100,000 steps and $0.20 per
GB-month, in addition to applicable Workers usage. Retries are excluded from the
step count, but their execution can still consume resources. A new configuration
does not establish an account-specific bill.

## Useful next, without expanding mail processing

**Sensitive outputs.** The generated runtime types support
`sensitive: "output"` on step configuration. Official
[subscription documentation](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/)
states sensitive step-completion outputs are redacted. This is useful additional
protection, but it is not a reason to return mail bodies, passwords, attachments,
or extracted text from a step. It does not establish that output was never
persisted, or sanitize parameters, exceptions, and explicit logs. Keep large and
sensitive artifacts in private R2 and return bounded identifiers/status only.

**Status and subscriptions.** Native `status()` and CLI instance inspection are
appropriate for bounded diagnostics. `WorkflowInstance.subscribe()` can replay
retained events and continue with live events; it supports filters and a resume
cursor, and its RPC resource must be disposed. Adopt it when a progress UI or
interactive observer exists. Do not add a permanent subscriber to the SMTP path
or replace scheduled repair with an ephemeral observer. Durable
[lifecycle event subscriptions](https://developers.cloudflare.com/workflows/reference/event-subscriptions/)
can later send completion/failure events to Queues, introducing a consumer and
normal queue costs.

**R2 diagnostics.** The
[November 3 metrics update](https://developers.cloudflare.com/changelog/post/2026-11-03-r2-request-error-breakdowns/)
adds regional request distribution and error breakdowns by HTTP status. Use these
existing dashboard views when investigating capture failures or throttling; no
additional application service is needed.

## Add with the corresponding feature, not before

### MIME and outbound email

[Email Sending](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
is a public beta with a native structured `send_email` binding. It accepts
text/HTML, CC/BCC, attachments, and threading headers. The legacy `EmailMessage`
path accepts existing raw MIME. This is not an inbound MIME parser: official
[Email Worker examples](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
still use `postal-mime` for parsing. Preserve the minimal ingress; perform future
parsing asynchronously with explicit limits.

Enable sending only with the outbound MCP capability and durable outbox.
Arbitrary recipients require Paid and an onboarded sending domain; the current
message ceiling is 25 MiB, with 50 combined recipients. Paid includes 3,000
outbound messages/month, then $0.35 per 1,000. Provider acceptance and recipient
delivery remain separate outcomes. Do not automatically resend or switch
providers after an unknown submission outcome.
[Limits](https://developers.cloudflare.com/email-service/platform/limits/),
[pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

### Document conversion and retrieval

[Workers AI Markdown Conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
is a beta utility callable through an AI binding. Most conversions are free;
image conversion can invoke billed Workers AI models. The
[supported-format list](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)
includes PDF, DOCX, spreadsheets, and images, not every Office or media format.
An image description is not a faithful OCR transcript. Preserve originals,
version derived representations, retain available source locations, and show
unsupported/encrypted/conversion-failed coverage explicitly.

For a future search pilot, prefer **AI Search first** for managed ingestion,
hybrid retrieval, and OCR; evaluate **D1 text search plus Vectorize** if metadata
filtering, freshness, or extraction control requires a custom pipeline. Do not
enable either for the current metadata-only catalog.

- AI Search is GA. Japanese keyword retrieval should use `trigram`; the default `porter`
  tokenizer is unsuitable for this content. Supported rich attachments can be converted
  automatically, so a separate hand-built text parser for every format is unnecessary.
  OCR is explicitly enabled, and encrypted files need an unlocked derivative.
  [Data sources](https://developers.cloudflare.com/ai-search/configuration/data-source/),
  [keyword search](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/).
- The
  [November 2 update](https://developers.cloudflare.com/changelog/post/2026-11-02-billing-postponed-default-sync-interval/)
  postpones billing to **December 1, 2026** and changes default source syncing to
  **24 hours**. Supported intervals extend down to 15 minutes. A mail search feature
  must explicitly define freshness; R2 archival success does not prove indexing
  completion.
- [AI Search limits/pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)
  set PDF limits at 10 MiB with OCR or 4 MiB without OCR, plain text at 10 MiB,
  and five custom metadata fields. Included monthly usage is 5 million ingestion
  tokens, 10 GB-month, and 1,000 queries each for semantic and full-text search.
  Overages include $0.75/million ingestion tokens, additional image processing,
  and $2/GB-month storage. Generation/external providers are separate.
- [Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/)
  is GA and bills vector dimensions, with embedding and extraction costs
  separate. Paid includes 50 million queried dimensions/month and 10 million
  stored dimensions; overages are $0.01/million queried dimensions and $0.05 per
  100 million stored dimensions. It supplies an index, not document extraction,
  access control, a keyword engine, or a complete mail RAG service.

### AI Gateway

Add [AI Gateway](https://developers.cloudflare.com/ai-gateway/) when model calls
are introduced, for inference analytics and rate/spend controls. It adds no value
to the current model-free catalog path. Review caching and payload logging before
processing private mail; neither should be enabled indiscriminately. Core
analytics, caching, and rate limiting are free, but inference is still billed.
Accounts creating their first gateway since September 24, 2026 use Workers Logs
pricing/retention; do not assume all persistent logging is free.
[Current pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

## Tooling and validation boundary

The pinned CLI schema includes native Issues configuration, Workflow export
concurrency/retention, instance inspection, and AI Search item/job commands.
Runtime types also expose sensitive outputs and subscriptions. This establishes
local API/configuration support, not account eligibility, remote behavior, or
successful deployment. Keep native `cloudflare.config.ts`; no Wrangler migration
or speculative dependency upgrade is needed.

For the immediate additions, run the existing local synthetic failure tests and
inspect deployed Issues/concurrency settings. This does not establish capture of
an actual production Issues occurrence; do not intentionally disrupt delivery
to generate one. Broader conversion, retrieval, sending, or model
features require their own synthetic acceptance cases and explicit activation.
