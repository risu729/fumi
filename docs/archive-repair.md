# Bounded operator archive repair

`POST /api/admin/archive/repair` runs one normal repair pass without waiting for
the five-minute Cron interval. Mount `handleArchiveRepair(request, env, principal)`
only after the existing same-origin and Access/JWT authentication. The handler also
requires the separate `mail:import` grant; `mail:read` alone does not authorize it.

The route accepts no query parameters or payload. An actual empty HTTP POST stream
is accepted, as is a null body. The first input byte is rejected. Reading empty
input is bounded to eight stream reads and one second; cancellation cannot extend
that deadline. Request data cannot choose source IDs, limits, credentials, backends,
passwords or destinations.

Each authorized invocation awaits these existing helpers once, in this order:

1. `repairProcessing`: discover and dispatch the next bounded MIME processing jobs.
2. `repairAttachmentConversions`: advance the existing conversion ledger, with the
   canonical authorized related-mail password resolver used by Cron.
3. `repairContentSearch`: rebuild the next bounded local lexical projections.
4. `repairManagedMailCorpus`: advance the optional managed body/attachment corpus.

Their existing caps, leases, budgets, source fences and unknown-outcome rules are
unchanged. Starting a Workflow does not wait for MIME completion, and managed
ingestion may require a later pass to poll. Repeat this bounded operator action
while inspecting the normal processing and coverage states. It does not reset
failed jobs, importer checkpoints, attempt counters or ambiguous paid calls.

The handler does not call the routing dispatcher, notification delivery or Gmail
write APIs. Normal Workflows retain their existing provenance rules; historical
Gmail stays suppressed from live notifications. The route neither changes Cron
cadence nor creates a separate processing pipeline.

Responses contain closed per-stage statuses and counts. Optional conversion or
managed-search backends report `disabled` when their existing helpers are disabled;
MIME repair and local indexing still run. If a stage throws, its fixed error code
is reported and subsequent independent stages continue. Provider exception text,
source keys and password candidates are not returned or logged by this handler.

An accepted pass returns HTTP 200 with overall `complete` or `partial`. `complete`
means the bounded invocation finished without a stage exception, not that the
archive is fully processed. A `partial` response must be inspected for the failed
stage before repeating. All responses use no-store. Scope, route, method and
input failures return 403, 404, 405 and 400 respectively, without starting repairs.

This endpoint is operator orchestration, not evidence that a real backlog, MIME
extraction, OCR or managed corpus has completed. Deployment and real-data
acceptance remain separate from implementation and synthetic tests.
