# Copies of one message

Status: implemented (the grouping half of
[ADR 0004](adr/0004-gmail-takeout-import-and-copy-grouping.md)). Production
acceptance is the 276 live/Gmail Message-ID pairs described in the ADR.

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
`identity_version`, newest catalog row first,
so new mail is grouped within one interval and the backlog drains behind it. For each
one it reads only the first 64 KiB of the original (the MIME header budget) with a
ranged R2 read and writes one row. Rows are never updated; a row of an older
`identity_version` is replaced by the backfill, and reads use only current rows. A read
that throws (an R2 outage) writes nothing for that original, which stays pending for a
later run without holding back the others; the run reports it as `deferred`.

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
written, and concurrent runs cannot split a group. Same Message-ID with conflicting body
hashes or another From is not grouped and sets `message_id_conflict` on the later row. A
signed and an unsigned copy with the same Message-ID are not grouped. Signatures that
fumi's own forwarding route adds sit above `X-Fumi-Ingest-ID` and are ignored, so an
unsigned live capture still groups with its Gmail copy. A signature added by a hop
before fumi captured the mail (for example a Gmail account that forwards to fumi) is on
both the live capture and the Gmail copy fumi forwarded. Any other hop that signs only
one copy keeps the two results apart. Hops only add headers on top, so the bottom-most
`X-Fumi-Ingest-ID` is the same header in every copy, even when the original already
carried one. A header named `X-Fumi-Ingest-ID` inside the original mail therefore makes
every copy ignore the signatures above it, which an unsigned sender gets anyway.

Equal From is an agent addition to the ADR's rule 1: Message-ID and `bh=` are copied
easily from a mail someone has seen, and DKIM is not verified here.

Header values are untrusted. Someone who has seen a message can send a new one to a
live address with the same Message-ID, From and `bh=`. It joins the group and, as a
live capture, becomes the representative, so default listings show its content in
place of the genuine copy. `expand_copies` always shows every original, and grouping
never affects routing, notifications, forwarding or sending.

## Reads

`search_emails`, `search_email_ids` and `read_email_thread` collapse in SQL after
their filters. Of the originals in one group that matched, one representative is
returned: live capture first, then Gmail copies by earliest provider receipt time,
then external ID. The earliest Gmail copy stands for the account's own copy, because
forwarding to another account happens after the first account received it (the ADR
says "the account's own Gmail"; earliest receipt time is how the code decides it). A
thread read always keeps the message it was asked for as its group's representative.
Each result carries `group_id` (null for an original without a complete identity row
for its current SHA-256, or whose row is newer than the page snapshot) and
`copies`, the number of the group's originals that matched the same filters.
`expand_copies: true` returns every original with the same two fields.

Pages follow representatives. The page token holds snapshots of both `archive_sources`
and `mail_identity` rowids, and identity rows written after the first page are ignored
for the rest of the traversal, so new grouping never moves a representative between
pages. A change in which originals match the filters (for example an extraction
finishing, so a `from:` filter starts matching another copy) can still change a
representative and repeat or skip that group on a later page. A token from before this
change is rejected with `invalid_page_token`, and changing `expand_copies` between pages
is `page_query_mismatch`.

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
   `(COALESCE(received_at,''), external_id)`, the page order. `after:`, `before:` and
   the token bound where the walk starts and stops in that index.
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

Measured with the local D1 of the test runtime (`meta.rows_read` summed over every
statement of a page, 20 results per page, about 15% of messages in groups of two to
four copies):

| Archive | Search | Page 1 before | Page 10 before | Page 1 after | Page 10 after |
| --- | --- | --- | --- | --- | --- |
| 1,990 originals | empty query | 24,374 | 23,908 | 1,713 | 1,757 |
| 1,990 originals | `from:alpha` | 11,719 | 11,229 | 2,227 | 2,201 |
| 1,990 originals | `in:inbox` | 17,334 | 16,891 | 2,057 | 2,046 |
| 1,990 originals | `archive_source: gmail` | 16,817 | 16,287 | 1,840 | 1,823 |
| 4,033 originals | empty query | 49,006 | 48,527 | 1,689 | 1,684 |
| 4,033 originals | `from:alpha` | 23,826 | 23,365 | 2,094 | 2,183 |
| 4,033 originals | `in:inbox` | 35,596 | 35,142 | 2,119 | 2,040 |
| 4,033 originals | `archive_source: gmail` | 33,635 | 33,099 | 1,799 | 1,866 |

The test asserts that pages 1 and 10 read exactly as many rows whether the older
archive below them holds 1,500 or 3,000 more messages. Limits:

- A filter that matches few originals (a rare `from:`) still walks every newer original
  until it finds enough matches; no index covers extracted metadata.
- A page whose walks reach mostly copies whose representative lies outside them (many
  copies per group spread over time) falls back to collapsing everything.
- The walk and the collapse are two statements, so a write that lands between them
  (an extraction finishing) can be seen by one and not the other, like a write between
  two pages.
- The walk names its index with `INDEXED BY`, and the search clauses on `source_kind`
  carry a unary `+`: otherwise SQLite reads every source of that kind through the
  primary key and sorts it.

Migration `0022` adds the index. It changes no table, so the running Worker reads the
same rows while the deploy job applies it, and its inserts maintain the index.

`get_mail_health` reports `sections.copy_grouping` over the newest 1,000 catalog
rows: indexed, blocked and pending originals, Message-ID conflicts and originals in a
group with more than one copy.
