# Standalone ingress

The optional `archive-only` receive mode stores original MIME without forwarding
to Gmail. The default remains `forward`. This is an implementation with synthetic
runtime acceptance, not a production cutover or historical import completion.

## Configuration

`FUMI_INGRESS_MODE` is a trusted build-time setting in the production environment:

| Value | Native binding | Forwarding credential |
| --- | --- | --- |
| Unset or `forward` | `INGRESS_MODE=forward` | `FORWARD_TO` required |
| `archive-only` | `INGRESS_MODE=archive-only` | No `FORWARD_TO` declaration |

Other values, including empty strings, fail the build. A malformed runtime mode
rejects the message with a fixed reason and logs only a configuration failure.
The runtime defaults to forwarding when the binding is absent. Missing or invalid
`FORWARD_TO` never implies permission to stop forwarding. Mail headers, content,
model outputs and plugin decisions cannot select the mode.

The mode applies to every route handled by this Worker version. Specialist
Workers retain their own receive/forward behavior. Build once with the intended
mode and inspect that exact artifact before publishing. The existing production
workflow builds the default forwarding mode; its cutover configuration must be
explicitly updated before using it for an archive-only release.

## Capture and failure behavior

The handler reads the exact bounded MIME stream, validates the declared length,
and awaits an R2 write with a SHA-256 checksum. The raw read has a ten-second
deadline; each raw/receipt write has a five-second deadline. No MIME decoding or
reserialization occurs before capture. Each invocation has its own ingestion ID.

| Outcome in archive-only mode | Handler behavior | Recovery |
| --- | --- | --- |
| Raw and receipt stored | Accept; record forwarding as skipped | Normal durable processing |
| Raw stored, receipt fails or times out | Accept; report receipt failure | Recover readable source metadata; hold notifications/actions until matching success evidence exists |
| Raw read/write fails or times out | Call `setReject` before attempting the receipt | Retain failure evidence when possible; investigate missing or late originals |
| Raw stored, D1/Workflow start fails | Keep capture accepted | Processing repair and bounded R2 reconciliation |
| Invocation terminates before durable evidence | No application-level guarantee | Inspect platform activity and logs; report unknown coverage |

Cloudflare documents
[`setReject` as a permanent SMTP error](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#reject-emails).
It is not a temporary rejection or a request for automatic SMTP retries. A sender may
have to resubmit after an outage. This is a deliberate failure policy for an optional
mode; changing it requires a different, verified ingress mechanism.

A write deadline does not cancel R2 or prove that an object was never committed.
The receipt's `raw_write_failed` means capture was not confirmed by the handler.
A late raw object can coexist with a failed capture receipt and SMTP rejection.
Reconciliation retains that discrepancy; do not automatically forward, resend,
or treat it as accepted delivery. A sender's new attempt remains separate
evidence even when the bytes match. Missing originals cannot be recovered from
metadata, receipts or D1. No Gmail recovery or automatic resend is implemented.

The default forwarding mode still attempts archive and Gmail delivery
independently. Its archive failure never blocks a successful forward. Neither
mode treats a D1/Workflow result as proof of SMTP delivery.

## Evidence and schema compatibility

Forwarding mode continues writing the unchanged v1 receipt. Standalone mode
writes v2 with `forward: {status: "skipped", reason: "archive_only"}`. The raw
object format, checksum and `ingress-v1` source identity are unchanged. Standalone
raw metadata adds `ingressMode=archive-only` and starts with `eventNotifications=0`.
Only a matching successful v2 receipt can release `email.received` events and
owner/generic actions. Raw-before-receipt races, rejected late writes, missing
receipts, provenance mismatches and conflicting retained receipts cannot grant
that permission. Once qualified, the catalog retains it if the receipt disappears.
Parsing rejects v1 skipped outcomes and v2 forwarding claims.

Apply `0014_standalone_ingress.sql` before activating the mode. It expands the
catalog forwarding constraint and preserves sparse source rowids, snapshots,
scan state, Gmail invariants and routing policy/context rows. The parent-table
rebuild explicitly saves/restores both tables with cascading foreign keys.
Run it as one migration transaction/batch, as tested on local D1. Back up the
database and verify row/relationship preservation for a production migration.
The tests do not perform a production migration.

The reconciler accepts both receipt versions without rewriting objects.
`get_mail_health` reports `receipt_forward_skipped` separately from forwarding
failures and unknown snapshots. Missing originals remain missing. An absent
receipt does not become a fabricated skipped-forwarding record, even if the
operator currently runs archive-only mode.

## Cutover and rollback

1. Independently verify the historical import scope and receive, retrieval,
   specialist ownership, routing notification and send/reply paths. Resolve
   alert delivery and operational response ownership.
2. Save private route/version/configuration snapshots. Enumerate all routes
   handled by fumi and specialist Workers still forwarding independently.
3. Apply and verify the catalog migration separately. Deploy v1/v2 readers while
   retaining forwarding. Keep a rollback version with v2 support.
4. On an explicitly authorized test route/version, build archive-only mode and
   verify the artifact, bindings and deployed mode. Download controlled MIME and
   attachments and compare hashes. Verify receipt/catalog/MCP, absence of a
   forwarding action, and operational failure handling separately.
5. Only after those checks, authorize the selected production cutover. Remove
   unused forwarding secrets after checking consumers and the rollback plan.
   Merging this code does not change routes, delete secrets or send mail.

To restore forwarding, activate a v2-capable version built with `forward` and
restore the verified destination binding. Retain the widened schema and v2
receipts. A v1-only reader would treat new evidence as unsupported. Never replay
archived mail simply because forwarding was disabled; a new send is separate.

Synthetic tests cover both modes, exact bytes, malformed/oversized/stalled input,
R2 failures/deadlines, receipt loss, v1/v2 reconciliation, health counts, migration
preservation and native Email/Cron behavior from the production bundle. They
cannot establish external SMTP responses, sender retries, production alert
delivery or complete mailbox coverage. Those remain live acceptance gates.
