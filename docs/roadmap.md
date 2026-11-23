# Roadmap

Status: capture, agent mail, historical import, attachment conversion/decryption,
managed retrieval and configurable routing are implemented. Lexical retrieval and
a bounded semantic/hybrid source-citation sample are verified in production;
historical backfill stopped on 2026-11-12 after 4,810 messages and moves to
Google Takeout ([ADR 0004](adr/0004-gmail-takeout-import-and-copy-grouping.md)).
Checked items describe completed implementation or preparation;
production acceptance is separate. Unchecked items remain future work.

Target state: fumi operates independently of Gmail, except for capturing mail the owner
still sends by hand from Gmail. Existing Gmail forwarding is temporary and will be
retired after migration readiness is verified. Historical Gmail backfill remains in
scope, and so does ongoing capture of Gmail SENT mail (see phase 2A, owner, 2026-11-17
17:37 UTC), and so does capturing mail delivered directly to Gmail through Gmail
forwarding ([ADR 0005](adr/0005-capture-mail-delivered-directly-to-gmail.md), owner,
2026-11-22 21:29 UTC). Other ongoing Gmail synchronization, automatic recovery of live
archive gaps from Gmail, and Gmail inbox management are out of scope.

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
- [x] Make forward failures identifiable: a bounded reason code in the receipt and
      log, and a failed-forward list with retry recovery in health
      ([#138](https://github.com/risu729/fumi/issues/138)). See
      [forward failure reasons](ingress.md#forward-failure-reasons).
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
- [x] Capture mail delivered directly to Gmail: Gmail forwards every incoming message
      to fumi, which never forwards it back and drops the copies it already holds
      ([#161](https://github.com/risu729/fumi/issues/161),
      [ADR 0005](adr/0005-capture-mail-delivered-directly-to-gmail.md)). See
      [mail delivered directly to Gmail](gmail-relay.md). Synthetic tests only.
- [ ] Turn on Gmail forwarding to fumi and record its acceptance; see the
      [operator steps](gmail-relay.md#operator-steps).

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
- [ ] Complete and independently verify the historical scope from Google Takeout
      per account, and group copies of one message across accounts and live capture
      ([ADR 0004](adr/0004-gmail-takeout-import-and-copy-grouping.md)). Grouping is
      implemented ([copies of one message](copy-grouping.md)); its production check of
      the 276 live/Gmail pairs is pending. The connector
      transport committed 4,810 messages (internal dates 2026-08-24..2026-11-11)
      before it stopped on 2026-11-12. No Gmail writes are supported.
- [ ] On hold (owner, 2026-11-17 17:44 UTC): keep importing Gmail SENT mail after the
      historical cutoff. Do not implement until the owner picks the design. The owner
      sends by hand from Gmail through Cloudflare Email Sending SMTP. Those messages do
      not pass through fumi's outbound archive, reach ingress only when an owner-domain
      routed address is a recipient, and Cloudflare keeps only short-lived send logs, so
      Gmail SENT is their only lasting copy (owner, 2026-11-17 17:37 UTC). The capture
      lasts as long as the owner sends from Gmail; retiring forwarding in phase 2D does
      not end it. A self-BCC was rejected because forwarding copies it back into the
      Gmail inbox; an archive-only BCC address would need per-route ingress code, and
      Gmail cannot add a BCC automatically. The existing read-only transport, exact raw
      MIME, provider-ID identity and suppressed notifications carry over, but the
      importer needs new code: a SENT label filter (its list query has none, so a
      rolling window would otherwise import INBOX too), and a rolling scope and run
      model, because each `importId` has one immutable scope and `GMAIL_IMPORT_CONFIG`
      holds one run. Windows must overlap, end some time before the current time for
      Gmail indexing lag, and reuse the historical `accountNamespace` so one message
      keeps one identity, which means sharing the per-account lease with the unfinished
      historical run. A sent message deleted from Gmail before the next poll is a gap
      bounded by the poll interval. A sent message that also reached ingress is stored
      twice, as already accepted for distinct live and Gmail sources. Open choices, with
      their permission impact: a scheduled Worker holding a refreshing `gmail.readonly`
      OAuth token (Gmail has no SENT-only scope, so this is standing read access to the
      whole mailbox, exposed to any merged and deployed code; consumer OAuth clients in
      Testing status get refresh tokens that expire after seven days), or periodic
      connector staging by an operator agent (no stored Google credential, but the
      connector can also send and modify mail, the staged account hash is an operator
      attestation, and capture depends on scheduled agent sessions). Gmail
      `history.list` or `watch` with `labelIds: ["SENT"]` are refinements of the first
      option, with the same scope.
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
      indexes; distinguish import completion from indexing completion. Import
      status now reports per-run MIME, lexical and managed coverage separately
      from archival completion; see
      [downstream coverage](gmail-import.md#downstream-coverage-per-run).
      Deletion and retention still need an owner policy decision.

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
      Actual classifier credentials and webhook receiver are deferred. A webhook
      proxy selects the active Grok Bot A/B account; fumi sends to that one URL and
      does not select accounts (owner, 2026-11-12 22:50 UTC). The proxy is built by
      this project's agents (owner, 2026-11-20 17:13 UTC).
- [x] Sign the generic webhook with Standard Webhooks, retry it with a stable
      `webhook-id`, and send identifiers and classification only
      ([ADR 0003](adr/0003-signed-notification-webhooks.md)).
- [x] Design the receiver as a generic webhook relay: signature check,
      `webhook-id` deduplication and an active target set through MCP. The relay
      design was accepted 2026-11-22 14:23 UTC, and a Grok run was verified to read
      `messageId` from the webhook body. See [routing dispatch](routing-dispatch.md).
- [ ] Build and deploy the relay in its own repository,
      [risu729/tayori](https://github.com/risu729/tayori).
- [x] Fence the active generic destination by generation, drain old uncertainty
      before activation, and preserve stable operation identity across revisions.
- [x] Implement authenticated dispatch, stable idempotency keys, an outbox,
      bounded retries, a dead-letter path and status reconciliation for ambiguity.
- [x] Persist deterministic rule/plugin shadow decisions with versioned private
      configuration, provenance fences and bounded repair. Historical mail is
      suppressed and no dispatch is permitted. Private policy activation and model
      shadow evaluation remain separate.
- [x] Read routing rules, per-rule usage and one message's routing explanation
      over MCP behind `mail:routing`, part of
      [#145](https://github.com/risu729/fumi/issues/145). Per-rule times come
      from the revision records of the rule change tools below. See
      [routing shadow](routing-shadow.md#reading-rules-and-their-usage-over-mcp).
- [x] Change rules over MCP: propose, update or retire a candidate rule as a new
      configuration revision, validated before anything is written, behind
      `mail:routing` plus `mail:routing:write`, with an expected SHA-256 and an R2
      conditional write, and immutable revision records so rule history becomes
      available ([#145](https://github.com/risu729/fumi/issues/145) item 2). Activation
      stays a separate administrator action. See
      [routing shadow](routing-shadow.md#changing-candidate-rules-over-mcp).

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
- [ ] Deferred: verify signed MCP Events end to end with ChatGPT, the only known
      client of the draft MCP Events proposal, once the owner's ChatGPT
      subscription resumes. Until then the implementation stays in place, unused,
      with `WEBHOOK_ORIGINS` empty; Grok Bot is the primary notification target
      through the routing webhook (owner, 2026-11-16 11:59 UTC).

See [outbound MCP](outbound-mcp.md) and the [agent API](agent-mail.md).
Implementation and synthetic tests do not establish production delivery.
Sends made through fumi stay in fumi's own sent archive. Mail the owner sends
from Gmail is captured from Gmail SENT instead (phase 2A, owner, 2026-11-17
17:37 UTC).

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
      no longer needed and verify mail handling without Gmail delivery. Relay
      recognition reads `FORWARD_TO`, so it needs its own setting for the Gmail
      account first ([limits](gmail-relay.md#limits)).

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
- [ ] Download files from links in mail and process them like attachments
      ([#146](https://github.com/risu729/fumi/issues/146), owner, 2026-11-21 19:44
      UTC). See [link downloads](link-downloads.md) for the design and the open
      owner decisions. Parts, each its own PR:
  - [x] A: deterministic URL extraction, hard-limit URL policy and safe fetcher,
        as library code that production does not call.
  - [x] B: model selection of candidates by index, as library code that production
        does not call. It reuses the routing classifier's model, key and daily
        budget behind its own opt-in until the owner picks the model and key.
  - [ ] C: processing integration, storage, conversion and decryption, after the
        owner decides the storage layout, migration and limits.
  - [ ] D: downloaded files through the attachment MCP tools, and a pending
        download listing.

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
formats, actual classifier model/key, the link-download decisions listed in
[link downloads](link-downloads.md#open-decisions-for-the-owner), plugin distribution
and the production webhook receiver remain open. Bounded CEL adoption, durable owner
offers, generic dispatch, optional Claude classification, local ZIP/PDF decryption and
managed OCR/hybrid retrieval are implemented with private opt-in configuration.
Code/tests alone do not establish a complete corpus, real model quality or downstream
delivery. The API target `fumi.takuk.me`, lexical retrieval and outbound send/reply
paths have separate recorded production acceptance. Gmail backfill remains in progress;
forwarding retirement and deletion are not implied by implementation completion.
