# Mail processing with Cloudflare Workflows

Status: catalog-stage production activation verified on 2026-11-10, including
synthetic Gmail forwarding, R2 byte comparison, D1 completion and scheduled repair.
Private rollout evidence is retained outside this public repository.
The `mime-v1` pipeline adds bounded body and attachment extraction; production
migration and byte-level acceptance were verified on 2026-11-11. Bounded lexical
[search](content-search.md) and deterministic [routing shadow](routing-shadow.md)
are separate scheduled projections. OCR, model classification and live routing
dispatch remain unimplemented. See [MIME extraction](mime-extraction.md) for limits
and rollout, and [agent mail](agent-mail.md) for outbound sending and delivery evidence.

## Ownership and identity

R2 owns original bytes and receipt evidence. D1 owns the long-lived processing
ledger. Workflows owns step execution, retries and checkpoints. No mail body,
address, receipt content, attachment or secret enters Workflow parameters or
results: only the validated raw object key, pipeline version, attempt number and
small outcome counters/states. Service errors become fixed diagnostics.

The ledger key is `(raw_key, pipeline_version)`. `catalog-v1` means catalog observation;
`mime-v1` means catalog observation followed by bounded MIME decoding and derivative
storage. Neither means searchable mail. Each attempt has a deterministic instance ID
containing the version, ingress date, UUID and attempt. Message-ID and content hashes
are not deduplication keys. Separate ingress invocations remain separate sources.
Existing `catalog-v1` jobs keep their original steps, identities and terminal state. New
requests and discovery create `mime-v1` jobs; repair checks pending/running jobs from
both versions under the same ten-job limit.

## Execution and repair

After forwarding and R2 writes settle, the Email handler schedules a background
start using `waitUntil`. Neither D1 nor Workflows changes the forwarding result.
This best-effort start is not the durable recovery mechanism: the existing R2
sweep discovers raw-only and receipt-only sources if invocation time runs out.
Every scheduled invocation also discovers up to 10 catalog sources without jobs
and checks up to 10 due jobs. A failed scan does not suppress repair of known jobs.
Failed dispatches move behind other due jobs before remote calls, with a five-minute
check interval. These bounds are for the small live archive, not bulk import.

The catalog Workflow has three checkpointed stages: begin, observe/catalog, complete.
MIME jobs insert a separate extraction stage before completion. Only small outcome
counters leave that stage; message content stays in R2/D1. A durable blocked
extraction fails the job with its coverage reason retained in `mail_extractions`.
Each stage has five retries with exponential delay starting at ten seconds and a
one-minute timeout. Catalog writes and checkpoint changes use one D1 batch guarded
by both observation revision and the currently running instance. Single-source
observations advance the revision without advancing the sweep cursor or pass.
They fence stale scans; superseded attempts cannot write stale observations.
Retries are idempotent, including completion writes repeated after a lost response.

The repository declares a per-Workflow concurrency limit of 25, increased from the
initial five so an authorized archive backlog can use more bounded processing slots.
This caps running instances; it does not create additional jobs, increase per-instance
MIME/memory/retry bounds, change paid-provider call budgets, or enable optional
providers. The importer separately overlaps at most three durable-source dispatches
and retains serial original reads. Its dispatch acknowledgment does not mean the
Workflow has started or the message is searchable.

The platform queues instances above available capacity on a best-effort basis.
Account and Workflow capacity both apply; 25 reserves no slots and cannot raise the
account limit. This is not a live/backfill priority mechanism or measured throughput
claim. Verify queue age, completion rate and catalog failures after an authorized
rollout. Local development does not enforce concurrency limits: the artifact check
asserts that the native build emits the exact Workflow identity, limit and retention,
not that local scheduling reproduces production capacity. Apply changes through the
Workflow resource configuration, not just a Worker version upload, and read back
the applied limit; a successful version deployment alone does not establish 25.

States are `pending`, `running`, `complete`, and `failed`. A catalog operation may
complete while recording missing or invalid R2 evidence: inspect catalog issues
and source states separately. This stage does not recreate missing originals.
Late receipts are picked up by the regular sweep without rerunning terminal jobs.

