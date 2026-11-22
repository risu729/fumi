# Bounded archive health observations

`getMailHealth(env, principal)` is a read-only aggregate for an authenticated
`mail:read` principal. The application exposes it as `get_mail_health`; it does
not configure an alert receiver, send notifications, purge data or contact a mail
provider. No additional resource, permission or private configuration is required.

The helper reads only D1. Original `stored`, `missing` and `unknown` counts describe
the catalog's observations of R2 originals: stored means `raw_state=present`,
missing means `missing`, and invalid evidence is unknown. It does not list R2,
read original mail or verify that a previously observed object still exists or
matches its saved hash. A later bounded archive reconciliation can change these
observations. The report never claims a live bucket inventory or a complete archive.

Retained validated ingress snapshots report known archive-capture and Gmail forwarding
failures separately. V1 and v3 receipts both count as forwarding failures; v3 adds a
[failure reason](ingress.md#forward-failure-reasons). V2 standalone receipts count
intentional forwarding omission as `receipt_forward_skipped`; it is neither successful
forwarding nor a forwarding failure. A failure remains known when a later scan finds the
receipt object missing. Missing, malformed or absent snapshots are unknown; they do not
prove successful capture or forwarding. Gmail imports have no SMTP forwarding receipt
and are not counted as failed ingress snapshots. Recipient addresses, object keys,
Message-ID headers, cursors, policy text and provider error text are never returned.
The only message identifiers returned are the opaque `mail_` IDs of
[failed forwards](#failed-forwards-and-retry-recovery).

MIME coverage distinguishes current complete extractions, blocked records,
present originals awaiting an extraction, and stale/unverifiable results.
Processing counts describe pipeline jobs, so they are not counts of distinct mail
or proof of delivery. Import counts distinguish completed configured scopes,
pending scopes, staged pages, current leases and checkpointed memberships. The
durable-membership window can include messages saved before a page checkpoint;
overlapping import scopes can count the same original more than once. Completing
a configured date range does not prove whole-mailbox completeness.

Each catalog, processing and membership section examines at most the latest 1,000
inserted rows; import scopes examine at most 100. One additional row determines
whether a window is truncated. These are insertion-order windows, not a list of
all outstanding failures or the newest state changes. An older failed source may
be outside the window. Missing optional tables or failed queries make the affected
section explicitly unknown. A missing scan checkpoint is also unknown. The scan
counter describes completed R2 listing passes, not upstream email acceptance.

There are at most eight fixed read queries and a shared five-second deadline.
An expired query cannot start further queries; a database operation already in
flight may finish later. Sections are not a single transactional snapshot. Counts
and truncation apply only to their stated window, even when every reported count
is zero. `archive_completeness` is always `unknown`: uncataloged objects and
events that left no surviving catalog or receipt evidence are invisible here.
The number of unseen ingress events and total mailbox size remain `null`.

Synthetic workerd tests cover empty/unknown coverage, capture and forwarding failures,
forwarding failure codes, the failed forward list cap and closed output shape, recovery
through the same Message-ID, malformed receipt evidence, MIME/job states, partial and
overlapping imports, window limits, missing schema, scope enforcement and stalled
queries. They do not establish production receipt, a live R2 inventory or end-to-end
mail capture completeness.

## Failed forwards and retry recovery

Status (2026-11-22 07:52 UTC): implemented for
[#138](https://github.com/risu729/fumi/issues/138). Before this, health only counted
forwarding failures, and finding the failed messages needed direct D1 access.

A forward failure usually throws, Email Routing reports a temporary failure, and the
sender retries. Each attempt is its own ingress row, so the failure count overstates
mail that never reached the destination. `sections.forward_failures` reads the same
1,000-row window as the catalog section and returns:

```json
{
  "counts": {
    "receipt_forward_failures": 3,
    "receipt_forward_failures_recovered": 1,
    "receipt_forward_failures_unrecovered": 1,
    "receipt_forward_failures_recovery_unknown": 1
  },
  "failed_forwards": [
    {"id": "mail_<uuid>", "received_at": "2026-11-21T01:00:00.000Z", "code": "rejected_permanent", "smtp_status": "5.7.1", "recovery": "unrecovered", "recovered_by": null},
    {"id": "mail_<uuid>", "received_at": "2026-11-21T00:30:00.000Z", "code": "timeout", "smtp_status": null, "recovery": "unknown", "recovered_by": null},
    {"id": "mail_<uuid>", "received_at": "2026-11-21T00:00:00.000Z", "code": "forward_failed", "smtp_status": null, "recovery": "recovered", "recovered_by": "mail_<uuid>"}
  ],
  "failed_forwards_truncated": false
}
```

The section also carries the usual `status` and `window`. The list holds at most the
20 newest failures by `received_at`; the counts cover every failure in the window, and
`failed_forwards_truncated` says when the list is shorter. `code` and `smtp_status`
come from the retained receipt snapshot
([forward failure reasons](ingress.md#forward-failure-reasons)); failures recorded
before reasons existed show `forward_failed` and `null`. Pass an `id` to `read_email`
for the message itself.

`recovery` is `recovered` when a later ingress row in the window was forwarded, its
current MIME extraction has the same `Message-ID` header and its receipt has the same
envelope sender (`envelope.from`); `recovered_by` names the earliest such row. It is
`unrecovered` when the failed row has a usable Message-ID and no such row exists, and
`unknown` when its extraction is missing, pending, blocked or stale or has no usable
Message-ID. A usable Message-ID has a non-empty part on each side of `@` once angle
brackets are trimmed, so `<>` (what the parser returns for an empty header),
`<@host>` or `<id@>` give `unknown` rather than matching every other mail with the
same degenerate value (review fix, 2026-11-22 14:00 UTC). The match reads
`mail_extractions.metadata_json` and the receipt snapshot, so it needs no new index or
migration; the 1,000-row window bounds its cost. Matching is deliberately narrow:

- `recovered_by` is a later forwarded copy of the same message, not necessarily a
  retry. One message delivered to two aliases arrives as two ingress rows with the
  same Message-ID and envelope sender, so a failure to one alias reads as `recovered`
  by the sibling copy to the other alias even if the failed delivery was never
  retried. Check which alias `recovered_by` was addressed to.
- A sender's resend under a new Message-ID counts as `unrecovered`. Subject was not
  used: two distinct mails can share it. Envelope sender alone is not a key either,
  but a different envelope sender rules a match out, so a sender reusing another
  sender's Message-ID does not count.
- A forwarded copy received before the failure, or at the same instant, is not a
  recovery.
- The parsed header values are compared exactly, angle brackets and letter case
  included; a genuine retry carries the same bytes.
- Message-ID is an untrusted header. A recovery is a hint that the destination
  accepted an attempt of the same message, not proof of Gmail inbox placement. Any
  sender who knows a failed message's Message-ID and can send from the same envelope
  sender, including the original sender reusing a constant Message-ID, can make that
  failure read as `recovered` by getting a later message with the same header
  forwarded. Check the `recovered_by` message before relying on a recovery.
- A retry outside the window, not yet cataloged, or without a current extraction is
  not seen, so the failure stays `unrecovered` until that retry is extracted.

Treat `receipt_forward_failures_unrecovered` and `recovery_unknown` as the messages
to check in Gmail.
