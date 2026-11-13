# Roadmap

Status: capture, agent mail, historical import, attachment conversion/decryption,
managed retrieval and configurable routing are implemented. Lexical retrieval and
a bounded semantic/hybrid source-citation sample are verified in production;
historical backfill is in progress on 2026-11-12.
Checked items describe completed implementation or preparation;
production acceptance is separate. Unchecked items remain future work.

Target state: fumi operates independently of Gmail. Existing Gmail forwarding is
temporary and will be retired after migration readiness is verified. Historical
Gmail backfill remains in scope; ongoing Gmail synchronization, automatic recovery
of live archive gaps from Gmail, and Gmail inbox management are out of scope.

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
      Processing start failures now have a D1 ledger and bounded repair path.
- [x] Expose bounded read-only archive health using ingestion outcomes and retained
      R2/D1 catalog evidence, including known missing originals and explicit unknown
      coverage. This does not recover missing originals or prove that all ingress
      was observed. See [archive health](archive-health.md).
- [x] Implement a separate D1 archive catalog and bounded R2 evidence reconciler.
      This repairs the
      catalog, not missing original MIME. See [catalog recovery](archive-catalog.md).
- [x] Add Cloudflare Workflows for immediate catalog registration, durable job state,
      retry and missing-start repair. Production activation was verified on 2026-11-10;
      see [processing Workflows](processing-workflows.md).
- [x] Bound memory and MIME sizes; test actual length, capture timeouts, oversized mail,
      malformed MIME, duplicate deliveries, and forwarding loops.
- [x] Establish payload-free application logs, observability and manual recovery.
- [x] Configure Workers Issues beta and a per-Workflow concurrency limit.
      See [Cloudflare features](cloudflare-features.md) for scope and verification.
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

- [x] Implement read-only resumable historical Gmail import, preserving SENT,
      labels, account/thread/date provenance and exact MIME. Trusted admin routes,
      transport account verification and synthetic checks are complete. See
      [historical Gmail import](gmail-import.md).
- [ ] Complete and independently verify the configured historical scope. Exact
      copies through the connected Gmail transport are active; optional read-only
      OAuth remains an alternative. No Gmail writes are supported.
- [x] Bound request rate/concurrency and advance checkpoints only after durable commits.
      Count unique per-run provider IDs and preserve distinct live/backfill sources even
      when MIME hashes match. Controlled hosted native small-original staging
      verified exact bytes/hash; a throughput improvement has not been established.
      See [native staging](gmail-connector-stage.md). Complete-scope import acceptance
      remains separate.
- [x] Extract bounded MIME parts into versioned derivatives; preserve original bytes.
      Production migration, extraction and attachment-byte acceptance were verified
      on 2026-11-11. Imported sources now start the same durable processing path;
      completed MIME immediately attempts separately checkpointed routing and
      lexical indexing, with bounded repair after failures. Historical
      notifications remain suppressed. See
      [MIME extraction](mime-extraction.md).
- [x] Implement bounded managed conversion/OCR, durable coverage and original/derived
      citations, without requiring a custom `.txt` before managed ingestion.
      Controlled production checks verified local ZIP extraction, isolated child
      PDF decryption, managed DOCX conversion and PDF/PNG OCR on 2026-11-12.
      Eleven authenticated resource downloads passed full hash and provenance
      checks, and all four lexical marker queries verified exact original/derived
      citation hashes, authenticated URIs and supported excerpts. Broader
      real-document acceptance remains separate. See
      [attachment conversion](attachment-conversion.md).
- [ ] Compare optional visual retrieval against text/OCR projections.
- [x] Add authenticated MCP metadata search, message/thread reads and attachment
      resources. See [agent mail](agent-mail.md) for explicit coverage and limits.
- [x] Build a bounded lexical retrieval baseline over plain-text bodies and supported
      UTF-8 attachments with citations. Authenticated source downloads and citation
      hashes were verified in production on 2026-11-12. See
      [content search](content-search.md).
- [x] Verify opted-in OCR on controlled PDF/PNG production fixtures.
- [x] Verify converted-attachment lexical citations against authenticated downloads.
- [x] Verify a bounded production semantic/hybrid sample against lexical retrieval:
      all three returned the same historical source, with supported excerpts,
      authenticated text/raw hashes and matching raw provenance. Two managed
      queries were used with rewriting and answer generation disabled. This is
      source/citation acceptance, not exhaustive retrieval-quality evaluation or
      complete corpus coverage. See [managed retrieval](managed-mail-search.md).
