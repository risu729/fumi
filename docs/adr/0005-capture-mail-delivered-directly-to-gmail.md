# ADR 0005: Capture mail delivered directly to Gmail through Gmail forwarding

Status: accepted by the owner on 2026-11-22 at 21:29 UTC
("ではそれでいいと思う。issueに設計かいて作っておいて", "then that's fine, write the
design in an issue"). The design is [#161](https://github.com/risu729/fumi/issues/161).
Implemented; the owner asked for the implementation on 2026-11-22 at 23:29 UTC
("161やって", "do 161"). See [mail delivered directly to Gmail](../gmail-relay.md) for
the behavior and the operator steps. Gmail forwarding has not been turned on, so
production acceptance is pending.

Date: 2026-11-22

## Context

- Email Routing delivers to fumi, which archives the original and forwards it to the
  owner's Gmail account with an `X-Fumi-Ingest-ID` header.
- Mail that reaches the Gmail account directly never passes through fumi: mail sent to
  the Gmail address itself, and providers or other accounts that forward straight to
  Gmail. Only a backfill ([ADR 0004](0004-gmail-takeout-import-and-copy-grouping.md))
  brought it into fumi, so a backfill was needed again and again. A Gmail search on
  2026-11-22 suggested a few such messages a day.
- Gmail auto-forwarding was off on purpose: turned on as it was, it would send every
  Email Routing message back to fumi.
- The owner asked to forward only the mail that did not come through Email Routing,
  and to make fumi drop the rest (2026-11-22 21:22 UTC).
- The roadmap's target state said that "other ongoing Gmail synchronization" was out of
  scope.

## Decision

1. Gmail forwards every incoming message ("Forward a copy of incoming mail", keeping
   Gmail's copy, no filter) to an address whose Email Routing rule reaches fumi.
2. fumi recognizes such a delivery by its envelope sender
   `<user>+caf_=<destination with @ replaced by =>@gmail.com`, where `<user>` is the
   account of `FORWARD_TO`, and never forwards it back to Gmail.
3. fumi drops a delivery that copies mail it already holds: any `X-Fumi-Ingest-ID`
   value names a stored live ingest whose Message-ID equals this message's Message-ID.
   Both must match because the header is not signed. Anything else is archived (fail
   open).
4. The rest is new live mail: notifications and routing apply, and its provenance
   shows that it came through Gmail forwarding.
5. Health reports relayed deliveries received, archived and dropped.
6. Capturing mail delivered directly to Gmail through Gmail forwarding is in scope. This
   amends the roadmap's target state (owner, 2026-11-22 21:29 UTC).

Agent choices in the implementation, not confirmed by the owner:

- A relayed delivery stays an `email_routing` source in `ingress-v1`, because it is an
  Email Routing delivery and every routing, notification and policy query selects that
  kind. Receipt v4 (`forward: {status: "skipped", reason: "gmail_relay"}`) and the raw
  object's `via: gmail_forwarding` metadata carry the provenance instead of a new
  `source_kind`, which would have needed a rebuild of `archive_sources`.
- A dropped copy is a row in a new D1 table, `gmail_relay_deliveries`, not an R2
  receipt: a receipt without an original would count as an archive gap. When that row
  cannot be written, the copy is archived, so every relayed delivery is either stored
  or recorded.
- A relayed delivery has no default reply sender: its envelope recipient is fumi's
  forwarding address, not the address the mail was sent to.
- The optional SPF check of the issue is not implemented. A forged envelope sender
  only keeps that sender's own message out of Gmail, and a forged header pair only
  keeps it out of fumi.

## Consequences

- Mail sent to the Gmail address reaches fumi a moment after Gmail receives it, and
  enters routing like any live mail. Every Email Routing message passes through the
  Worker twice; the second pass stores nothing.
- Gmail does not forward spam or mail the account itself sends; SENT capture stays a
  separate roadmap item. Only mail that arrives after forwarding is turned on is
  forwarded. Email Routing accepts at most 25 MiB, so larger mail Gmail accepts cannot
  be relayed.
- Recognition reads `FORWARD_TO`. Retiring Gmail forwarding (phase 2D) removes that
  setting, so relay recognition then needs its own setting for the Gmail account.
  After phase 2D Gmail receives only direct mail and step 3 finds nothing to drop.

## Alternatives

- A Gmail filter that forwards only mail not delivered by Email Routing: Gmail search
  cannot match arbitrary headers such as `X-Fumi-Ingest-ID` or `Return-Path`, and
  recipient filters (`-to:<own domain>`) misjudge mailing lists, BCC and mail
  forwarded by other accounts.
- Excluding everything that "came through Cloudflare": mail that Cloudflare routes
  elsewhere has no `X-Fumi-Ingest-ID` and would be lost. The criterion is "already in
  fumi".
- Repeating the Takeout backfill: it keeps fumi behind Gmail between runs.
