# ADR 0006: Import Outlook PST exports and group them with existing copies

Status: accepted by the owner on 2026-11-28 at 08:59 UTC
("はい、まとめる理由を足すべきと思う", "yes, I think the reason to group them should be
added"), answering the proposal to store every PST item as its own original and add a
grouping rule so that the copies collapse (option 1 below). The converter, the
transport and the grouping rule are implemented (amendments 2026-11-28); the readers
are not. Everything
else, including the reasoning under "Why group instead of dropping", was written by an
agent and is not confirmed by the owner. Amends
[ADR 0004](0004-gmail-takeout-import-and-copy-grouping.md): one more grouping rule, and
(agent) a new transport that uses the Takeout bucket.

Date: 2026-11-28

## Context

- The owner exported two Microsoft mailboxes from Outlook (classic) on 2026-11-28 as
  `.pst` files, whole mailbox, root with subfolders: a university Microsoft 365
  mailbox (about 477 MB) and a personal Microsoft account mailbox (about 10 MB). The
  files stay in the owner's Drive as the archive. fumi can import only Gmail
  Takeout mbox files ([historical Gmail import](../gmail-import.md)).
- Trial conversion on 2026-11-28 with libpst `readpst` 0.6.76 (`-r -e -D`, one `.eml`
  per item), cross-checked with libpff `pffexport` 20180714:
  - readpst must run with `-j 0`. By default it forks `4 x CPUs` children that share the
    parent's PST file offset, and each run silently skipped a different 23 to 41 Inbox
    items and lost the `Received` headers of others. With `-j 0` every run gives the
    same items; the bytes still differ between runs, because MIME boundaries are random.
  - Mail items: 2,666 in the university mailbox (Inbox 2,614, the same as Outlook
    shows; Sent Items 33; Junk Email 17; Archive 2) and 89 in the personal one (Inbox 2,
    Archive 87). 25 are meeting requests or responses. Every item has a Message-ID; two
    different Inbox items share one.
  - Received items keep their transport headers (`Received`, `DKIM-Signature`,
    `Authentication-Results`) from `PR_TRANSPORT_MESSAGE_HEADERS`. The 35 items the
    owner sent (Sent Items and the university Archive) have none: readpst writes only
    `Status, From, Subject, To, Cc, Date, Message-Id`, with `From: MAILER-DAEMON` (the
    sender is an Exchange X500 name) and display names only in `To`.
  - The MIME is rebuilt, not the delivered message: always `multipart/mixed`, no
    `text/plain` alternative, inline images as attachments, and Exchange's first-contact
    safety tip inside the HTML. Compared with fumi's copies of six messages, headers and
    attachment bytes were equal and decoding (including ISO-2022-JP) was correct, but
    the raw SHA-256 never matches and DKIM no longer verifies.
- Against production `mail_identity` (identity-v2, 2026-11-28 ~08:50 UTC), 2,642 of the
  2,755 items have a Message-ID fumi already holds, almost all from the main Gmail
  account's Takeout; 113 are new (80 university Inbox notifications from Teams,
  SharePoint and internal senders the university forwarding did not pass on, 31 sent
  items (18 sent mails, 11 meeting responses and 2 Archive items), 2 personal Inbox
  items). With the current rules only 1,470 of the 2,642 would
  group with the existing copy. For 1,166 the PST copy is unsigned while fumi's copy
  carries exactly one `DKIM-Signature`, with equal From and Date: most likely the
  signature of the hop that forwarded the mail to Gmail. 4 are sent items whose
  `From` is `MAILER-DAEMON`, and 2 differ otherwise.
- No PST item carries `X-Fumi-Ingest-ID`: the PST is the first mailbox, before any fumi
  hop.

## Options considered

