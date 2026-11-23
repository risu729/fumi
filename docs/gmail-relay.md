# Mail delivered directly to Gmail

Status: implemented for [#161](https://github.com/risu729/fumi/issues/161), decided in
[ADR 0005](adr/0005-capture-mail-delivered-directly-to-gmail.md). The owner turned on
Gmail forwarding on 2026-11-23, and production acceptance passed at 02:15 UTC:

- (a) A message from another account to the Gmail address was stored once in fumi with
  `via: gmail_forwarding` and stayed once in Gmail.
- (b) A message to an Email Routing address reached Gmail once; fumi stored one
  original (without `via`) and health counted one `duplicate_of_live` relay.

`get_mail_health` showed `gmail_relay` with two received, one archived and one
`duplicate_of_live`. The Gmail confirmation message was archived and forwarded as
ordinary mail.

Mail sent to the Gmail address itself, or forwarded straight to Gmail by another
provider, never passes through Email Routing. Gmail's own "Forward a copy of incoming
mail" sends it to fumi. Gmail forwards everything it receives, including the copies
fumi itself forwarded to Gmail, so fumi drops the copies it already holds.

## Recognizing a relayed delivery

Gmail forwards with the SMTP envelope sender
`<user>+caf_=<destination with @ replaced by =>@gmail.com`, for example
`owner+caf_=relay=example.com@gmail.com`. A delivery is a relay when its envelope
sender has that form, on `gmail.com` or `googlemail.com`, and `<user>` is the Gmail
account of `FORWARD_TO`. Case, dots and a `+tag` in either local part are ignored, as
Gmail ignores them. Without `FORWARD_TO` (archive-only mode) nothing is a relay. The
envelope is not authenticated: a forged one only makes fumi archive that sender's
message without forwarding it to Gmail.

A relayed delivery is never forwarded back to Gmail, so Gmail keeps exactly one copy.

## Dropping copies fumi already holds

The whole delivery is read before anything is stored. Its first 64 KiB of headers give
the Message-ID and every `X-Fumi-Ingest-ID` value (at most four distinct UUIDs are
checked; other values are ignored). Cloudflare adds `X-Fumi-Ingest-ID` when fumi
forwards to Gmail, and Gmail keeps it. The copy is dropped when one of those IDs names
a stored live ingest whose Message-ID is the same:

1. The catalog row of that ingest (`email_routing`, `ingress-v1`) with `raw_state`
   present. With a complete [identity row](copy-grouping.md#identity-index) for the
   current original, its Message-ID decides without reading R2.
2. Otherwise the original's first 64 KiB, read with one ranged R2 read. Without a
   catalog row yet (the Gmail round trip can beat the first delivery's indexing), the
   original is looked up at `ingest/<date>/<id>/raw.eml` for the relay's UTC date and
   the previous date. Its metadata must carry the same ingest ID and no Gmail import
   `sourceKind`.

IDs are checked in header order; Cloudflare's header is expected above any
`X-Fumi-Ingest-ID` the original itself carried. The header is not DKIM-signed, so the
Message-ID must match too. A copy without a usable Message-ID, a copy whose original had
no Message-ID (Gmail adds one), an unknown or mismatched ID, a lookup error and a lookup
slower than five seconds all archive the copy (fail open: no mail is lost). A catalog
row whose `raw_state` is `missing` or `invalid` archives the copy too, without reading
R2, because the copy may be the only one left.
[Copy grouping](copy-grouping.md) links a duplicate that slips through.

A dropped copy stores no R2 object. It keeps one `gmail_relay_deliveries` row with the
outcome `duplicate_of_live` and the raw key of the original. When that row cannot be
written, the copy is archived instead, so every relayed delivery is stored or recorded.

## Archived relays

Everything else is stored as live mail:

- Receipt v4, with the same fields as v1 and
  `"forward": {"status": "skipped", "reason": "gmail_relay"}`. The raw object's
  metadata adds `via: gmail_forwarding`. The catalog row is an `email_routing` source
  with `forward_status = 'skipped'`. A Worker version without v4 support reports the
  receipt as `unsupported_receipt` and leaves the row without its snapshot until a
  v4-capable version rescans it.
- Notifications and routing apply as for any live mail (`notify_events = 1` in
  forwarding mode; in archive-only mode a stored v4 receipt releases them as a v2 one
  does). Routing reads `to` from the extracted `To` header, so rules keep working. The
  `envelope` input of a granted plugin is Gmail's forwarding envelope, not the
  original sender's.
- `read_email`, `search_emails` and thread reads show
  `"provenance": {"source_kind": "email_routing", "source_namespace": "ingress-v1",
  "via": "gmail_forwarding"}`. The value comes from the receipt snapshot, so a row
  without one shows no `via`.
- A reply has no default sender, because the envelope recipient is fumi's forwarding
  address: `from_address` is required (`reply_sender_unavailable` otherwise).
- When the original cannot be captured or stored, forwarding mode throws after the
  receipt is written, as for a failed forward whose original was not stored (except
  `invalid_size` and `oversize`, which fail the same way on every retry), so Email
  Routing reports a failure to Gmail; whether Gmail retries is not established.
  Archive-only mode rejects it permanently, and repeated bounces may make Gmail warn
  about or turn off forwarding. Gmail keeps its copy either way.
- The `ingest` log line adds `"relay": "gmail"`. A dropped copy logs
  `"archive": "duplicate_of_live"`.

Each archived relay, and each relay whose capture failed, also adds a best-effort
`gmail_relay_deliveries` row (`archived` or `archive_failed`).

## Health

`get_mail_health` adds `sections.gmail_relay` over the latest 1,000
`gmail_relay_deliveries` rows: `received`, `archived`, `archive_failed` and
`duplicate_of_live`. The catalog section counts v4 snapshots as
`receipt_gmail_relay`; they also count in `receipt_forward_skipped`. Each retry of a
relay that failed to store is a new delivery with its own ingest ID, so
`archive_failed` counts attempts, not messages. The rows are
observations for health, not archive evidence, and are not rebuilt from R2.

## Operator steps

1. Pick an address whose Email Routing rule points to fumi, in forwarding mode with
   `FORWARD_TO` set to the Gmail account.
2. In Gmail Settings, Forwarding and POP/IMAP, add the address. Gmail sends a
   confirmation message there from `forwarding-noreply@google.com`. It is not a relay,
   so fumi archives it and forwards it to Gmail as usual, where the confirmation link
   can be opened.
3. Turn on "Forward a copy of incoming mail to" the address and keep Gmail's copy in
   the inbox. Do not use a filter.
4. Acceptance: (a) mail from another account to the Gmail address lands in fumi once
   (with `via: gmail_forwarding`) and in Gmail once; (b) mail to an Email Routing
   address lands in Gmail once, and fumi has one stored original plus one
   `duplicate_of_live` row naming it.

## Limits

- Gmail does not forward spam or mail the account itself sends. SENT capture stays a
  separate [roadmap](roadmap.md) item.
- Only mail that arrives after forwarding is turned on is forwarded. Earlier mail is
  the [Takeout backfill](gmail-import.md)'s job.
- Email Routing accepts at most 25 MiB, while Gmail accepts larger messages; those
  cannot be relayed.
- Every Email Routing message passes through the Worker twice (the second pass is
  dropped).
- Retiring Gmail forwarding removes `FORWARD_TO`; relay recognition then needs its own
  setting for the Gmail account.
- Recognizing the envelope sender is the only thing that keeps a relay from being
  forwarded back. A Worker version without it forwards every relay to Gmail, which
  forwards it to fumi again with one more `X-Fumi-Ingest-ID`, until a hop limit stops
  the loop. Turn Gmail forwarding off before rolling back below this version.
- Mail that other Gmail accounts forward to an Email Routing address also has a
  `+caf_=` envelope sender, of another account. It is not a relay and is forwarded to
  `FORWARD_TO` as usual.
