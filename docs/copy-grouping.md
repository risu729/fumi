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
Message-ID are not grouped. Signatures that
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
for its current SHA-256 and current `identity_version`, for one whose catalog
`raw_state` is not `present`, as for current extractions, or whose row is newer than
the page snapshot) and
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

Every collapsed page scans all originals that match its filters and sorts them twice,
and the cursor applies after the collapse. That is bounded by the archive size, not by
the page size.

`get_mail_health` reports `sections.copy_grouping` over the newest 1,000 catalog
rows: indexed, blocked and pending originals, Message-ID conflicts and originals in a
group with more than one copy.
