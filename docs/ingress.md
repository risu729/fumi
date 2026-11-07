# Initial email capture

This slice preserves Gmail forwarding and stores private original MIME in R2.
It does not parse mail, extract attachments, run CEL or models, dispatch plugins,
backfill Gmail, or send new mail. Encrypted attachments remain in their original
MIME representation. Revisit CEL before implementing routing.

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

Objects use `ingest/YYYY-MM-DD/<random-ingest-id>/raw.eml` and `receipt.json`.
The original's private object metadata also preserves the envelope, capture time,
ingest ID, schema version and hash for recovery if the receipt write fails.
The original and receipt are separate R2 writes. A stored original with a missing
receipt is an orphan to reconcile, not proof that forwarding failed. A receipt
with a missing original is an archive gap. R2 outage and invocation termination
can prevent both records; payload-free logs and Gmail are the recovery sources.
There is no automatic reconciler or alert destination in this slice.

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
- For an archival failure, identify the affected time window using outcome logs
  and receipts, then reconcile from Gmail. Gmail's forwarded copy can have added
  headers, so preserve it as a distinct source with its own hash. Do not overwrite
  the ingress original or claim it is byte-identical.
- For a forwarding error or unknown outcome, check Cloudflare delivery activity
  and Gmail first. Archive presence does not authorize or prove a second delivery.
- For missing receipts, list the original/receipt pairs and inspect stored object
  metadata. Reconstruct only facts supported by evidence; retain unknown outcomes.
- Keep all originals by default in this initial slice. Retention/deletion policy,
  lifecycle rules, automated gap reconciliation and alert delivery are follow-up
  work; no automatic expiry is configured.

## Access and repeatable deployments

The first Worker creation needs broader provisioning access. After it exists,
use an account-owned token with **Workers Editor scoped to fumi only** for routine
deployment. Binding the existing bucket does not need direct R2 API access on
that token. Route changes and direct object inspection remain separate operations
with their own authorized access. Store the deployment token in the repository's
Actions secret, not source or logs.

The manual production deployment workflow builds and checks the selected main
commit before deployment. Deploying code does not certify that Email Routing,
Gmail delivery or archival succeeded; record their acceptance separately.

## Primary references

- [Email handler API](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)
- [Routing limits](https://developers.cloudflare.com/email-service/platform/limits/)
- [Local routing tests](https://developers.cloudflare.com/email-service/observability/local-development/routing/)
- [R2 binding and checksum behavior](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Routing patterns](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)
- [Testing forwarded mail](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Worker-scoped roles](https://developers.cloudflare.com/workers/authorization/workers/)
