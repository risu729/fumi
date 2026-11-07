# Roadmap

Status: development foundation and initial phase-1 runtime implemented,
2026-11-07. Checked items describe completed implementation or preparation;
production acceptance is separate. Unchecked items remain future work.

## Phase 0: development foundation

- [x] Public repository with a single TypeScript package and locked dependencies.
- [x] mise tasks, hk hooks, lint/format/type checks, workflow checks and secret scan.
- [x] GitHub Actions CI and shared Renovate configuration.
- [x] Architecture and library proposals with explicit evaluation gates.

## Phase 1: preserve delivery and capture new mail

- [x] Inventory existing Email Routing routes, verified Gmail destinations, loops,
      and specialist Workers; design a staged cutover and rollback.
- [x] Add the cf configuration and generated runtime types; locally test the email
      handler before enabling any route. No placeholder production resources.
- [x] Implement Gmail forwarding and original MIME capture in private R2.
- [x] Record envelope metadata, content hash, original size, ingress provenance,
      durable ingest status and forwarding outcome independently.
- [x] Specify duplicate handling and partial R2/receipt/forwarding failure recovery.
      D1 and Queue failure handling belongs to their later implementation.
- [ ] Automate archive-gap monitoring and reconciliation from Gmail.
- [x] Bound memory and MIME sizes; test actual length, capture timeouts, oversized mail,
      malformed MIME, duplicate deliveries, and forwarding loops.
- [x] Establish payload-free application logs, observability and manual recovery.
- [ ] Configure alert delivery and an explicit retention/deletion policy beyond
      the initial keep-all behavior.
- [x] Complete and record staged production acceptance for selected routes.
- [ ] Extend capture to remaining routes after checking specialist compatibility.

See the [ingress implementation and runbook](ingress.md). Private route inventory,
rollback snapshots and real-message acceptance evidence stay outside this public repo.

Done when: controlled messages arrive in Gmail and have byte-verified R2 originals;
failure tests demonstrate an observable recovery path. Local tests alone do not
establish production delivery.

## Phase 2A: historical import and attachment-aware retrieval

- [ ] Read-only Gmail OAuth and resumable backfill, explicitly including historical
      SENT messages, labels,
      thread linkage, dates and attachment provenance. Never mutate Gmail in import.
- [ ] Rate limits, bounded concurrency, checkpoints only after durable commits,
      reconciliation counts and duplicate handling across live/backfill sources.
- [ ] Extract MIME parts into versioned derivatives; preserve original bytes.
- [ ] Use managed conversion/OCR for supported attachments where suitable; compare
      optional visual retrieval without requiring a custom `.txt` for every file.
      See [attachment representations](attachment-retrieval.md).
- [ ] Build keyword/hybrid retrieval baseline and read-only authenticated MCP tools
      for search, thread/message retrieval and attachment access with citations.
- [ ] Compare AI Search with explicit D1/Vectorize indexing on Japanese mail,
      exact numbers, sender/date constraints and attachment-heavy questions.
- [ ] Evaluate DecisionRAG separately against that baseline; measure recall,
      citation accuracy, incremental update cost, latency and total model cost.
- [ ] Handle deletions/retention consistently across originals, derivatives and
      indexes; distinguish import completion from indexing completion.

## Phase 2B: routing and selective model use (parallel with 2A)

- [ ] Revisit the selected CEL language before implementation: choose and pin a
      Workers-compatible evaluator, test the supported subset and resource limits,
      and confirm the owner-maintained plugin contract.
- [ ] Port private inbox policy as private configuration; retain rule precedence,
      thread deduplication, acknowledgements/case-state checks and urgent escalation.
- [ ] Define a plugin manifest and adoption contract. Integration owners publish
      their own rules and handlers; fumi pins and adopts them rather than maintaining
      copies of their business rules. See [plugins](plugins.md).
- [ ] Add a specialist-owner adapter; Kogane needs a new return-value contract.
- [ ] Deterministic rules first, bounded Claude/GPT structured classification only
      for unresolved cases, then allowed webhook dispatch such as a Grok bot.
- [ ] Route only to the active destination/account, with a lease or generation
      fence so switching does not wake both old and new destinations.
- [ ] Implement authenticated dispatch, stable idempotency keys, an outbox,
      bounded retries, a dead-letter path and status reconciliation for ambiguity.
- [ ] Run rules/model decisions in shadow mode and replay synthetic cases before
      allowing notifications. Backfill never triggers historical notifications.
- [ ] If Gmail archiving is later enabled, treat it as a separate authorized action:
      remove only INBOX, verify the result, retain labels and never advance on failure.

## Phase 2C: outbound email through MCP

- [x] Select native Cloudflare Email Sending on the Workers Paid deployment baseline.
- [ ] Verify the sender domain and binding configuration before implementing sending.
- [ ] Add separately scoped draft, preview, send, reply and send-status MCP tools.
      A permitted explicit send invocation may send directly; an interactive
      confirmation screen is not a universal requirement.
- [ ] Authorize sender identities, recipients, attachments and reply targets from
      trusted caller grants. Mail/search content cannot grant send permission.
- [ ] Persist a stable logical send ID, validated input and outbox state before
      provider submission. Reject key reuse with different content.
- [ ] Reconcile uncertain submission outcomes; do not blindly retry a send after
      a timeout. Track accepted, delivered, bounced and failed as distinct states.
- [ ] Archive the submitted content and provider receipts, linking replies to
      source messages. Do not claim these are the provider's final wire bytes.
- [ ] Test thread headers, attachment limits, duplicate calls, timeout after
      acceptance, authorization failures and provider delivery events.

See [outbound MCP](outbound-mcp.md). This is future functionality; no actual
message is sent and no sending domain is configured by the bootstrap.
Ongoing Gmail Sent synchronization is out of scope; phase 2A still imports
historical SENT messages. Future fumi sends stay in fumi's own sent archive.

## Phase 3: encrypted attachments

- [ ] Detect supported encrypted ZIP/PDF formats and preserve encrypted originals.
- [ ] Search related authorized messages for password candidates; optionally use
      an LLM to extract candidates with source references, never as proof of success.
- [ ] Verify decryption locally with bounded attempts, size/time/expansion limits;
      save a distinct decrypted derivative only on verified success.
- [ ] Keep passwords out of logs, MCP results and search indexes. Apply separate
      access controls and retention to the newly readable derivative.
- [ ] Evaluate pure JS/WASM on the actual Workers runtime. Unsupported or oversized
      formats remain pending; do not silently require an external compute service.

## Phase 4: optional web client (low priority)

- [ ] Evaluate mailbox-only UI reuse using [maintained project evidence](web-client-options.md).
      Compare Cloud Mail as an application with independent components and a fumi
      API adapter. Calendar, booking and drive features are out of scope; this
      decision does not block initial ingestion/archive work.
- [ ] Authenticated search, thread view, safe attachment preview and download.
- [ ] Explain routing decisions, adoption versions, retry states and pending items.
- [ ] Sanitize message HTML, block remote trackers, and isolate attachment previews.

## Decisions still open

CEL implementation; retrieval backend; DecisionRAG viability; attachment format
coverage; classifier SDK/provider/model; plugin distribution and trust mechanism;
production delivery/recovery policy. Cloudflare Email Sending and Valibot are
selected, with Standard Schema integration boundaries; their runtime integration
has not been implemented.
The first implementation stays focused on
forwarding plus raw archival; none of these later choices blocks the scaffold.