- [x] Verify controlled ZIP, decrypted PDF OCR, DOCX and PNG OCR retrieval in both
      semantic and hybrid modes. Eight format/mode checks matched derived,
      original attachment and raw MIME hashes, authenticated URIs and supported
      excerpts. This uses an administrator-targeted fixture corpus and does not
      establish whole-archive coverage or general retrieval quality.
- [ ] Compare AI Search with explicit D1/Vectorize indexing on Japanese mail,
      exact numbers, sender/date constraints and attachment-heavy questions.
- [ ] Evaluate DecisionRAG separately against that baseline; measure recall,
      citation accuracy, incremental update cost, latency and total model cost.
- [ ] Handle deletions/retention consistently across originals, derivatives and
      indexes; distinguish import completion from indexing completion.

## Phase 2B: routing and selective model use (parallel with 2A)

- [x] Pin a Workers-compatible CEL evaluator and test a structurally bounded
      subset. See [routing shadow](routing-shadow.md) for the deliberately narrow
      language, input grants and synthetic runtime evidence.
- [x] Prepare a private deterministic policy candidate with 27 bounded rules and
      51 synthetic fixtures, retaining dated exception precedence and holding
      unresolved cases. The candidate is reviewed but inactive; its contents and
      provenance stay outside this repository.
- [ ] Activate the reviewed private policy and verify notification behavior with
      trusted acknowledgement/case context and an explicitly configured receiver.
- [x] Define a plugin manifest and adoption contract. Integration owners publish
      their own rules and handlers; fumi pins and adopts them rather than maintaining
      copies of their business rules. See [plugins](plugins.md).
