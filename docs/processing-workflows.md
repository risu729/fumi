# Mail processing with Cloudflare Workflows

Status: catalog-stage production activation verified on 2026-11-10, including synthetic
Gmail forwarding, R2 byte comparison, D1 completion and scheduled repair. Private
rollout evidence is retained outside this public repository. The `mime-v1` pipeline adds
bounded body and attachment extraction; production migration and byte-level acceptance
were verified on 2026-11-11. Bounded lexical [search](content-search.md) and
deterministic [routing shadow](routing-shadow.md) also have bounded scheduled repair.
Successful MIME processing attempts separate owner dispatch and lexical indexing steps;
optional OCR and model classification have separately configured pipelines. See
[MIME extraction](mime-extraction.md) for limits and rollout, and
[agent mail](agent-mail.md) for outbound sending and delivery evidence.

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
(among sources added since the last clean pass, and across the whole catalog at the
[scan cadence](#scheduled-scan-cadence)) and checks up to 10 due jobs. A failed scan
does not suppress repair of known jobs.
More generally, every stage of the scheduled handler, from the archive sweep through
outbound delivery-event reconciliation and MCP Events delivery, is isolated: a failed
stage logs only its event name and a fixed status, later stages still run, and the
run is reported failed.
Failed dispatches move behind other due jobs before remote calls, with a five-minute
check interval. These bounds are for the small live archive, not bulk import.

### Scheduled scan cadence

Four scheduled repairs look for catalog rows that lack a derived row: sources without
a processing job, present originals without a current `mail_identity` row, extracted
messages without a current search projection, and live sources without a current
routing dispatch job. When such a query finds nothing, SQLite reads its whole driving
table, so at 6,210 sources these four queries read about 3.4 million D1 rows every
five hours while the archive was idle (D1 query insights, 2026-11-23 08:00 to 13:00
UTC), and the Gmail Takeout backfill multiplies the table size.

`src/scan-schedule.ts` therefore keeps one `catalog_scans` row per scan (migration
`0022`). A scheduled run makes a full pass only when one is due: no row yet, the scan's
fingerprint changed (the pipeline version, the identity version or the routing
configuration revision), the last full pass is an hour old (`FULL_SCAN_INTERVAL`), or
the highest `archive_sources` rowid is below the recorded mark (a rebuilt table).
Routing dispatch also makes its next pass full whenever the Workflow hook or Cron finds
its configuration disabled, or dispatch paused, draining or stale, and when dispatch is
activated, because sources that arrive meanwhile get no job row. A full pass that
started before such a request does not cancel it. A missing or invalid configuration
object touches no D1, so sources that arrive then wait for the hourly pass. Between full
passes a run reads only the cheap part:

| Scan | Between full passes |
| --- | --- |
| `repairProcessing` | sources with `rowid` above `scanned_rowid` |
| `repairMailIdentity` | sources with `rowid` above `scanned_rowid` |
| `repairContentSearch` | messages in `mail_search_pending` and `mail_search_documents` retries that are due, through the `mail_search_documents_retry` index |
| `repairRoutingDispatch` | `routing_dispatch_jobs` rows in `waiting` or `held` that are due, through `routing_dispatch_jobs_due` |

A full content-search or routing pass looks only for rows without a current derived row
(no projection or another manifest; no job or a stale one) and fills its remaining
budget from the cheap query, so retries that stay due cannot keep every pass full.

An attachment conversion or extraction change removes a message's search projection
through the existing triggers; the `mail_search_document_removed` trigger then adds the
message to `mail_search_pending`, so it is indexed again within five minutes. Each
scheduled content-search pass drops pending rows whose message has a current
projection, a recorded retry or no current extraction.

A pass records itself only when it comes back below its limit and left nothing
unrecorded behind: a full pass sets the next full pass an hour later and `scanned_rowid`
to the highest source rowid it covered, and a cheap processing or identity pass only
moves `scanned_rowid` forward. Cheap content-search and routing passes record nothing. A
pass that hit its limit, or an identity read that was deferred, records nothing, so the
next run repeats the same window and a backlog drains every five minutes as before.

The live paths do not wait for these passes: ingress, the Gmail imports and the Takeout
import create the processing job, and the MIME Workflow indexes content and dispatches
routing for each message itself. What only a full pass finds now waits up to an hour
instead of five minutes: a source whose job creation failed at ingress and that the R2
sweep catalogued below the mark, an older catalog row that changed after its pass, a
message the MIME Workflow never indexed without recording a retry, and a live source
whose Workflow dispatch never ran. The operator repair route (`POST
/api/admin/archive/repair`) and the Workflow hooks always run full queries.

The catalog Workflow has three checkpointed stages: begin, observe/catalog, complete.
MIME jobs insert a separate extraction stage before completion. Only small outcome
counters leave that stage; message content stays in R2/D1. A durable blocked
extraction fails the job with its coverage reason retained in `mail_extractions`.
Each stage has five retries with exponential delay starting at ten seconds and a
one-minute timeout. A stage that finds its attempt no longer active fails at once
without those retries: before observation (another attempt owns the ledger row or the
job is no longer `running`), after extraction (`attempt_inactive`) and at completion
(the ledger row belongs to another attempt or has already failed). Retrying the same
attempt cannot change that answer; an operator retry gets a new instance identity. The
failure stage that follows only updates a ledger row that still has this attempt's
instance and is pending or running, so a newer attempt's row and a terminal state stay
as they are. D1 and R2 request failures inside a stage, including the ledger read
itself, keep the five retries. Catalog writes and checkpoint changes use one D1 batch
guarded by both observation revision and the currently running instance. Single-source
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

Live ingress and historical import share `MAIL_PROCESSING`. Owner offers begin after
catalog registration and MIME extraction, so Workflow queueing and MIME processing
consume time before the adapter's timeout starts. Historical backlog can outlast
Kogane's sixty-second challenge-freshness window. The declared limit of 25 and catalog
compare-and-swap improvements do not reserve live capacity, prioritize owners or
guarantee capture-to-claim latency. Keep existing direct Kogane exact routes
authoritative until separately authorized handled-OTP and latency acceptance verifies
this path under the expected load. No route cutover or relaxation of freshness checks
follows from a successful no-code decline probe.

The platform queues instances above available capacity on a best-effort basis.
Account and Workflow capacity both apply; 25 reserves no slots and cannot raise the
account limit. This is not a live/backfill priority mechanism or measured throughput
claim. Verify queue age, completion rate and catalog failures after an authorized
rollout. Local development does not enforce concurrency limits: the artifact check
asserts that the native build emits the exact Workflow identity, limit and retention,
not that local scheduling reproduces production capacity. The CI
deployment applies the Workflow resource configuration (limit and retention) through
trigger synchronization since 2026-11-23 (ADR 0002). The Workflow GET API does not
return the limit, so a successful synchronizing deployment is the evidence that 25 was
sent.

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
   `MAIL_PROCESSING` binding, and three-day success/error retention. Since
   2026-11-23 the CI deployment registers every declared Workflow with its limit and
   retention after the version is live (ADR 0002). Before that, routine deployment
   never created Workflows, so `fumi-gmail-takeout` was missing until it was created
   by hand. Only the local `deploy:bootstrap` task explicitly uses `--no-provision`.
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
step retries, exhausted failure, controlled retry, stale-attempt fencing without step
retries, lost start responses, completion persistence, retention boundaries and scan
failure.
The built-artifact test runs native Email/Cron events, recovers a pre-migration
message, then verifies immediate processing of a second message without a scan.
No real mail is sent and no provisioned resource is accessed by these tests.

- [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Workflow execution rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Workflow concurrency limits](https://developers.cloudflare.com/workflows/build/concurrency-limits/)
- [Workers test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Native Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
