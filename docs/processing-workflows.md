# Mail processing with Cloudflare Workflows

Status: catalog-stage production activation verified on 2026-11-10, including
synthetic Gmail forwarding, R2 byte comparison, D1 completion and scheduled repair.
Private rollout evidence is retained outside this public repository.
The next `mime-v1` pipeline adds bounded body and attachment extraction, tested
locally and awaiting production migration/activation. OCR, indexing for search,
classification and external delivery remain unimplemented.
See [MIME extraction](mime-extraction.md) for the new stage and rollout.

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

The repository configures a Workflow concurrency limit of five. The platform queues
excess instances, reducing concurrent catalog writes during repair bursts without
delaying the SMTP forwarding path. This conservative initial limit is not a throughput
measurement or a live/backfill priority mechanism; bulk import still needs its own
scheduling policy. Apply changes to this limit through the Workflow resource
configuration, not just a Worker version upload.

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
- [Workers test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Native Cloudflare configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
