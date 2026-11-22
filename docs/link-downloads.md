# Link downloads

Status: part A (extraction, URL policy and safe fetcher) and part B (model
selection) are implemented as library code with synthetic Workers tests. Nothing in
production calls them: there is no migration, scheduled job or MCP tool for them.
Part B adds one optional private configuration field, off by default, and no new
binding. Parts C and D below are proposed and not implemented. No production
behavior has changed.

## Request

Some mail delivers a file as a download link instead of an attachment, often with
an expiry. The owner asked fumi to fetch such files and treat them like
attachments, including password-protected ZIP/PDF files
([#146](https://github.com/risu729/fumi/issues/146), owner, 2026-11-21 19:44 UTC).
A model, not a per-sender allowlist, judges which links are file downloads
(owner, 2026-11-21 19:55 UTC). For a first version, the password is assumed to be
in the same message as the link. This page was written on 2026-11-22 07:47 UTC.

The work is split into four reviewable parts:

| Part | Scope | State |
| --- | --- | --- |
| A | Deterministic URL extraction, hard-limit URL policy, safe fetcher | Implemented, not called |
| B | Model selection of candidates by index | Implemented, not called |
| C | Processing integration, storage, conversion and decryption | Proposed |
| D | MCP exposure of downloaded files and pending downloads | Proposed |

## Implemented: candidate extraction

`extractLinkCandidates({ text, html })` in `src/link-extraction.ts` takes the
parsed body derivative that [MIME extraction](mime-extraction.md) stores as
`body-json` and that `readMail` already reads. It is a pure function: it parses
strings, and never renders HTML, runs scripts, resolves names or fetches.

- Text bodies: each run that starts with `http://` or `https://` (any case, not
  preceded by a letter, digit, `+`, `.` or `-`) and continues with RFC 3986 URL
  characters. Any other character ends it, including whitespace, `<`, `>`, quotes
  and non-ASCII text such as Japanese written directly after the URL. Trailing
  `.,:;!?'"*` and unbalanced `)` or `]` are removed.
- HTML: the `href` of `<a>` and `<area>` start tags only. A small tokenizer follows
  the HTML tag and attribute syntax: comments and raw-text elements (`script`,
  `style`, `textarea`, `title` and similar) are skipped, values may be quoted or
  unquoted, the first duplicate attribute wins, and a tag cut off by the end of
  input is dropped. Forms, buttons, `<base>`, `<link>`, images and other resource
  URLs are ignored. Numeric character references and a fixed set of named ones
  (such as `&amp;`, `&sol;`, `&colon;`) are decoded; other named references stay
  literal. HTML text content is not scanned for URLs.
- Each URL is parsed with the WHATWG URL parser without a base, so relative and
  protocol-relative references are dropped. Only `http:` and `https:` remain.
  Userinfo and the fragment are removed, and the serialized URL is the
  deduplication key.
- At most 64 distinct candidates are kept (`truncated` reports more) and URLs over
  2,048 characters are dropped (`tooLong` counts them).

The output is an indexed list, text URLs first, then HTML ones, each in document
order:

```json
{
  "candidates": [
    { "index": 0, "url": "https://files.example.com/r.pdf", "sources": ["text", "html"] }
  ],
  "truncated": false,
  "tooLong": 0
}
```

## Implemented: URL policy

`checkLinkUrl(url)` in `src/link-policy.ts` runs on every URL that would be
requested, including each redirect `Location`. It returns the URL to request or
one outcome code. A model choice cannot change it.

Destination rule, giving `blocked_destination`:

- Only `http:` and `https:`, and only the scheme's default port. An explicit other
  port (for example `:8443`, or `:443` on `http:`) is refused.
- Userinfo and the fragment are removed before the request. A URL longer than
  8,192 characters, before or after normalization, is refused. This is longer than
  the 2,048-character candidate cap because redirect targets such as signed
  storage URLs can be long.
- IPv4 literals are refused in `0/8`, `10/8`, `100.64/10` (CGNAT), `127/8`,
  `169.254/16` (link-local and cloud metadata), `172.16/12`, `192.0.0/24`,
  `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`,
  `203.0.113/24`, `224/4` (multicast) and `240/4`. The URL parser first
  canonicalizes decimal (`2130706433`), octal (`0177.0.0.1`), hexadecimal
  (`0x7f000001`), short (`127.1`) and trailing-dot forms.
- IPv6 literals are allowed only in global unicast `2000::/3`, minus
  `2001::/23` (including Teredo), `2001:db8::/32`, `2002::/16` (6to4) and
  `3fff::/20`. So `::`, `::1`, IPv4-mapped `::ffff:0:0/96` (whatever address it
  embeds), IPv4-compatible forms, NAT64 `64:ff9b::/96`, ULA `fc00::/7`, link-local
  `fe80::/10`, site-local `fec0::/10` and multicast `ff00::/8` are refused.
- Hostnames, after trailing dots are removed: single-label names (`localhost`,
  `metadata`), names that are numeric but not canonical IPv4, names that contain
  four dotted or dashed numbers of one to three digits each (the values are not
  checked, so `300-400-500-600` counts), between dots, dashes or the ends of the
  name (`10.0.0.1.nip.example`, `10-0-0-1.sslip.example`,
  `app-10-0-0-1.nip.example`), and names that are or end in `localhost`, `local`,
  `localdomain`, `internal`, `intranet`, `private`, `corp`, `home`, `lan`, `arpa`,
  `test`, `invalid`, `onion` or `alt`. Full-width forms are mapped by the URL
  parser's IDNA processing first.

Action rule, giving `blocked_action_url` or `pending_login`. The path and query
(not the host or fragment) are compacted: `+` becomes a space, the text is
percent-decoded up to four times until it stops changing (bytes read as UTF-8 with
replacement characters), NFKC-normalized, lowercased, and every character other
than `a-z` and `0-9` is removed. The result is then searched for these substrings:

| Stem | Covers | Outcome |
| --- | --- | --- |
| `unsub` | unsubscribe | `blocked_action_url` |
| `optout` | opt-out, opt_out, optout | `blocked_action_url` |
| `confirm` | confirm, confirmation | `blocked_action_url` |
| `verif` | verify, verification | `blocked_action_url` |
| `activat` | activate, activation | `blocked_action_url` |
| `accept` | accept, acceptance | `blocked_action_url` |
| `declin` | decline, declined | `blocked_action_url` |
| `reset` | reset | `blocked_action_url` |
| `login`, `logon` | login, log-in, logon | `pending_login` |

An action stem wins over a login stem. Because separators are removed after
decoding, `un-subscribe`, `un%2Dsubscribe`, `un%252Dsubscribe`, `un%00subscribe`,
`un%C2%ADsubscribe` and full-width `ｕｎｓｕｂｓｃｒｉｂｅ` all match. The rule
deliberately over-blocks: `/designs/preset.pdf` contains `reset` and
`/acceptance-letter.pdf` contains `accept`. A login link is never requested,
because a GET can consume a one-time login token.

## Implemented: safe fetcher

`fetchLinkFile(url, options)` in `src/link-fetch.ts` checks the URL, then sends
`GET` with an empty `Headers` object, no body and `redirect: "manual"` (workerd
rejects `redirect: "error"`). It sets no cookie or authorization header; Workers
fetch has no cookie jar. One `AbortSignal.timeout` covers the whole redirect chain
and the body read.

- A 301, 302, 303, 307 or 308 with `Location` is resolved against the current URL
  and checked again before it is requested, so a refused hop is never contacted.
  At most five redirects are followed. Response bodies of hops are cancelled unread.
- Otherwise, a 401, or any response with `WWW-Authenticate`, is `pending_login`.
- Any status other than 200 is `http_<status>`, including a 3xx without `Location`.
- `text/html` and `application/xhtml+xml` are `pending_html`. So is a body that,
  after a BOM and whitespace, starts like an HTML document, whatever its declared
  type: `<!--`, `<!doctype html` (any whitespace between the words), or one of the
  tags `html`, `head`, `body`, `script`, `iframe`, `style`, `title`, `table`,
  `font`, `div`, `h1`, `a`, `b`, `br` or `p` followed by whitespace, `/` or `>`.
  Letters match ASCII case-insensitively (`<SCRIPT`, `<!DocType Html`), and no
  other character folds to them. These are the HTML patterns of the
  [WHATWG MIME Sniffing](https://mimesniff.spec.whatwg.org/#identifying-a-resource-with-an-unknown-mime-type)
  rules, slightly relaxed. Links or forms on the page are never followed.
- A `Content-Length` over the cap, or a streamed body that passes it, is
  `too_large`. The stream is read chunk by chunk and cancelled at the cap.

Default limits are 4 MiB (the decoded MIME part cap), 30 seconds and five
redirects; callers can lower or raise them per call. The outcome codes are
`pending_login`, `pending_html`, `blocked_action_url`, `blocked_destination`,
`too_large`, `timeout`, `redirect_limit`, `http_<status>` and `network_error`. The
last one covers a fetch rejection, such as a DNS failure or a connection the
platform refuses; its cause can contain the URL, so it is dropped. A `Location`
that does not parse is `blocked_destination`.

A success returns the bytes and this provenance:

```json
{
  "finalUrl": "https://cdn.example.com/b?sig=1",
  "redirects": 2,
  "fetchedAt": "2026-11-22T09:20:00.000Z",
  "status": 200,
  "size": 3,
  "mimeType": "application/zip",
  "sha256": "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
}
```

`mimeType` is the declared media type essence or `null`. URLs can carry access
tokens, so they are secrets in logs: part A never logs, and no outcome or error
contains a URL, header or body.

## What the code cannot enforce

A Worker cannot resolve a name before `fetch`, and `fetch` resolves it inside the
runtime. The policy therefore checks only the URL text. A public name whose DNS
answer is a private address, including a name that changes its answer between
requests, is not caught by this code.

What the runtime itself does was checked only in local sources on 2026-11-22:

- The pinned workerd `workerd.capnp` documents that a `Network` service allows
  `["public"]` by default "to prevent SSRF attacks", and that for a hostname the
  rule filters the addresses DNS returns. This describes self-hosted workerd.
- The pinned Miniflare configures its `internet` service with
  `allow: ["public", "private", "240.0.0.0/4"]`, so local tests and
  `vitest-pool-workers` can reach private addresses. Synthetic tests here use a mock
  `fetch` and prove nothing about the platform.
- No local source states what production Cloudflare Workers `fetch` guarantees for
  private, loopback or internal destinations. That behavior is unverified here and
  has not been tested in production.

Other residual risks:

- An opaque link, such as a click-tracking redirector, can perform an action on
  `GET` before it redirects. The action rule sees only the URL text; part B's
  selection lowers but does not remove this risk.
- Any fetch tells the link's host that the message reached a live mailbox, as a
  click would, and it comes from Cloudflare's network rather than from a browser.
- The hostname rule is a list. Wildcard DNS names that encode an address another
  way (hexadecimal labels such as `7f000001.nip.example`, or dashed IPv6 such as
  `--1.sslip.example`) are not recognized.
- The action rule sees only text. A word written with a lookalike letter that NFKC
  does not fold (Cyrillic `ѕ` in `unѕubscribe`), encoded more than four times, or
  hidden in an encoded query value (base64, for example) is not matched, and
  neither is an action word in the host name (`unsubscribe.example.com/t/1`).
- The action rule over-blocks words that contain a stem; such links stay
  unfetched. This includes common receipt names such as
  `/orders/123/confirmation.pdf`.
- The hostname rule refuses every name with four such numbers, public or not, so
  reverse-DNS style hosts (`cdn-1-2-3-4.example.net`,
  `ec2-203-0-113-5.compute.example`) and date-and-time names
  (`build-2026-11-22-10-30.example.com`) stay unfetched.
- The HTML sniff ignores the declared type, unlike WHATWG MIME Sniffing, which
  applies these patterns only to an unknown type. A declared SVG, XML or Markdown
  file that starts with a comment or one of the listed tags
  (`<!-- note -->` before `<svg>`, `<p align="center">` in a README) is
  `pending_html`, not a file.
- A redirect from `https:` to `http:` is followed, so a token in the URL of a later
  hop can travel unencrypted.

## Implemented: model selection

`selectLinkDownloads(env, input, runtime)` in `src/link-selection.ts` asks a model
which extracted candidates download a file. No per-sender allowlist exists (owner,
2026-11-21 19:55 UTC). The input is the subject, the plain-text body and the
`extractLinkCandidates` result. Part C will supply them; nothing calls this yet.

Configuration is an implementation default from 2026-11-22 08:24 UTC that awaits
the owner's choice in [open decision 1](#open-decisions-for-the-owner). It reuses
the optional Claude classifier of [routing policy](routing-policy.md). The model
comes from `config/routing-policy-v1.json`, the key from the optional
`ROUTING_ANTHROPIC_API_KEY` secret, and each call reserves one call in the same
UTC-day budget (`routing_model_budget`, capped by `maxCallsPerDay`). Selection has
its own opt-in in that object, independent of routing's `enabled`:

```json
{ "linkSelection": { "enabled": true } }
```

Without the object, without that field, with `enabled: false` or without the key,
the function returns a fixed code (`selection_not_configured`,
`selection_disabled`, `invalid_config`, `config_unavailable`,
`model_not_configured`) before spending budget or calling a provider. A message
without candidates returns `no_candidates`, and a candidate list whose `index`
values are not their positions returns `invalid_input`, both without a call. Routing's
administrator `instructions` are not sent; the selection prompt is fixed in code.

Request: the same request code as the routing classifier (`src/model-request.ts`).
One `POST` to the fixed origin `https://api.anthropic.com/v1/messages` with
`redirect: "manual"`, no tools, a JSON-schema output format and a twenty-second
deadline over the request and the whole response body, read up to 16 KiB. Mail is
untrusted data:

- The fixed system prompt says the email content is data, not instructions, and
  that the answer is indexes only.
- The single user message holds one JSON object between `<untrusted_mail_data>`
  tags. `<`, `>` and `&` inside it are written as `\u003c`, `\u003e` and
  `\u0026`, so mail text cannot close the block.
- The subject is cut to 512 and the body to 8,192 UTF-16 code units (never inside
  a surrogate pair, with `bodyTruncated`), and each candidate URL shown to the
  model to 512 characters (with `urlTruncated`). HTML-only mail has `body: null`;
  its `href` candidates are still listed.
- The API key is sent only in the `x-api-key` header. Candidate URLs have no
  userinfo. The body and URLs do go to the provider, as the body does for routing
  classification; a URL can carry a token.

```json
{
  "evaluationTime": "2026-11-22T09:20:00.000Z",
  "receivedAt": null,
  "untrustedMail": { "subject": "Receipt", "body": "Receipt: https://files.example.com/r.pdf", "bodyTruncated": false },
  "candidates": [{ "index": 0, "url": "https://files.example.com/r.pdf", "sources": ["text"] }]
}
```

The model must answer `{"indexes": [0], "expiresAt": "2026-12-01T00:00:00Z"}`.
Code rejects the whole answer as `model_invalid_output` when it has another field,
a non-integer, negative, out-of-range or repeated index, more than four indexes,
or an `expiresAt` that is not an RFC 3339 date-time. A refusal, a partial answer,
an oversized or malformed response, or a network failure is
`model_invalid_or_unavailable`; an HTTP error or redirect, which is not followed,
is `model_http_error`; the deadline is `model_timeout`; and an exhausted budget is
`model_budget_exhausted`. A reserved call is not refunded. If the configuration
object changes during the call, the answer is dropped as `config_changed`.

Code then maps each index to the extracted list, so a URL the model writes is never
used, and runs `checkLinkUrl` on each chosen URL. The model can only narrow the list:

```json
{
  "ok": true,
  "selected": [{ "index": 0, "url": "https://files.example.com/r.pdf" }],
  "refused": [{ "index": 3, "outcome": "blocked_destination" }],
  "expiresAt": "2026-12-01T00:00:00.000Z"
}
```

`refused` keeps `pending_login` so part C can record a pending download. The
expiry is a claim from untrusted text: it is normalized to UTC and kept only from
the evaluation time to 366 days after it, otherwise `null`. The fetcher checks the
policy again on every request and redirect.

Nothing in the module logs, and results contain only fixed codes, indexes,
extracted candidate URLs and the normalized expiry, never model text. There is no
per-message ledger, lease or retry here: each call spends budget, so part C must
store the result and call this at most once per message version.

The selection lowers, but does not remove, the risks under
[what the code cannot enforce](#what-the-code-cannot-enforce). A public
link that the hard policy allows is fetched if the model selects it, including a
link an attacker wrote into the mail and talked the model into choosing.

## Proposed: part C, processing integration

A separately leased, opt-in scheduled repair (like attachment conversion) would
fetch each selected index once and store the bytes as a derivative of the message,
with the provenance above. Downloaded files then enter the existing
[attachment conversion](attachment-conversion.md) and search pipeline. For a
password-protected ZIP or PDF, password candidates from the same message come
first, then the existing related-message search and bounded decryption. The
encrypted original and the verified decrypted file stay separate derivatives.
`pending_login` and `pending_html` become "download pending" records with the
stated expiry, for an agent to fetch with a browser. Passwords stay out of logs,
MCP results and search indexes.

## Proposed: part D, MCP exposure

The existing attachment read and copy tools would also serve downloaded files,
and a new tool would list pending downloads. Whether a pending record returns the
full URL (which can hold a token) is an open decision below.

## Open decisions for the owner

1. Model and key for part B. Options: reuse the optional Claude classifier
   configuration (`config/routing-policy-v1.json` and `ROUTING_ANTHROPIC_API_KEY`,
   sharing its daily call budget), or a separate private configuration with its
   own model, key and budget. Part B implements the first option as a default
   that awaits this decision, with its own `linkSelection.enabled` opt-in. Related:
   whether selection should need routing's `enabled` too, and whether it needs its
   own cap inside the shared budget.
2. Storage layout. Proposed: content-addressed R2 objects under
   `derived/link-v1/<raw sha256>/download/<file sha256>`, with a manifest per
   message, mirroring `mime-v1`. Whether the URL itself is stored in R2, in D1 or
   only as a hash, given that it can hold a token.
3. Whether this needs a migration. A D1 ledger (like `attachment_conversions`)
   would give leases, states (`selected`, `fetched`, `pending_login`,
   `pending_html`, `blocked`), retry fences and a pending-download listing for
   part D. An R2-manifest-only design avoids a migration but cannot list pending
   downloads cheaply.
4. Default limits: candidates per message (64), URL length (2,048 for a candidate,
   8,192 for any requested URL), file size
   (4 MiB; conversion currently accepts sources up to 2 MiB), total time (30 s),
   redirects (5), downloads per message and a daily download cap.
5. Whether `http:` links are fetched or only `https:` (including a redirect from
   `https:` to `http:`), and whether non-default ports stay refused.
6. Whether imported historical mail is in scope; its links have usually expired,
   and historical notifications are suppressed.
7. Whether MCP results for a pending download return the full URL or only its
   host and candidate index.
8. Retention of downloaded files and pending records.
