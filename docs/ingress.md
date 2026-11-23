# Email capture

The default receive mode preserves Gmail forwarding and stores private original
MIME in R2. Downstream processing handles parsing, extraction, indexing and
routing independently. The optional [standalone mode](standalone-ingress.md)
requires confirmed raw storage and skips forwarding; production activation is
separate. Encrypted attachments remain intact in their original MIME.

Gmail forwarding is temporary. The
[roadmap](roadmap.md#phase-2d-retire-gmail-forwarding) includes its retirement after
independent mail handling is verified. Gmail-based archive recovery is out of scope;
historical backfill remains a migration task. Mail delivered directly to Gmail comes
back through Gmail's own forwarding and is handled as described in
[mail delivered directly to Gmail](gmail-relay.md).

## Delivery and storage boundaries

Gmail forwarding and archival are independent operations. An archive failure must
not prevent the forwarding attempt. A successful forwarding API call records
Cloudflare acceptance, not Gmail inbox placement. An exception does not establish
that SMTP will retry. If either operation is interrupted, inspect both outcomes
before recovery; never blindly forward every archived message again.

A failed forward of a stored original does not fail the email event (owner decision,
2026-11-23 17:53 UTC: Gmail forwarding is optional and the copy in fumi is enough,
"gmailへの転送は必須じゃないので、fumiにあればいいよ"). The handler returns normally, so
Email Routing accepts the message and the sender does not retry; the receipt and the log
keep the failure and its [reason](#forward-failure-reasons), and
[health](archive-health.md#failed-forwards-and-retry-recovery) lists it. This includes
`invalid_target`: a missing or unsafe `FORWARD_TO` no longer makes senders retry while
the configuration is fixed. The handler still throws "Forwarding did not complete" when
the forward failed and either the original or its receipt was not stored, so the
sender's retry is the recovery path and the failure is not left without a record.
Evidence: from 2026-11-22 13:24 UTC one message whose sender passes DMARC only through
SPF under `p=reject` failed every forward (Email Routing rewrites the envelope sender,
so it then fails DMARC at Gmail), and its sender retried every three hours, adding an
archived copy each time.

### Forward failure reasons

Status (2026-11-22 07:46 UTC): implemented for
[#138](https://github.com/risu729/fumi/issues/138); live provider error text has not
been observed, so the patterns below are tested only against synthetic errors.

A `message.forward()` rejection keeps only a fixed code and, when present, the
[RFC 3463](https://www.rfc-editor.org/rfc/rfc3463) enhanced status code. The error
text itself is never stored or logged: it can carry addresses, headers or provider
text. The Workers types promise only a rejected Promise, so classification is
deliberately strict, inspects at most the first 512 characters, and leaves anything
else unclassified:

| Error text (synthetic example) | `code` | `smtpStatus` |
| --- | --- | --- |
| `550 5.7.1 ...` or `550-5.7.1 ...` anywhere | `rejected_permanent` | `5.7.1` |
| `421 4.7.0 ...` | `rejected_temporary` | `4.7.0` |
| A `TimeoutError`, or `timeout` / `timed out` with no paired SMTP reply | `timeout` | none |
| Anything else | `forward_failed` | none |

Only a 4xx or 5xx reply code directly followed (after a space or hyphen) by an enhanced
status of the same class classifies as a rejection. Neither part may sit inside an
address, path, hostname or longer number, so `user550@...` and `GET /550 5.1.1/x` stay
unclassified. The classifier ignores everything else that merely looks like SMTP and
records `forward_failed` (review fix, 2026-11-22 14:00 UTC):

- A reply code alone, such as `552 Requested mail action aborted`, `404 Not Found` or
  `500 Internal Server Error`: it is too often an HTTP status.
- An enhanced status alone, such as `runtime 4.1.3 failed`, `node 5.0.1 crashed`,
  `http://h/v1/5.0.0/x`, `5.1.1:25 refused` or `port 465 5.0.0`: it is too often a
  version number, path segment or address. A `2.x.x` status never counts either.
- A reply code and status of different classes, such as `550 4.1.1`.

So a bare enhanced status is not classified and the receipt stays an unchanged v1
`forward_failed`. The timeout words count only as a word of their own: inside an
address, URL or hostname, such as `timeout@example.com` or `timeout.example.com`, they
do not, while `connection-timeout` and `upstream timeout.` do. A paired reply wins over
a timeout word: `421 4.4.2 connection timed out` gives `rejected_temporary` with
`4.4.2`. The destination check keeps its own `invalid_target` code, which also covers
the forwarding-loop guard.

The receipt keeps the oldest version that can hold the outcome. Success,
`invalid_target` and an unclassified `forward_failed` stay unchanged v1 receipts.
A classified failure is a v3 receipt, and a v3 receipt with `forward_failed` and no
`smtpStatus` is invalid because that outcome is always v1:

```json
{"schemaVersion": 3, "forward": {"status": "failed", "code": "rejected_permanent", "smtpStatus": "5.7.1"}}
```

Its other fields are those of v1. The catalog snapshot copies the same fields. A
Worker version without v3 support reports such a receipt as `unsupported_receipt`.
The reader and the writer ship together (owner decision, 2026-11-22): a rollback to
such a version only degrades the rows with v3 receipts, which lose the default reply
sender and the routing envelope until a v3-capable version is deployed again and the
reconciler rescans them. Nothing is lost. Receipts written
before this change have no class: their `forward_failed` and missing `smtpStatus`
mean unknown, not a confirmed rejection. The `ingest` log line adds `forwardCode`
and, when present, `smtpStatus` for a failed forward, and nothing else.

The handler accepts at most the Email Routing limit of 25 MiB. It reads bytes
without MIME decoding or text re-encoding, enforces the actual byte count as well
as the declared size, and checks SHA-256 on the R2 write. It stores one attempt
per invocation rather than deduplicating by the untrusted Message-ID header.
Duplicate SMTP deliveries therefore remain distinct evidence. The one exception is a
[Gmail relay](gmail-relay.md#dropping-copies-fumi-already-holds) of mail fumi already
holds, which needs its own `X-Fumi-Ingest-ID` and Message-ID to match. A later logical
message index may link them using provenance and content hashes.

Objects use `ingest/YYYY-MM-DD/<random-ingest-id>/raw.eml` and `receipt.json`. The
original's private object metadata also preserves the envelope, capture time, ingest ID,
schema version and hash for recovery if the receipt write fails. The original and
receipt are separate R2 writes. A stored original with a missing receipt is an orphan to
reconcile, not proof that forwarding failed. A receipt with a missing original is an
archive gap. R2 outage and invocation termination can prevent both records. Payload-free
logs can identify failed attempts but cannot reconstruct missing MIME bytes. The
standalone mode rejects unconfirmed raw storage; its live failure behavior must
be accepted before forwarding is retired. The
separate [catalog reconciler](archive-catalog.md) can repair D1 metadata from remaining
R2 evidence. The new [Workflows stage](processing-workflows.md) also indexes immediately
and repairs missing starts; production activation was verified on 2026-11-10.
Neither can restore missing
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

The first Worker creation needs broader provisioning access. After it exists, use an
account-owned token with **Workers Editor scoped to fumi only** and account-level
**D1 Write** for routine deployment, which applies catalog migrations
([ADR 0002](adr/0002-continuous-deployment.md)). Binding the existing bucket does not
need direct R2 API access on that token. Route changes and direct object inspection
remain separate operations with their own authorized access. Store the deployment token
in the repository's Actions secret, not source or logs.

The production deployment in CI runs for every main commit whose checks and CodeQL pass,
applies pending catalog migrations, and skips a commit that is no longer the main head
([ADR 0002](adr/0002-continuous-deployment.md)). The SHA-pinned shared deploy action
validates that exact build, uploads a version, activates it, and verifies the returned
deployment and active version at 100 percent traffic. It preserves existing secrets and
leaves trigger synchronization disabled. See
[repository conventions](repository-conventions.md) for the comparison with other
repositories.

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
migrating a specialist route. The default handler continues forwarding to Gmail;
the implemented owner/dispatch protocol and current acceptance are described in
[plugins](plugins.md) and [routing dispatch](routing-dispatch.md).

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
