# ADR 0004: Gmail backfill from Google Takeout, and grouping copies of one message

Status: accepted by the owner on 2026-11-22 at 20:31 UTC ("yes work on it, you may
create a r2 bucket and upload the takeout from gdrive"). The Takeout transport is
implemented ([historical Gmail import](../gmail-import.md#google-takeout-transport));
no run has been configured, and copy grouping is not implemented. It
replaces the connector transport as the way to finish the historical Gmail backfill
in [historical Gmail import](../gmail-import.md) and
[connector import](../gmail-connector-import.md); both transports stay in the code
until this import is accepted.

Date: 2026-11-22

## Context

- The connector backfill reads one Gmail API `format=raw` message per call. It
  committed 4,810 messages with internal dates 2026-08-24T09:21:29Z to
  2026-11-11T16:59:42Z and stopped on 2026-11-12 around 04:13 UTC. The mailbox goes
  back to at least 2020, so the rest is likely tens of thousands of messages.

- On 2026-11-22 at 05:46 UTC the owner asked whether a Google export would work
  instead ("googleのエクスポートじゃダメなの？", "won't a Google export do?").

- Mail reaches several mailboxes. Other Gmail accounts forward to an address at
  `takuk.me` (for example `momonga.minecraft@gmail.com` to
  `momonga.minecraft.google@takuk.me`), which reached the main Gmail account, and
  since 2026-11-07T06:01:24Z fumi captures `takuk.me` mail directly. On 2026-11-22,
  276 Message-IDs existed both as live capture and as Gmail import, and none of the
  pairs had equal raw SHA-256, because every hop adds headers. The owner noted that
  limiting the import period alone does not remove these copies (16:46 UTC,
  "それだけだと解決しない", "that alone doesn't solve it").

- A Takeout of another account (379 messages, 2022-07 to 2026-11) showed this entry
  shape:

  ```text
  From 1837071459230217940@xxx Tue Jul 08 09:44:28 +0000 2025
  X-GM-THRID: 1837071459230217940
  X-Gmail-Labels: Archived,Unread
  <the message, CRLF line endings>
  <one extra CRLF>
  ```

  - The `From_` number is the Gmail message ID in decimal (`0x197e96c24a6cf6d4`); it
    differs from `X-GM-THRID` for the 37 messages in multi-message threads.
  - With the `From_` line, the two added headers and the extra CRLF removed, the DKIM
    body hash verified for all 378 signed messages.
  - The `From_` date matched the top `Received:` time within one second for 378 of 378.
  - No `>From` quoting appeared. Header bytes were not verified.
  - One 2026-06-20 message from that account is in the main account with the same
    Message-ID, so the forwarding hop keeps Message-ID.

## Options considered

1. Finish with the connector transport. Rejected: one tool call per message, and it
   ran only while an operator collector was attended.
2. Read-only OAuth with a cron driver. Rejected: it stores a long-lived Google
   refresh token that can read the whole mailbox in the Worker, and still needs one
   API call per message.
3. Google Takeout (accepted). One export per account, no Google credential in fumi.

## Decision

The owner accepted the proposal on 2026-11-22 at 20:31 UTC after these answers:
labels are imported (19:14 UTC, "あ、ならラベルも入れましょう", "then let's import
labels too"); target accounts are managed in
[risu729/techo](https://github.com/risu729/techo) (19:14 UTC,
"対象アカウントはtechoで管理してる"); Spam and Trash are imported (20:05 UTC,
"迷惑メールもごみ箱も取り込みでいい"). Sub-bullets marked "agent" were specified by
an agent and are not confirmed by the owner.

### Takeout import

1. **Takeout per account.** Each Gmail account is exported with Takeout (Mail, mbox)
   to Drive `archive/Google/<account>/<date>`, as techo's account-cleanup policy says.
   Each account is its own namespace; accounts are added whenever a Takeout lands.
2. **Separate private bucket.** The `.mbox` files are copied to the R2 bucket
   `fumi-takeout` (created 2026-11-22 20:32 UTC), never to the archive bucket.
   - Agent: the upload credential is an R2 token limited to that bucket, created
     through risu729/infra Terraform and deleted after acceptance. The Worker gets a
     read-only binding. No HTTP route, the reconciler or MIME extraction reads the
     bucket.
3. **New `takeout` transport.** A Workflow streams the mbox and feeds each entry to
   the existing archive path: 25 MiB bound, conditional R2 writes, atomic D1 commit,
   `notify_events=0`, no forwarding.
   - Agent: an entry boundary is accepted only at `CRLF CRLF From <decimal>@xxx
     <date> CRLF` followed by `X-GM-THRID:` and `X-Gmail-Labels:`; anything else
     stops the run with a fixed code. Ranged reads keep a carry-over buffer of at most
     one entry. Checkpoints are byte offsets advanced only after durable commits. A
     mbox split across Takeout parts is read as one ordered stream.
4. **Identity and provenance.** The fumi identity stays
   `SHA-256(["gmail-import-v1", namespace, messageId])`, so a message has one identity
   per account across transports.
   - Agent: a new receipt schema `gmail-takeout-v1` records namespace, message ID
     (hex), thread ID (hex of `X-GM-THRID`), Takeout object key, entry byte offset,
     entry SHA-256 and the `From_` date. `gmail_messages.internal_date` takes the
     `From_` date in milliseconds; the receipt marks it second-precision and
     Takeout-derived. The connector transport is retired for any namespace imported
     from Takeout.
5. **Labels.** Takeout label names (localized, may contain spaces) are kept in a new
   table, not in `label_ids_json`; the `label_ids` search filter stays API-ID only.
   Spam and Trash are imported like every other entry; nothing is skipped by label.
6. **Gate 1 before bulk import** (agent). A no-write dry run of the main account's
   Takeout compares the stripped entries with the stored `raw_sha256` of the 4,810
   connector imports. Bulk import proceeds only at full equality or with every
   difference explained and recorded. Running the bulk import still needs the owner's
   explicit go after Gate 1.
7. **Already-imported messages** (agent). For an existing message ID the importer
   compares SHA-256: equal is recorded as verified by Takeout; a difference is
   recorded, the original is kept, and the run stops for review.

### Grouping copies of one message

Originals are never merged or deleted; each route keeps its own source and provenance.

1. **Header-only identity index** (agent). A bounded job reads only each original's
   header block and writes one immutable `mail_identity` row: normalized Message-ID
   (Gmail-generated `...SMTPIN_ADDED_MISSING@mx.google.com` treated as absent), DKIM
   `bh=` values, From, To, Subject and Date. `mime-v1` is unchanged.
2. **Group key** (agent); the group ID is the SHA-256 of the key:
   1. same Message-ID and at least one equal DKIM `bh`;
   2. same Message-ID, no DKIM on either side, equal From and Date;
   3. no usable Message-ID: equal `bh`, From, To, Subject and Date.
   Same Message-ID with conflicting `bh` is not grouped, and the conflict is recorded.
3. **Reads** (agent). `search_emails` and thread reads collapse in SQL after filters,
   with one representative per group (live capture, then the account's own Gmail,
   then other Gmail), paginated by the representative and bounded by a snapshot of
   both tables. Results carry `copies`; `expand_copies: true` returns every original.
   Content and semantic search add `group_id` and drop same-group duplicates within a
   page only.

## Consequences

- No Google credential is stored in fumi. The upload token is temporary and limited to
  one bucket.
- Takeout files hold whole mailboxes; they are deleted after acceptance, and that
  retention decision is recorded in [historical Gmail import](../gmail-import.md).
- The `From_` date is second-precision, so `after:`/`before:` and ordering of Takeout
  sources use that precision.
- Headers used for grouping are untrusted. A forged Message-ID can at most hide a copy
  in default listings; `expand_copies` always shows every original, and grouping
  never affects routing, notifications or sending.
- The stalled connector run is marked superseded when the Takeout import starts.

## Verification

- Gate 1 result for the main account, recorded in
  [historical Gmail import](../gmail-import.md).
- Per account: Takeout entry count and min/max dates against archive rows of that
  namespace, with every rejected entry listed with a fixed reason.
- Grouping: the 276 live/Gmail Message-ID pairs of 2026-11-22 collapse to one result
  each by default and expand to two with `expand_copies`.