- [x] Add strict specialist-owner HTTP/service/RPC adapters and durable receipts. The
      Kogane owner adapter is deployed. Private owner-only RPC adoption and the first
      durable decline of a controlled no-code message are verified. Repeat-receipt
      verification and real end-to-end OTP acceptance remain unverified. See
      [owner status](plugins.md#kogane-implementation-and-adoption-status).
- [x] Deterministic rules first, optional bounded Claude structured classification
      for unresolved cases, then one administrator-configured generic webhook.
      Actual classifier credentials and webhook receiver are deferred. The Grok Bot
      side builds its own webhook proxy that selects the active A/B account; fumi
      sends to that one URL and does not select accounts (owner, 2026-11-12 22:50 UTC).
- [x] Fence the active generic destination by generation, drain old uncertainty
      before activation, and preserve stable operation identity across revisions.
- [x] Implement authenticated dispatch, stable idempotency keys, an outbox,
      bounded retries, a dead-letter path and status reconciliation for ambiguity.
- [x] Persist deterministic rule/plugin shadow decisions with versioned private
      configuration, provenance fences and bounded repair. Historical mail is
      suppressed and no dispatch is permitted. Private policy activation and model
      shadow evaluation remain separate.

## Phase 2C: outbound email through MCP

- [x] Select native Cloudflare Email Sending on the Workers Paid deployment baseline.
- [x] Verify sender domains, account quotas and production binding configuration
      before activating sending; controlled sending was verified on 2026-11-11.
- [x] Add separately scoped draft, preview, send, reply and send-status MCP tools.
      A permitted explicit send invocation may send directly; an interactive
      confirmation screen is not a universal requirement.
- [x] Authorize sender identities, recipients, attachments and reply targets from
      trusted caller grants. Mail/search content cannot grant send permission.
- [x] Persist a stable logical send ID, validated input and outbox state before
      provider submission. Reject key reuse with different content.
- [x] Reconcile retained submission receipts and known-provider delivery events;
      preserve uncertainty and do not blindly retry a send after
      a timeout. Track accepted, delivered, bounced and failed as distinct states.
- [x] Archive the submitted content and provider receipts, linking replies to
      source messages. Do not claim these are the provider's final wire bytes.
- [x] Test thread headers, attachment limits, duplicate calls, timeout after
      acceptance, authorization failures and provider delivery events.
- [x] Implement signed MCP Events with durable lifecycle events, scoped
      subscriptions, replay and bounded retries.
- [x] Activate and verify authenticated production MCP reads, sender domains,
      sends/replies, attachment hashes, idempotency and provider delivery events.
- [ ] Verify signed MCP Events against a temporary verification receiver. No
      production consumer exists, so no permanent receiver is kept; the probe
      receiver and its `WEBHOOK_ORIGINS` entry are removed after acceptance
      (owner, 2026-11-13 05:53 UTC).

See [outbound MCP](outbound-mcp.md) and the [agent API](agent-mail.md).
Implementation and synthetic tests do not establish production delivery.
Ongoing Gmail Sent synchronization is out of scope; phase 2A still imports
historical SENT messages. Future fumi sends stay in fumi's own sent archive.

## Phase 2D: retire Gmail forwarding

- [ ] Verify historical import completeness and fumi's independent receive/store,
      retrieval/MCP, routing/notification and send/reply paths.
- [x] Implement and synthetically test optional standalone capture, explicit
      rejection when raw storage is unconfirmed, bounded writes, v2 receipts and
      catalog/processing recovery. See [standalone ingress](standalone-ingress.md).
      R2/D1 reconciliation cannot recreate an original that was never stored;
      permanent SMTP rejection does not request automatic retries.
- [ ] Get owner confirmation of the standalone failure policy (permanent SMTP
      rejection, archive-only write deadline); see
      [standalone ingress](standalone-ingress.md#capture-and-failure-behavior).
- [ ] Verify standalone failure handling and alert response in production before
      retiring the Gmail copy; synthetic tests do not establish SMTP behavior.
- [ ] Disable Gmail forwarding in fumi and adopted specialist routes through a
      separately authorized cutover; remove forwarding-only configuration when
      no longer needed and verify mail handling without Gmail delivery.

The optional runtime is implemented; production cutover remains separate.
Current forwarding remains enabled;
the low-priority web client is not a prerequisite for retirement.

## Phase 3: encrypted attachments

- [x] Detect password-protected ZIP/PDF and preserve encrypted originals independently
      from verified derivatives. Isolated PDF processing requires explicit opt-in.
- [x] Search bounded related archive messages for ephemeral password-shaped hints
      under namespace/participant/thread-or-subject-or-filename constraints.
      Actual cryptographic decryption proves success; model extraction is optional
      future work and is not required for the implemented path. Retained originals,
      the activation binding snapshot and rechecked hosted ZIP/PDF outputs
      corroborate related-mail lookup without per-candidate telemetry; see
      [attachment acceptance](attachment-conversion.md).
- [x] Verify decryption locally with bounded attempts, size/time/expansion limits;
      save a distinct decrypted derivative only on verified success.
- [x] Keep resolved candidate values out of logs, MCP results and new derivative
      text indexes. Original mail containing passwords is not retroactively redacted.
      Apply separate access controls and retention to the newly readable derivative.
- [x] Test zip.js without Web Workers/WASM and LibPDF in an isolated Dynamic Worker
      on actual local workerd. Unsupported or oversized formats retain explicit
      coverage. Controlled production PDF decryption is verified; hostile-input
      CPU/memory limit enforcement remains a separate acceptance.

## Phase 4: optional web client (low priority)

- [ ] Evaluate mailbox-only UI reuse using
      [maintained project evidence](web-client-options.md). Compare Cloud Mail as an
      application with independent components and a fumi API adapter. Calendar, booking
      and drive features are out of scope; this decision does not block initial
      ingestion/archive work.
- [ ] Authenticated search, thread view, safe attachment preview and download.
- [ ] Explain routing decisions, adoption versions, retry states and pending items.
- [ ] Sanitize message HTML, block remote trackers, and isolate attachment previews.

## Decisions still open

Broader CEL language support, DecisionRAG quality comparison, additional attachment
formats, actual classifier model/key, plugin distribution and the production webhook
receiver remain open. Bounded CEL adoption, durable owner offers, generic dispatch,
optional Claude classification, local ZIP/PDF decryption and managed OCR/hybrid
retrieval are implemented with private opt-in configuration. Code/tests alone do
not establish a complete corpus, real model quality or downstream delivery.
The API target `fumi.takuk.me`, lexical retrieval and outbound send/reply paths have
separate recorded production acceptance. Gmail backfill remains in progress;
forwarding retirement and deletion are not implied by implementation completion.
