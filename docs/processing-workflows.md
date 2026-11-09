# Mail processing with Cloudflare Workflows

Status: catalog-stage implementation, 2026-11-10. Production activation is a
separate rollout. MIME extraction, OCR, indexing for search, classification and
external delivery are not implemented by this pipeline.

## Ownership and identity

R2 owns original bytes and receipt evidence. D1 owns the long-lived processing
ledger. Workflows owns step execution, retries and checkpoints. No mail body,
address, receipt content, attachment or secret enters Workflow parameters or
results: only the validated raw object key, pipeline version, attempt number and
small outcome counters/states. Service errors become fixed diagnostics.

The ledger key is `(raw_key, pipeline_version)`. `catalog-v1` means catalog
observation, not searchable mail. Each attempt has a deterministic instance ID
containing the version, ingress date, UUID and attempt. Message-ID and content
hashes are not deduplication keys. Separate ingress invocations remain separate
sources. Future pipeline versions must preserve or explicitly migrate old jobs.

## Execution and repair

After forwarding and R2 writes settle, the Email handler schedules a background
start using `waitUntil`. Neither D1 nor Workflows changes the forwarding result.
This best-effort start is not the durable recovery mechanism: the existing R2
sweep discovers raw-only and receipt-only sources if invocation time runs out.
Every scheduled invocation also discovers up to 10 catalog sources without jobs
and checks up to 10 due jobs. A failed scan does not suppress repair of known jobs.
Failed dispatches move behind other due jobs before remote calls, with a five-minute
check interval. These bounds are for the small live archive, not bulk import.

The Workflow has three checkpointed stages: begin, observe/catalog, complete.
Each stage has five retries with exponential delay starting at ten seconds and a
one-minute timeout. Catalog writes and checkpoint changes use one D1 batch guarded
by both observation revision and the currently running instance. Single-source
observations advance the revision without advancing the sweep cursor or pass.
They fence stale scans; superseded attempts cannot write stale observations.
Retries are idempotent, including completion writes repeated after a lost response.

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

The internal `retryFailedProcessing` primitive requires a failed ledger row, the
expected attempt, and a confirmed `errored` or `terminated` Workflow. A conditional
update advances the attempt once and gives it a new instance ID. Unknown or
expired instances fail closed; investigate their original outcomes. No public
retry endpoint or CLI is added here. Direct dashboard restart is unsupported:
it bypasses the attempt ledger. Resolve the cause and invoke an authorized
operator integration when one is implemented. Do not reset terminal ledger rows
or restore an old ledger backup against live instances without reconciliation.

## Production rollout

Code merge does not activate this feature. Before the next production deployment:

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
- [Workers test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Native Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