1. **Store every item and group the copies** (accepted).
2. Import only the 113 new items and skip the rest before storage by Message-ID, DKIM
   `bh=`, From and Date. Rejected: it decides on header values that anyone who has
   seen a message can copy, so a forged earlier copy would keep a PST item out of the
   archive entirely, and it breaks ADR 0004's rule that "each route keeps its own source
   and provenance".
3. Do nothing and keep the PST only in Drive. Rejected: the 113 new items, including the
   owner's 18 sent mails found nowhere else in fumi, would stay unsearchable.

## Decision

### Why group instead of dropping

Agent reasoning, asked for by the owner.
[ADR 0005](0005-capture-mail-delivered-directly-to-gmail.md) drops a Gmail-forwarded
delivery before storage only when an `X-Fumi-Ingest-ID` value names a stored live ingest
with the same Message-ID, and archives everything else (fail open). It applies to live
deliveries, not imports, and no PST item has that header anyway, so its rule would drop
nothing here. Grouping then does what dropping
would have done for readers, without losing anything: a duplicate is hidden in default
listings, `expand_copies` still shows it, and a forged header can at most hide a copy
(ADR 0004, Consequences). The PST copy also carries what no other copy has: the Outlook
folder, and the mailbox's own view of the message.

### Import

1. **Every mail item is stored as its own original** (owner). Agent: in a new source
   kind with one namespace per mailbox, through a new transport. The Gmail Takeout
   transport is not extended: its splitter depends on mboxrd, `X-GM-THRID`,
   `X-Gmail-Labels` and the Gmail ID/date check.
2. **Grouping gets one more rule** (owner). Agent: a PST original without DKIM joins an
   earlier original with the same Message-ID, From and Date even when that one is
   signed. Every other rule is unchanged.

Agent specification:

- Conversion runs on the owner's computer with `readpst -j 0 -r -e -D`. A converter
  script writes one object per item and a `manifest.jsonl` line per item: object key,
  size, SHA-256, PST node ID, folder path (UTF-8 names), item kind (`note`, `schedule`,
  `report`), delivery time (`PR_MESSAGE_DELIVERY_TIME`, or the submit time for sent
  items) and `headers: "transport" | "synthesized"`. readpst does not print node IDs;
  the converter reads them with libpff (`pypff`) or a readpst patch, to be checked in
  the implementation.
- Identity: ingest ID = UUID from SHA-256(`["outlook-pst-v1", namespace, pstNodeId]`).
  Message-ID is not used, because it is untrusted and not unique (two items in one
  mailbox share one). Because readpst output is not byte-stable, a replay compares the
  manifest entry, not the raw SHA-256.
- Namespace: `outlook-` + the first 24 hex digits of SHA-256(primary mailbox address),
  like the `gmail-` namespaces.
- `received_at` and the `ingest/<date>/` key come from the manifest's delivery time,
  never from the `Date` header.
- Catalog: new `source_kind` `mailbox_export`. `archive_sources` is rebuilt with rowids
  kept, as migrations 0008 and 0014 did, with `notify_events = 0` and no forward status
  for the new kind. As in 0014, the tables that reference `archive_sources` with
  `ON DELETE CASCADE` (the two routing policy tables of 0012) are backed up and
  restored around the rebuild. The `archive_source` filter, catalog, reconciler and
  health learn the kind.
- Representative order: today every source that is not live capture is ordered by
  `received_at` (`src/mail-read.ts`, `src/content-search.ts`). A PST delivery time is
  earlier than the Gmail receipt time, so the order gets an explicit rank: live
  capture, then Gmail copies, then `mailbox_export`.
- Receipt schema `outlook-pst-v1`: `{runId, objectKey, manifestLine, exportSha256,
  pstNodeId, converter, folder, itemKind, headers}`. Run and item ledgers are new
  tables (`pst_import_runs`, `pst_import_items`); the Takeout tables hold Gmail IDs.
  Lease, checkpoint (manifest line), one Workflow instance at a time and `mime-v1`
  jobs work as in the Takeout runner.
