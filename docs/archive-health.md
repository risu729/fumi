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

Retained validated ingress snapshots report known archive-capture and Gmail
forwarding failures separately. V2 standalone receipts count intentional forwarding
omission as `receipt_forward_skipped`; it is neither successful forwarding nor a
forwarding failure. A failure remains known when a later scan finds
the receipt object missing. Missing, malformed or absent snapshots are unknown;
they do not prove successful capture or forwarding. Gmail imports have no SMTP
forwarding receipt and are not counted as failed ingress snapshots. Recipient
addresses, object keys, message IDs, cursors, policy text and provider error text
are never returned.

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

There are at most seven fixed read queries and a shared five-second deadline.
An expired query cannot start further queries; a database operation already in
flight may finish later. Sections are not a single transactional snapshot. Counts
and truncation apply only to their stated window, even when every reported count
is zero. `archive_completeness` is always `unknown`: uncataloged objects and
events that left no surviving catalog or receipt evidence are invisible here.
The number of unseen ingress events and total mailbox size remain `null`.

Synthetic workerd tests cover empty/unknown coverage, capture and forwarding
failures, malformed receipt evidence, MIME/job states, partial and overlapping
imports, window limits, missing schema, scope enforcement and stalled queries.
They do not establish production receipt, a live R2 inventory or end-to-end mail
capture completeness.
