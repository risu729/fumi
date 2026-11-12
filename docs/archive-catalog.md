# Archive catalog and reconciliation

This implementation adds a D1 catalog and a bounded scheduled reconciler for the
existing R2 v1 archive. It preserves `ingest/YYYY-MM-DD/<UUID>/raw.eml` and
`receipt.json` without rewriting or moving them. Production D1 provisioning,
migration and schedule activation are separate rollout steps; local synthetic
tests do not establish production recovery.

## Identity and evidence

An ingress UUID identifies an Email Worker invocation, not a logical email.
Source identity is namespaced by source kind, namespace and external ID.
Identical bytes from separate deliveries remain separate sources. SHA-256 is
content evidence, never a unique message identifier. The separate
[historical Gmail importer](gmail-import.md) retains account/message/thread/label
provenance with deterministic UUID-shaped Fumi identities. Its `gmail` source kind
has no SMTP forwarding outcome and never emits historical mail notifications.
The reconciler restores its provider provenance from the private Gmail receipt;
incomplete pairs remain coverage issues. Outgoing submissions retain their own
independent identities.

The first validated receipt is retained as immutable historical evidence in D1.
Current R2 observations are separate from that snapshot. Later missing or invalid
receipts cannot erase known forwarding outcomes. A different valid receipt at
the same key records a conflict rather than replacing the evidence.

- Raw only: an object exists, but the forwarding outcome is unknown.
- Receipt claims stored, raw missing: historical success claim plus a current
  archive gap. Neither is silently converted into the other.
- Receipt claims failure, raw present: retain the discrepancy for investigation.
- A successful forward records Cloudflare acceptance, not Gmail inbox placement.
- HEAD checksum/size comparison uses stored upload checksums. It is not a fresh
  download and byte audit of the original.

The catalog is reconstructible from retained R2 evidence. Losing D1 also loses
its historical observations of objects subsequently deleted or changed;
reconstruction cannot recreate evidence absent from R2.

## Bounded reconciliation

The Email handler schedules background D1/Workflow job creation after delivery
outcomes settle. A D1 outage or schema failure cannot fail Gmail forwarding.
See [processing Workflows](processing-workflows.md) for immediate indexing and
missing-start repair. The scheduled handler also performs one R2 list
page of at most 20 objects, inspecting candidates discovered from either sibling
filename. It reads raw metadata only and bounds receipt reads to 16 KiB. It
validates the schema, ingest ID, date and sibling key before indexing. It never
follows an arbitrary object reference from a receipt.

Each page's catalog writes and scan-checkpoint advancement share one D1 batch.
Every mutation is guarded by the checkpoint revision, including the final
compare-and-swap. A losing concurrent invocation cannot commit stale observations
or rewind the cursor. Transient R2 or D1 errors prevent checkpoint advancement.
Invalid evidence receives a durable closed issue code so one bad object does
not permanently block the scan.

Immediate single-source observations use the source's last observation revision
instead of requiring an unchanged global revision across R2 reads. Unrelated
imports, Workflows or scan pages therefore do not starve a source's catalog step.
A newer observation of the same raw key still rejects every stale mutation,
including issues, Gmail provenance, events and the revision increment. Workflow
attempt ownership remains required when supplied.

All source mutations and their global revision increment share one atomic D1
batch. A committed source's `observed_revision` is strictly below the current
global revision: the batch stamps the current revision, then increments it. Its
own stamp remains eligible for later statements inside that batch. This orders
source/page races without weakening a scan page's strict compare-and-swap. Source
commits never write the scan cursor or pass, including when another page advanced
them during observation. No migration or automatic retry of failed jobs is implied.

`observed_revision` identifies a source's last committed scan observation.
Logged `pass` identifies the traversal just processed; a terminal page persists
the next pass number. `issues` counts issue rows inserted or refreshed in that
page, including conflicts. Issue history is retained, so this count is not the
number of currently unresolved problems across the archive.

Pagination uses R2's opaque cursor and `truncated`, not the returned object count.
At traversal end, the cursor resets and the pass increments. Repeated sweeps find
late writes behind an earlier cursor. A completed pass is one traversal, not
proof that every mail was captured or all siblings existed at the same instant.

The configured cadence is one page every five minutes. This is an initial repair
mechanism for the small live archive, not low-latency indexing for a large
historical import. Each pass costs at least one listing per 20 objects plus
sibling reads and D1 writes. Workflows provides immediate indexing with stable
source keys; mail whose background start fails may wait an entire scan pass.
Before bulk backfill, tune incremental processing and sweep throughput using
measured volume and cost.

The reconciler does not forward mail, recreate R2 receipts, restore MIME from
Gmail, extract attachments, run models or emit notifications. If both R2 objects
are absent, it cannot discover the lost invocation. Ingestion-outcome monitoring
and alert delivery remain future work. Gmail-based recovery is out of scope:
forwarding is temporary, and the eventual capture/recovery path must work without
Gmail. Historical Gmail backfill remains a separate migration task.
Retention/deletion must include catalog
tombstones before automatic object deletion is introduced.

## Verification and rollout

`mise run test` exercises the migration and reconciler against local workerd
R2/D1 with synthetic fixtures. `mise run test:artifact` executes native Email and
Cron events against the production bundle. It delivers synthetic mail before the
D1 schema exists, then applies migrations locally and verifies scheduled recovery
and Workflow completion. A second message is cataloged without another scan.
These checks do not access production mail.

Do not dispatch deployment expecting it to provision or migrate D1. The existing
Worker-scoped deploy token has not been verified for D1 provisioning or schema
operations. Use separately authorized credentials and verify the exact target;
do not widen the deploy token by assumption.

1. Record the current Worker version and Email Routing configuration. Provision
   or identify the intended private `fumi-catalog` database and verify its UUID.
   Keep resource/account identifiers outside the public repository.
2. Apply `migrations/0001_archive_catalog.sql` before activating the schedule.
   With the pinned CLI, `cf d1 migrations apply <database-uuid> --dir ./migrations`
   targets the remote database by default. It is a write even in noninteractive
   execution; do not rely on a confirmation prompt.
3. Read back the schema, migration record and initial scan checkpoint. CLI dry
   runs do not execute or validate SQL. Even `migrations list` may create its
   bookkeeping table; use explicit read-only queries for inspection.
4. Deploy the reviewed code and binding to the provisioned database. Existing
   deployment requires the production environment variable
   `FUMI_CATALOG_DATABASE_ID` in GitHub Actions. Set it to the verified UUID so the
   Worker-scoped token does not need a D1 API lookup to resolve a name.
   Local tests and CI dry runs can omit it and use a local database.
   The
   manual CI deployment uses the versions strategy with `deploy-triggers: false`;
   it will not activate the Cron schedule. Verify resource resolution and
   deployment credentials separately.
5. Activate the reviewed Cron trigger separately. Full `cf deploy` synchronizes
   triggers, so inspect its complete trigger change before using it. Do not alter
   Email Routing as a side effect of enabling catalog repair.
6. Verify scheduled runs, checkpoint progress, catalog rows against R2 evidence,
   and unchanged Gmail delivery. Production acceptance remains pending until then.

Rollback disables the new Cron schedule and restores the prior Worker version.
Keep R2 originals and additive D1 data. No destructive rollback migration is needed.

## References

- [R2 listing, metadata and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [D1 batches and sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Native cf migration differences](https://developers.cloudflare.com/cf/wrangler/migrate/)