- Folders: a table like `gmail_takeout_labels`, keyed by the PST original's raw key.
  `in:inbox` and `in:sent` are unchanged, so they match no PST original (they select
  live capture and Gmail labels); a folder filter can come later.
- `headers: "synthesized"` is kept in the receipt and shown by readers. For sent items
  the manifest also records the account's own address and the recipients' SMTP
  addresses from the PST recipient table, as data; the stored bytes are not rewritten.
- The converted objects and the manifest go to the private bucket `fumi-takeout`
  under `<namespace>/<export-date>/`, and a secret `PST_IMPORT_CONFIG` (`runId`,
  `accountNamespace`, manifest key and size, `attempt`, `skip`) configures a run, read
  only by the Workflow. They are deleted after acceptance, like the Takeout files.
- Meeting requests and responses and the 35 synthesized-header items are imported,
  flagged, not skipped.

## Consequences

- About 350 MB more in the archive bucket (the converted items total 354 MB), most of
  it copies that grouping hides.
- PST originals are reconstructions. Readers must not treat them as the delivered
  message: no DKIM verification, and the receipt's `headers` value says when the
  headers were rebuilt.
- 6 items stay ungrouped with the current data (4 sent items with `From: MAILER-DAEMON`,
  2 others) and show as separate results.
- The new grouping rule trusts Message-ID, From and Date across a signed/unsigned pair
  for PST originals only. As with the other rules, a forged copy can at most hide one
  in default listings.
- `in:inbox` and `in:sent` do not find PST originals, including the 31 new sent items,
  until a folder filter exists. Other searches find them.
- A production run still needs the owner's go, after the code is merged.

## Verification

- Per mailbox: manifest line count against the folder counts above (university Inbox
  2,614), every item `imported` or listed with a fixed reason.
- Grouping: with the 2026-11-28 data, 2,636 of the 2,642 duplicates group with their
  existing copy (1,470 by the current rules, 1,166 by the new one).

## Amendment 2026-11-28: converter details (agent)

The converter is implemented ([Outlook PST import](../outlook-pst-import.md)). Two
points differ from the agent specification above:

- The manifest records no addresses. pypff 20180714 has no recipient API, so the
  recipients' SMTP addresses of synthesized sent items are not extracted, and the
  account's own address is not written either; the namespace already identifies the
  account. readpst's `To` display names stay in the stored bytes.
- The namespace hashes the account's sign-in address (lower case), the address the
  owner types when exporting, which is not always the mailbox's primary SMTP address.
  Every later export of the same mailbox must hash the same address, or it gets a
  second namespace and its items become separate originals.

## Amendment 2026-11-28: transport details (agent)

The transport is implemented
([Worker transport](../outlook-pst-import.md#worker-transport)). Details the
specification above left open or that differ:

- The folder table is `pst_messages`, keyed by raw key and unique per mailbox and node
  ID. It also holds the item kind, `headers`, delivery time, export SHA-256, run and
  manifest line, so it plays the part of `gmail_messages` for PST originals, and the
  reconciler restores it from the receipt.
- The receipt is flat: the fields listed above plus `schemaVersion`,
  `accountNamespace`, `deliveredAt`, `importedAt`, `rawKey`, `rawSize` and `rawSha256`.
- `PST_IMPORT_CONFIG` also takes `onConflict` (`stop` by default, or `record`), as the
  Takeout configuration does. A conflict is an item whose node ID is already stored
  from another export or with another folder, kind, headers or delivery time.

## Amendment 2026-11-28: grouping rule in both orders (agent)

The grouping rule is implemented ([copy grouping](../copy-grouping.md#mailbox-exports)).
"Joins an earlier original" alone would depend on indexing order, which is newest
catalog row first, so a full re-backfill would index the PST originals before the
older Gmail copies and split them. A signed row therefore also joins an earlier
unsigned PST original with the same Message-ID, From and Date when no signed row
matches it.
