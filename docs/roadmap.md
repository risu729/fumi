# Roadmap

Status: capture, MIME extraction, agent mail, historical import and routing shadow
implemented; lexical retrieval verified in production on 2026-11-12.
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
- [ ] Monitor archival failures using fumi's ingestion outcomes and R2/D1 evidence;
      report missing originals without relying on Gmail for recovery.
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
- [ ] Provision read-only Gmail OAuth, activate the configured historical scope and
      verify real-mail migration independently. No Gmail writes are supported.
- [x] Bound request rate/concurrency and advance checkpoints only after durable commits.
      Count unique per-run provider IDs and preserve distinct live/backfill sources even
      when MIME hashes match. Production import acceptance remains separate.
- [x] Extract bounded MIME parts into versioned derivatives; preserve original bytes.
      Production migration, extraction and attachment-byte acceptance were verified
      on 2026-11-11. See [MIME extraction](mime-extraction.md).
- [ ] Use managed conversion/OCR for supported attachments where suitable; compare
      optional visual retrieval without requiring a custom `.txt` for every file.
      See [attachment representations](attachment-retrieval.md).
- [x] Add authenticated MCP metadata search, message/thread reads and attachment
      resources. See [agent mail](agent-mail.md) for explicit coverage and limits.
- [x] Build a bounded lexical retrieval baseline over plain-text bodies and supported
      UTF-8 attachments with citations. Authenticated source downloads and citation
      hashes were verified in production on 2026-11-12. See
      [content search](content-search.md).
- [ ] Add OCR and compare semantic/hybrid retrieval against the lexical baseline.
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
- [ ] Port private inbox policy as private configuration; retain rule precedence,
      thread deduplication, acknowledgements/case-state checks and urgent escalation.
- [x] Define a plugin manifest and adoption contract. Integration owners publish
      their own rules and handlers; fumi pins and adopts them rather than maintaining
      copies of their business rules. See [plugins](plugins.md).
- [ ] Add a specialist-owner adapter; Kogane needs a new return-value contract.
- [ ] Deterministic rules first, bounded Claude/GPT structured classification only
      for unresolved cases, then allowed webhook dispatch such as a Grok bot.
- [ ] Route only to the active destination/account, with a lease or generation
      fence so switching does not wake both old and new destinations.
- [ ] Implement authenticated dispatch, stable idempotency keys, an outbox,
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
- [ ] Verify signed MCP Events against the chosen production webhook receiver.
      Receiver selection and end-to-end delivery remain deferred.

See [outbound MCP](outbound-mcp.md) and the [agent API](agent-mail.md).
Implementation and synthetic tests do not establish production delivery.
Ongoing Gmail Sent synchronization is out of scope; phase 2A still imports
historical SENT messages. Future fumi sends stay in fumi's own sent archive.

## Phase 2D: retire Gmail forwarding

- [ ] Verify historical import completeness and fumi's independent receive/store,
      retrieval/MCP, routing/notification and send/reply paths.
- [ ] Define and test durable capture, failure reporting and retry/recovery behavior
      without a Gmail copy. R2/D1 reconciliation cannot recreate an original that
      was never stored; do not assume SMTP retries after an invocation failure.
- [ ] Disable Gmail forwarding in fumi and adopted specialist routes through a
      separately authorized cutover; remove forwarding-only configuration when
      no longer needed and verify mail handling without Gmail delivery.

This is a future runtime and routing change. Current forwarding remains enabled;
the low-priority web client is not a prerequisite for retirement.

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

- [ ] Evaluate mailbox-only UI reuse using
      [maintained project evidence](web-client-options.md). Compare Cloud Mail as an
      application with independent components and a fumi API adapter. Calendar, booking
      and drive features are out of scope; this decision does not block initial
      ingestion/archive work.
- [ ] Authenticated search, thread view, safe attachment preview and download.
- [ ] Explain routing decisions, adoption versions, retry states and pending items.
- [ ] Sanitize message HTML, block remote trackers, and isolate attachment previews.

## Decisions still open

Broader CEL language support; retrieval backend; DecisionRAG viability; attachment
format coverage; classifier SDK/provider/model; plugin distribution and trust mechanism;
production delivery/recovery policy. A bounded CEL subset and pinned manifest adoption
are implemented for shadow evaluation only. Cloudflare Email Sending and Valibot are
selected, with implemented Standard Schema MCP boundaries and a native sending binding
adapter; production send/reply acceptance was verified on 2026-11-11. The implemented
runtime covers forwarding, raw archival, catalog reconciliation and versioned Workflows
for cataloging and bounded MIME extraction, plus the agent mail API described above.
Production uses MIME extraction, the agent API and the bounded lexical content search
baseline. Historical import and private deterministic shadow routing are implemented
and synthetically tested; real Gmail migration and private policy activation remain
separate. OCR, hybrid retrieval, model classification, owner adapters and dispatch
remain future work. The configured API target is `fumi.takuk.me`; hostname, Access
and private-origin activation require their own verified rollout.
