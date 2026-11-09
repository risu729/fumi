# Initial email capture

This slice preserves Gmail forwarding and stores private original MIME in R2.
It does not parse mail, extract attachments, run CEL or models, dispatch plugins,
backfill Gmail, or send new mail. Encrypted attachments remain in their original
MIME representation. Revisit CEL before implementing routing.

Gmail forwarding is temporary. The
[roadmap](roadmap.md#phase-2d-retire-gmail-forwarding) includes its retirement after
independent mail handling is verified. Gmail-based archive recovery is out of scope;
historical backfill remains a migration task.

## Delivery and storage boundaries

Gmail forwarding and archival are independent operations. An archive failure must
not prevent the forwarding attempt. A successful forwarding API call records
Cloudflare acceptance, not Gmail inbox placement. An exception does not establish
that SMTP will retry. If either operation is interrupted, inspect both outcomes
before recovery; never blindly forward every archived message again.

The handler accepts at most the Email Routing limit of 25 MiB. It reads bytes
without MIME decoding or text re-encoding, enforces the actual byte count as well
as the declared size, and checks SHA-256 on the R2 write. It stores one attempt
per invocation rather than deduplicating by the untrusted Message-ID header.
Duplicate SMTP deliveries therefore remain distinct evidence. A later logical
message index may link them using provenance and content hashes.

Objects use `ingest/YYYY-MM-DD/<random-ingest-id>/raw.eml` and `receipt.json`. The
original's private object metadata also preserves the envelope, capture time, ingest ID,
schema version and hash for recovery if the receipt write fails. The original and
receipt are separate R2 writes. A stored original with a missing receipt is an orphan to
reconcile, not proof that forwarding failed. A receipt with a missing original is an
archive gap. R2 outage and invocation termination can prevent both records. Payload-free
logs can identify failed attempts but cannot reconstruct missing MIME bytes. The future
capture/recovery design must work without Gmail before forwarding is retired. The
separate [catalog reconciler](archive-catalog.md) can repair D1 metadata from remaining
R2 evidence. The new [Workflows stage](processing-workflows.md) also indexes immediately
and repairs missing starts; its activation is pending. Neither can restore missing
originals, and no alert destination is configured.

Use a private R2 bucket: no r2.dev public access, no public custom domain, and no
HTTP endpoint serving messages. Keep envelope addresses and forwarding settings
out of public source, logs and deployment summaries. Application logs contain
attempt IDs and closed outcome codes only. Platform observability may
include email-event envelope metadata; restrict access to the Cloudflare account.

## Staged deployment

1. Inventory enabled explicit routes, catch-all rules and verified destinations. Save
   the complete original rules privately, including IDs, matchers, priorities,
   actions and enabled state. Keep specialist Worker routes in place.
2. Provision the private R2 bucket. Build and run runtime tests before deploying
   the Worker. Configure the verified Gmail destination as a Worker secret.
   Do not enable a route before verifying the deployed binding and destination.
3. Create one dedicated test address pointing to fumi. Duplicate rules for an
   existing pattern are not a tee: only the first matching route is used.
4. Send controlled MIME with a unique marker and an attachment. Retrieve the
   stored bytes privately, compare the stored size and SHA-256, and verify decoded
   attachment bytes against the test payload. Inspect the forwarding receipt and
   the destination independently. Do not publish real messages as fixtures.
   Route activation can lag API readback: require the received message's fresh
   `X-Fumi-Ingest-ID` to match the stored receipt. Record the propagation window
   for capture coverage checks; an earlier message may use the old route.
5. Move one selected ordinary route only after acceptance. Re-read the route and
   test it again. Keep the other domain and specialist routes unchanged until
   they have their own acceptance evidence.

Sending from the same Gmail account that receives forwarded mail can cause Gmail
to suppress a duplicate. A SENT copy alone is not receipt evidence. Prefer a
different sender account for the final delivery test; otherwise record that
limitation and keep broad cutover pending.

## Rollback and recovery

- Restore the selected rule's original forwarding action from the private
  snapshot. Preserve its other fields, then read it back. Retain stored originals
  and receipts; route rollback does not require deleting evidence or the bucket.
- For an archival failure, identify the affected time window using outcome logs,
  receipts and R2 metadata. Record missing originals as unresolved; catalog repair
  cannot recreate them. There is no automatic Gmail recovery in the plan.
- For a forwarding error or unknown outcome, check Cloudflare delivery activity
  and Gmail first. Archive presence does not authorize or prove a second delivery.
- For missing receipts, list the original/receipt pairs and inspect stored object
  metadata. Reconstruct only facts supported by evidence; retain unknown outcomes.
- Keep all originals by default in this initial slice. Retention/deletion policy,
  lifecycle rules, archive-failure monitoring and alert delivery are follow-up
  work; no automatic expiry is configured.

## Access and repeatable deployments

The first Worker creation needs broader provisioning access. After it exists,
use an account-owned token with **Workers Editor scoped to fumi only** for routine
deployment. Binding the existing bucket does not need direct R2 API access on
that token. Route changes and direct object inspection remain separate operations
with their own authorized access. Store the deployment token in the repository's
Actions secret, not source or logs.

The manual production deployment workflow runs CodeQL, builds and checks the
selected main commit, and refuses a stale dispatch if main has advanced before
publication. The SHA-pinned shared deploy action validates that exact build,
uploads a version, activates it, and verifies the returned deployment and active
version at 100 percent traffic. It preserves existing secrets and leaves trigger
synchronization disabled. See [repository conventions](repository-conventions.md)
for the comparison with other repositories.

`mise run deploy:bootstrap` retains the full `cf deploy --no-provision` path for
explicit initial setup or maintenance. Routine production publishing uses the
workflow's versions strategy and its deployment readback. Deploying code does
not certify that Email Routing, Gmail delivery or archival succeeded; record
their acceptance separately.

## Migrating the remaining routes

An ordinary forwarding rule or catch-all can use the existing handler without a
code change. Refresh its private snapshot, verify the destination and deployed
bindings, select **Send to a Worker** with `fumi`, then read the rule back. Where
Email Routing already handles the domain, this changes the routing action rather
than the domain's MX records. Repeat the controlled attachment test and require
both received Gmail provenance and matching R2 bytes before accepting cutover.
Record activation delay and any capture coverage gaps from the old route.

Explicit specialist Worker rules take precedence over the catch-all; switching
the catch-all does not archive their messages through fumi. Keep them in place
until the [plugin contract](plugins.md) is implemented in both fumi and the
specialist Worker. That requires adopting the specialist's versioned rules,
an authenticated service integration, request correlation and an idempotent
claim/result protocol. Preserve archival and Gmail as independent delivery lanes;
designate exactly one Gmail-forwarding owner when replacing the specialist's
current email handler. Archive before handing off; distinguish `handled`,
`not_applicable` and `uncertain` outcomes. Only an explicit non-match proceeds
through normal action routing; timeouts must not silently duplicate actions or lose
mail. Revisit the CEL evaluator before implementing this routing layer. Test
pending-request matches, non-matches, retries and ambiguous outcomes before
migrating a specialist route. The current handler always forwards to Gmail and
does not yet implement this protocol or the future webhook pipeline.

## Staged production acceptance: 2026-11-07

The initial runtime in [PR #7](https://github.com/risu729/fumi/pull/7) was deployed,
then
[deployed through GitHub Actions](https://github.com/risu729/fumi/actions/runs/42345219531)
using the account-owned token scoped to this Worker. The deployed version was read back
at 100 percent traffic. The R2 bucket's public access and the Worker's `workers.dev` and
preview URLs were confirmed disabled.

A dedicated test route and one domain's catch-all route were each verified with
controlled Gmail messages containing Japanese text and a binary attachment.
Separate received Inbox messages contained fresh ingestion IDs matching their
private R2 receipts. Downloaded originals matched the recorded size and SHA-256;
decoded binary attachment bytes matched the test input. Other-domain routes,
including specialist Workers, were read back unchanged. Private route snapshots,
rollback data, raw messages and detailed acceptance evidence are retained outside
the repository.

This proves the tested live path. It does not establish automatic archive-gap
reconciliation, alert delivery, concurrent maximum-size memory behavior, or
coverage of routes that were not migrated. Those remain explicit follow-up work.

## Primary references

- [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Routing limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Local routing tests](https://developers.cloudflare.com/email-service/observability/local-development/routing/)
- [R2 binding and checksum behavior](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Routing patterns](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Testing forwarded mail](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Worker-scoped roles](https://developers.cloudflare.com/workers/authorization/workers/)
