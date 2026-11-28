# Copies of one message

Status: implemented and accepted in production (the grouping half of
[ADR 0004](adr/0004-gmail-takeout-import-and-copy-grouping.md)). Acceptance is the 276
live/Gmail Message-ID pairs described in the ADR: with `identity-v2` all 276 collapse
by default and expand to both copies.

Production check of `identity-v2`, 2026-11-23 04:10 UTC, after the backfill indexed
every original again: for `after:2026-11-07 before:2026-11-12`, the live side had 309
results, the Gmail side 374 and both together 407, so all 276 live/Gmail groups
collapsed. Every live result stayed its group's representative, and no ID repeated
within a traversal. With `expand_copies: true` the same search returned 689 originals:
the 683 live and Gmail results plus 6 copies of other source kinds that the collapse had
hidden.

Production check of `identity-v1`, 2026-11-23 01:00 UTC, after the backfill indexed
all 5,947 originals with none blocked: for `after:2026-11-07 before:2026-11-12`, the
live side had 309 results, the Gmail side 374 and both together 408, so 275 live/Gmail
groups collapsed. The live and Gmail results shared 276 Message-IDs. The one pair left
apart was an unsigned original: its Gmail copy carried two `DKIM-Signature` headers that
the forwarding route added above `X-Fumi-Ingest-ID` (`d=cloudflare-email.net` and the
owner's domain), so it fell under the Message-ID/DKIM rule while the live copy fell
under the Message-ID/From/Date rule. `identity-v2` ignores those signatures (below).

The same mail reaches the archive by several routes: live capture at `takuk.me`,
the Gmail account that first received it, and every Gmail account it was forwarded to.
Each route keeps its own original, catalog row and provenance; nothing is merged,
rewritten or deleted. Every hop adds headers, so the raw SHA-256 of two copies never
matches. Grouping instead compares a few header values that hops keep.

## Identity index

`repairMailIdentity` runs in every scheduled invocation (every five minutes). It selects
up to 200 present originals that have no `mail_identity` row of the current
`identity_version`, newest catalog row first, among sources added since its last clean
pass, and across the whole catalog at the
[scan cadence](processing-workflows.md#scheduled-scan-cadence) (hourly, and at once
after an `identity_version` change), so new mail is grouped within one interval and the
backlog drains behind it. For each one it reads only the first 64 KiB of the original
(the MIME header budget) with a ranged R2 read and writes one row. Rows are never
updated; a row of an older `identity_version` is replaced by the backfill, and reads use
only current rows. A read that throws (an R2 outage) writes nothing for that original,
which stays pending for a later run without holding back the others; the run reports it
as `deferred`.

| Column | Value |
| --- | --- |
| `message_id` | First `Message-ID` header without angle brackets, case kept. A Gmail-added `...SMTPIN_ADDED_MISSING@mx.google.com` or `...SMTPIN_ADDED_BROKEN@mx.google.com` ID is stored as absent, because it differs per account |
| `dkim_bh_json` | Sorted unique `bh=` values of every `DKIM-Signature` below the bottom-most `X-Fumi-Ingest-ID` header (all of them when there is none), whitespace removed, at most 16 |
| `from_address` | First `From` address, lowercase |
| `to_json` | Sorted unique lowercase addresses of every `To` header, at most 100 |
| `subject` | Unfolded raw `Subject` with whitespace runs collapsed (encoded words are not decoded) |
| `header_date` | `Date` as an ISO time when it parses, otherwise its collapsed text |
| `group_id`, `group_rule` | The copy group (below) |
| `message_id_conflict` | 1 when an earlier signed original has the same Message-ID and no shared body hash or another From |

An original whose recorded SHA-256 no longer matches the R2 object's checksum and
`sha256` metadata is `blocked` with `source_changed`; a missing object is
`source_missing`; a header section that does not end within 64 KiB is
`header_limit`; input that does not start with a header is `invalid_header`. An
original that is only headers, without a blank line, is indexed when the read covered
the whole object.
Blocked rows have no group and stand alone in reads. `mime-v1` is unchanged, and
grouping does not wait for MIME extraction or depend on its 4 MiB input bound.

## Groups

Each original first gets its own group key, and the group ID is the SHA-256 of
`["identity-v2", ...key]` (the current `identity_version`):

| Rule | When | Own key | Joins an earlier row with |
| --- | --- | --- | --- |
| `message_id_dkim` | Message-ID, at least one body hash and From | Message-ID, smallest `bh`, From | Same Message-ID, equal From and at least one equal `bh` |
| `message_id_from_date` | Message-ID, no DKIM, From and Date present | Message-ID, From, Date | Same Message-ID, no DKIM, equal From and Date |
| `dkim_headers` | No Message-ID, a body hash, From and Date present | smallest `bh`, From, To, Subject, Date | No Message-ID, equal From, To, Subject and Date, and at least one equal `bh` |
| `single` | Anything else | the raw key | Nothing |

The insert finds the earliest matching row in the same statement and takes its group ID;
otherwise the row starts its own group. So an assignment never changes after it is
written, and concurrent runs cannot split a group. Matching is pairwise, not transitive:
a row that shares a body hash with two earlier rows of the same Message-ID that share
none (`[a]`, `[b]`, then `[a, b]`) joins the earlier one only, while the order `[a, b]`,
`[a]`, `[b]` puts all three in one group. Which originals end up together can then
depend on indexing order, which is newest catalog row first within each run. A row with
the same Message-ID as an earlier one, both signed, but no shared body hash or another
From does not match that row and has `message_id_conflict` set. It can still join that
row's group through a third row, as `[b]` does in the second order above, so the flag
does not mean the row stands alone. A signed and an unsigned copy with the same
Message-ID are not grouped, unless the unsigned one is a
[mailbox copy](#mailbox-copies). Signatures that
fumi's own forwarding route adds sit above `X-Fumi-Ingest-ID` and are ignored, so an
unsigned live capture still groups with its Gmail copy. A signature added by a hop
before fumi captured the mail (for example a Gmail account that forwards to fumi) is on
both the live capture and the Gmail copy fumi forwarded. Any other hop that signs only
one copy keeps the two results apart. Hops only add headers on top, so the bottom-most
`X-Fumi-Ingest-ID` is the same header in every copy, even when the original already
carried one. A header named `X-Fumi-Ingest-ID` inside the original mail therefore makes
every copy ignore the signatures above it, which an unsigned sender gets anyway.

### Mailbox copies

[ADR 0006](adr/0006-outlook-pst-import.md) adds one rule for originals read from a
mailbox rather than captured in transit: source kinds `gmail` (Takeout and API imports)
and `mailbox_export` ([Outlook PST import](outlook-pst-import.md)). Such a copy can lack
a signature that another copy of the same mail carries:

- Gmail stores the sender's copy of a sent mail (the `Sent` label) before it adds its
  outgoing `DKIM-Signature`, so the sender's account holds the mail unsigned while the
  copy a recipient received, in another imported account or as a live capture, is
  signed (owner, 2026-11-28 12:25 UTC, amendment to ADR 0006).
- A PST item is rebuilt from the mailbox, so it lacks any signature a later hop added,
  such as the forwarding route that brought the same mail to Gmail.

An unsigned mailbox copy (`message_id_from_date`) and a signed original
(`message_id_dkim`) with the same Message-ID, equal From and equal Date are one group:

- An unsigned mailbox copy first looks for its own rule's match. Without one, it joins
  the earliest signed row with that Message-ID, From and Date. Preferring the unsigned
  match keeps an unsigned live capture and its Gmail copy together when a signed copy
  was indexed before both.
- A signed row first looks for its own rule's match. Without one, and only when no
  signed row with that Message-ID exists yet, it joins the earliest unsigned mailbox
  copy with the same Message-ID, From and Date. So for one unsigned mailbox copy and
  one signed copy the result does not depend on which of the two is indexed first, and
  a later signed copy with another body hash (a conflict, possibly forged) cannot enter
  the group through the unsigned copy.

An unsigned live capture (`email_routing`) is not a mailbox copy: fumi captures it in
transit, and the signatures its forwarding route adds are already ignored (above). A
signed and an unsigned live capture stay apart, unless a mailbox copy links them: with
three copies of one Message-ID, From and Date (a signed one S, an unsigned live capture
U and an unsigned mailbox copy E), E joins U, and S joins them only when it is indexed
after E and no signed row of that Message-ID came before it. Rows are written once, so
an order that leaves S apart is not reconciled.

Group keys and the other rules are unchanged. Until 2026-11-28 the rule covered only
`mailbox_export`, and an unsigned mailbox export joined the earliest row of either rule.
Rows written under that rule keep their groups. The Gmail rows it left apart (below) are
not regrouped by this change alone, because rows are never rewritten; they need to be
indexed again.

With the 2026-11-28 data, ADR 0006 expects 2,636 of the 2,642 PST items fumi already
holds to group: 1,470 by the earlier rules and 1,166 by this one. On 2026-11-28 at 12:30
UTC production held 1,043 pairs of an unsigned and a signed original with the same
Message-ID, From and Date. 25 were in different groups, and in all 25 the unsigned
copy was a Gmail copy with the `Sent` Takeout label: 21 against a signed Gmail copy
(including the sender's own account when the mail was sent to itself) and 4 against a
signed live capture.

Equal From is an agent addition to the ADR's rule 1: Message-ID and `bh=` are copied
easily from a mail someone has seen, and DKIM is not verified here.

Header values are untrusted. Someone who has seen a message can send a new one to a
live address with the same Message-ID, From and `bh=`. It joins the group and, as a
live capture, becomes the representative, so default listings show its content in
place of the genuine copy. `expand_copies` always shows every original, and grouping
never affects routing, notifications, forwarding or sending.

## Reads

`search_emails`, `search_email_ids` and `read_email_thread` collapse in SQL after their
filters. Of the originals in one group that matched, one representative is returned:
live capture first, then Gmail copies by earliest provider receipt time, then
mailbox exports such as PST originals, then external ID. A PST
original's delivery time is earlier than any Gmail receipt, and its MIME is rebuilt, so
it is ranked by kind rather than by time. The earliest Gmail copy stands for the
account's own copy, because forwarding to another account happens after the first
account received it (the ADR says "the account's own Gmail"; earliest receipt time is
how the code decides it). A thread read always keeps the message it was asked for as its
group's representative. `search_mail_content` and `search_mail_semantic` do not pick a
representative: within a page or call they keep the first match of a group, in index or
score order, so their `mail_` ID can be another copy than `search_emails` shows. Each
result carries `group_id` (null for an original without a complete identity row for its
current SHA-256 and current `identity_version`, for one whose catalog `raw_state` is not
`present`, as for current extractions, or whose row is newer than the page snapshot) and
`copies`, the number of the group's originals that matched the same filters.
`expand_copies: true` returns every original with the same two fields.

Pages follow representatives. The page token holds snapshots of both `archive_sources`
and `mail_identity` rowids, and identity rows written after the first page are ignored
for the rest of the traversal, so new grouping never moves a representative between
pages. A change in which originals match the filters (for example an extraction
finishing, so a `from:` filter starts matching another copy) can still change a
representative and repeat or skip that group on a later page. So can a change in an
original's catalog `raw_state` or SHA-256 between pages, which the snapshots do not
cover: an original that a reconcile pass marks `missing` leaves its group, and one
restored to `present` (by an import replay, for example) rejoins it. A token from before
this change is rejected with `invalid_page_token`, and changing `expand_copies` between
pages is `page_query_mismatch`.

`search_mail_content` and `search_mail_semantic` add `group_id` to each match and,
within one page or call, drop a match whose group, part and text digest were already
shown. Later pages are not deduplicated. `coverage.duplicate_copies_omitted` counts
the dropped matches, and `expand_copies: true` keeps them.

### Page cost

Until 2026-11-23, every page of `search_emails` and `search_email_ids` collapsed all
originals that matched its filters up to the snapshot, then applied the cursor, so even
page 1 of an empty query read the whole archive. Each page now reads rows in proportion
to the page size:

1. A walk reads the next `4 × (max_results + 1)` matching originals after the token's
   position, newest first, through the `archive_sources_search_order` index on
   `(COALESCE(received_at,''), external_id)`, the page order. With `archive_source`
   `gmail`, `email_routing` or `mailbox_export`, it walks
   `archive_sources_search_kind_order` on
   `(source_kind, COALESCE(received_at,''), external_id)` within that kind instead.
   `after:`, `before:` and the token bound where the walk starts and stops in the index.
2. A collapse runs the same SQL as before over only the walked originals and every
   original whose `mail_identity` row has the `group_id` of a walked one, then keeps
   representatives no older than the last walked original.
3. When the walk filled its window but that yields `max_results` or fewer results, the
   walk repeats with `32 × (max_results + 1)` originals, and after that one statement
   collapses every matching original as before.

The pages are the same as collapsing everything: a representative after the token is
itself a matching original, so each one down to the last walked original was walked, and
its whole group (every original with that identity `group_id`, a superset of the
members whatever their identity version, status or snapshot) was collapsed with it. So
its representative and `copies` are the same. `test/search-page-cost.test.ts` compares
full traversals against the previous statement on random archives with groups across
page boundaries, Gmail labels, `archive_source`, `in:` and `expand_copies`.

Measured on 2026-11-23 at 02:00 UTC with the local D1 of the test runtime
(`meta.rows_read` summed over every statement of a page, 20 results per page), over
`archiveMessages(generator(1), n, …)` of `test/search-page-cost.test.ts` with 1,530 and
3,100 messages, about 15% of them in groups of two to four copies:

| Archive | Search | Page 1 before | Page 10 before | Page 1 after | Page 10 after |
| --- | --- | --- | --- | --- | --- |
| 1,996 originals | empty query | 24,374 | 23,896 | 1,757 | 1,720 |
| 1,996 originals | `from:alpha` | 11,856 | 11,359 | 2,076 | 2,144 |
| 1,996 originals | `in:inbox` | 17,457 | 17,018 | 2,251 | 2,065 |
| 1,996 originals | `archive_source: gmail` | 17,266 | 16,733 | 1,840 | 1,759 |
| 1,996 originals | `archive_source: email_routing` | 7,551 | 7,189 | 1,746 | 1,806 |
| 4,011 originals | empty query | 49,035 | 48,557 | 1,757 | 1,720 |
| 4,011 originals | `from:alpha` | 23,516 | 23,019 | 2,076 | 2,144 |
| 4,011 originals | `in:inbox` | 35,107 | 34,668 | 2,251 | 2,065 |
| 4,011 originals | `archive_source: gmail` | 34,245 | 33,712 | 1,840 | 1,759 |
| 4,011 originals | `archive_source: email_routing` | 15,659 | 15,297 | 1,746 | 1,806 |

The test asserts that pages 1 and 10 read exactly as many rows whether the older
archive below them holds 1,500 or 3,000 more messages, and that every page of an
`archive_source: email_routing` traversal reads as many rows whether a Gmail-only import
below the live captures holds 1,500 or 3,000 messages. Walked through the page-order
index alone, the last pages of that traversal read every older Gmail original (4,095
and 8,018 rows on the last page with 3,000 and 6,000 older messages, against 151 through
the kind index). Limits:

- A filter that matches few originals (a rare `from:` or `in:sent`) still walks every
  original between the token and enough matches, and the last page of a traversal walks
  every older original; no index covers extracted metadata or Gmail labels.
- A page whose walks reach mostly copies whose representative lies outside them (many
  copies per group spread over time) falls back to collapsing everything.
- The walk and the collapse are two statements, so a write that lands between them
  (an extraction finishing) can be seen by one and not the other, like a write between
  two pages.
- The walk names its index with `INDEXED BY`, and the search clauses on `source_kind`
  carry a unary `+`: otherwise SQLite reads every source of that kind through the
  primary key and sorts it.

Migration `0023` adds both indexes. It changes no table, so the running Worker reads the
same rows while the deploy job applies it, and its inserts maintain the indexes. The
owner approved both indexes and the `INDEXED BY` clauses on 2026-11-24.

`get_mail_health` reports `sections.copy_grouping` over the newest 1,000 catalog
rows. Its counts follow the rule collapsed reads use to group an original: a
`mail_identity` row of the current `identity_version` whose `raw_sha256` equals the
catalog's, on an original whose `raw_state` is `present`.

| Count | Originals in the window |
| --- | --- |
| `indexed` | With a `complete` row under that rule; these are the originals reads give a `group_id` |
| `blocked` | With a `blocked` row under that rule |
| `pending` | `present` with a SHA-256 and no row of the current `identity_version`, as the backfill selects them |
| `unknown` | Every other original, such as one that is not `present` or whose row was written for a different SHA-256 |
| `message_id_conflicts` | `indexed` originals with `message_id_conflict` set |
| `in_multi_copy_groups` | `indexed` originals whose group has another original under the same rule, inside or outside the window |

`indexed`, `blocked`, `pending` and `unknown` add up to the window's records. The
backfill does not select an original whose current-version row has another SHA-256 (a
scan recorded a replaced object), so such an original stays in `unknown` and stands
alone in reads. For `in_multi_copy_groups`, each group with an `indexed` original in the
window is searched once, in `mail_identity` insertion order, and the search stops at the
group's second original under the rule. Rows before it that do not count, such as older
originals that are no longer `present`, are read on the way, so a group costs at most
its size once, however many of its originals are in the window.

Until this change (2026-11-23 02:00 UTC), `indexed` and `in_multi_copy_groups` also
counted originals whose row was written for a replaced SHA-256, which reads never group,
and originals that were not `present`; `in_multi_copy_groups` counted every row with the
same `group_id`, whatever its version, and `pending` did not require a SHA-256.
`unknown` was added then. Requiring `present` matches collapsed reads, which require it
since [#173](https://github.com/risu729/fumi/pull/173) (2026-11-23 02:12 UTC).
The owner approved the `unknown` count and the narrower meanings on 2026-11-24.