`createBatch` retries use the same instance ID; already-existing responses count
as acknowledgment. Workflow execution can acknowledge itself before the start
response arrives. Late responses never regress a completed job. Unknown status,
network failures and permission errors remain unresolved, never inferred as
absence or success. Platform completion without the D1 completion record is a
failure requiring investigation.

Workflow history retention is configured to three days for success and failure.
The D1 terminal ledger has no automatic expiry and prevents recreation after that
history disappears. Unacknowledged creation retries stop after 24 hours, before
history retention can permit accidental recreation. Already acknowledged jobs
are never recreated because `get` fails; they retain `status_unavailable` for
investigation. No automatic alert delivery is implemented yet.

## Operator retry

An authenticated operator with `mail:import` can request a retry of one existing
canonical source through `POST /api/admin/archive/retry/mail_<uuid>`. Send an
explicit `Origin` equal to the configured API origin, `Content-Type:
application/json`, and the strict body `{"expectedAttempt":0}` using the verified
current failed attempt. No query parameters, extra properties, raw object keys,
bulk selection or pipeline override are accepted. The JSON is limited to 128
bytes with a one-second read deadline; authorization precedes body reads.

The route calls `retryFailedProcessing`, which requires a failed `mime-v1` ledger
row, the expected attempt, and a confirmed `errored` or `terminated` Workflow. A
conditional update advances the attempt once and gives it a new instance ID.
Concurrent requests and replays of the old expected attempt cannot create another
retry. Pending, running, complete, stale-attempt and unresolved-status cases remain
held. Historical source provenance and notification suppression are unchanged.

A `202` response with `{"status":"accepted","attempt":1}` acknowledges the durable
new attempt, not Workflow execution, MIME completion or search availability. An
unavailable start remains pending for bounded scheduled repair. A `409
retry_conflict` means the requested transition was not accepted; `503
processing_retry_unavailable` leaves the request outcome unresolved. A lost or
unavailable response can follow a committed transition: inspect the authenticated
message extraction view and authorized processing evidence before choosing a new
expected attempt; never increment it blindly. Unknown or expired Workflow status
fails closed and requires investigation.

Resolve the failure cause before requesting a retry. Direct dashboard restart is
unsupported because it bypasses the attempt ledger. Do not reset terminal ledger
rows or restore an old ledger backup against live instances without reconciliation.

## Production rollout

The initial catalog rollout is complete. MIME rollout additionally requires
`0003_mail_extractions.sql` before activating the new Worker. The bounded discovery loop
will also create MIME jobs for previously cataloged originals; review that processing
scope before production activation. For a new environment or configuration rollout:

1. Verify the target Worker, R2 bucket and existing D1 database. Apply the additive
   `0002_processing_jobs.sql` migration with separately authorized access and
   verify its table and indexes. Preserve all existing archive data.
2. Provision/verify `fumi-mail-processing`, exported class `MailProcessing`, the
   `MAIL_PROCESSING` binding, and three-day success/error retention through an
   authorized bootstrap/configuration deployment. Routine deployment uploads a
   version without synchronizing triggers; it is not proof that Workflow resources
   exist. Only the local `deploy:bootstrap` task explicitly uses `--no-provision`.
   Do not assume the Worker-scoped deploy token grants resource creation.
3. Verify the active Worker version, binding and unchanged email routes. Run an
   approved synthetic acceptance message; independently verify forwarding, R2
   bytes, immediate catalog registration and the completed D1 job/Workflow.
4. Verify scheduled repair and bounded job counts. Keep deployment evidence and
   account identifiers private. Never infer mail delivery from CI or deployment.

The additive schema supports rollback to the previous Worker without deleting
originals or ledger rows. Inspect and resolve active instances before changing or
removing their exported class; do not blindly roll back while jobs are executing.
Existing catalog repair alone cannot recover failed live archival.

## Validation and references

Local tests use synthetic mail and the actual Workers Workflow engine. They cover
step retries, exhausted failure, controlled retry, stale-attempt fencing, lost
start responses, completion persistence, retention boundaries and scan failure.
The built-artifact test runs native Email/Cron events, recovers a pre-migration
message, then verifies immediate processing of a second message without a scan.
No real mail is sent and no provisioned resource is accessed by these tests.

- [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Workflow execution rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Workflow concurrency limits](https://developers.cloudflare.com/workflows/build/concurrency-limits/)
- [Workers test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Native Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
