# Cloudflare mail projects: adoption and reference options

Research snapshot: **2026-11-07**. This is a source review, not a deployment, security
audit, deliverability test, or benchmark. Capabilities below are supported by upstream
documentation or inspected code. "Not established" means the reviewed sources did not
establish that capability; it is not proof that no implementation exists elsewhere. No
upstream code has been incorporated into Fumi.

## Current mailbox-only recommendation

For popularity, recent development and frontend reuse, see the focused
[maintained-project comparison](web-client-options.md). The strongest additional
complete-mailbox candidate is **maillab/cloud-mail**, a different repository from
Yuyuyang/cloudmail below. For fumi's own frontend, prefer independent UI/editor
components around an API adapter; a complete Mailflare workspace is not selected.
Calendars, booking and drive features are outside the current product scope.

## Which project was "Mailflare"?

The closest match is **[hieunc229/mailflare](https://github.com/hieunc229/mailflare)**,
whose [official site](https://mailflare.co/) describes a self-hosted workspace with
email, calendar, booking, drive, and AI integrations. Two similarly named projects are
different:

- **[0xdps/emailflare](https://github.com/0xdps/emailflare)** is a transactional sending
  API plus a team inbox.
- **[Curetix/mailflare-extension](https://github.com/Curetix/mailflare-extension)** is a
  browser extension/PWA for managing Cloudflare Email Routing aliases. Its
  [README](https://github.com/Curetix/mailflare-extension/blob/b3420abf8c4f883670fa90e0f0373ca8b5a03e56/README.md)
  describes alias creation, editing, and search. It is not a stored mailbox or a Gmail
  replacement. Its older general statement that Email Routing cannot send should not be
  used to describe the separate, current Email Sending product.

## Platform baseline

Cloudflare currently distinguishes **Email Routing** for inbound processing/forwarding
from **Email Sending (Beta)** for outbound transactional mail. Arbitrary-recipient
sending requires Workers Paid; sending only to verified destination addresses has
different rules. Workers bindings, REST, and authenticated SMTP are available sending
interfaces. Project claims about "free mail" or old quotas should be checked against the
current [Email Service overview](https://developers.cloudflare.com/email-service/),
[pricing](https://developers.cloudflare.com/email-service/platform/pricing/), and
[limits](https://developers.cloudflare.com/email-service/platform/limits/) before
adoption. This research makes no account-specific eligibility or cost claim.

The current official limit is
**25 MiB total outgoing message size including attachments**, and **25 MiB inbound**.
Some reviewed project documents still refer to a 5 MiB sending limit, and cf-mail's
README describes inbound attachments as unlimited via R2. Those statements do not
override Cloudflare's current transport limit; an application may also enforce its own
smaller limit.

## Broader project map

| Project / owner                  | Primary purpose                                         | Cloudflare components established in source                                                       | External runtime dependencies / alternatives                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mailflare** — `hieunc229`      | Full personal/team workspace                            | Workers, D1, R2, Queues, Durable Objects; Workers AI available                                    | Default transport/storage can stay on Cloudflare. Optional Resend/SES, OpenAI-compatible AI, alternative databases and S3-compatible storage; Docker path also exists.          |
| **Agentic Inbox** — `cloudflare` | Mail client with built-in agent and MCP                 | Workers, Durable Objects with SQLite, R2, Email Routing/Sending, Workers AI, Access               | Cloudflare services cover the documented deployment; no external mailbox provider required.                                                                                     |
| **EmailFlare** — `0xdps`         | Transactional email API and separate team inbox/CRM     | Workers, D1, KV; inbox adds R2, Queues, Durable Objects                                           | Cloudflare-first Workers deployment; Docker variant uses embedded SQLite and lists Redis for the inbox.                                                                         |
| **cf-mail** — `Coldplay-now`     | Small personal mailbox plus agent REST/webhook protocol | Worker, D1, R2, Email Routing/Sending                                                             | No external mail provider in the documented core; optional browser push/APNs and webhook consumers.                                                                             |
| **Cloud Mail** — `Yuyuyang`      | Multi-user webmail with administration                  | Workers, D1, KV, R2; optional Turnstile                                                           | Resend is the documented outbound provider. Telegram/forwarding integrations are optional.                                                                                      |
| **Zero / Mail0** — `Mail-0`      | AI client for existing mail providers                   | Workers configuration includes Durable Objects, R2, Queues, KV, Hyperdrive, Workers AI, Vectorize | Existing Gmail/other provider accounts and OAuth remain part of its model; PostgreSQL is documented. This is not established as a standalone Email Routing mailbox replacement. |

### Mail operations

| Project       | Receive / send                                       | Attachments                                                                                                    | Search                                                                                     | Agent interface                                                                                             |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Mailflare     | Both; Cloudflare, Resend, or SES selected per domain | Both; storage-backed links for larger Cloudflare sends                                                         | SQLite/D1 FTS5; other database dialects use substring conditions                           | Built-in assistant and Streamable HTTP MCP; keys scope mailboxes/tools, send requests create a human review |
| Agentic Inbox | Both through Cloudflare                              | Both documented; R2 storage                                                                                    | Conversation/mail search                                                                   | Built-in agent and `/mcp`; shared Access policy authorizes all mailboxes                                    |
| EmailFlare    | Both; sending API and inbox are independent services | Incoming R2 storage confirmed; outbound inbox attachment support not established by the reviewed compose route | Contact name/address search confirmed; full mail-body search not established               | REST API; MCP not established in reviewed README/tree                                                       |
| cf-mail       | Both through Cloudflare                              | Both documented                                                                                                | SQL `LIKE` search                                                                          | Mailbox-scoped REST, acknowledgements, signed webhooks; MCP not documented                                  |
| Cloud Mail    | Inbound Worker; outbound Resend                      | Both, R2-backed                                                                                                | Sender/recipient/subject/name query conditions                                             | Open API; MCP not established in reviewed README/tree                                                       |
| Zero / Mail0  | Through connected provider drivers                   | UI and provider attachment handling present                                                                    | Mail search implementation and Vectorize bindings present; retrieval quality not evaluated | `ZeroMCP` tools include listing, querying, reading, composing and sending                                   |

These are different product shapes. An alias manager does not replace mail storage; a
provider client does not remove Gmail; a transactional API does not necessarily supply a
complete mailbox. Text search and an AI drafting assistant also do not establish a
complete migration or RAG pipeline.

## Maintenance and licensing snapshot

Dates below are the **latest default-branch commit timestamp**, in UTC, retrieved from
GitHub on the research date. They are not release dates or a judgment of project health.
All six repositories were unarchived when checked. Repository `pushed_at` can reflect
other branches, so it is not used as the maintenance date here.

| Repository                                                              | Latest reviewed default-branch commit                                                                              | Root license                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [hieunc229/mailflare](https://github.com/hieunc229/mailflare)           | [2026-11-06 16:30:19](https://github.com/hieunc229/mailflare/commit/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310)      | [AGPL-3.0](https://github.com/hieunc229/mailflare/blob/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310/LICENSE)                          |
| [cloudflare/agentic-inbox](https://github.com/cloudflare/agentic-inbox) | [2026-04-17 15:14:25](https://github.com/cloudflare/agentic-inbox/commit/48039bb6785af34e592c2966f87cde2b255c4c80) | [Apache-2.0](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/LICENSE)                   |
| [0xdps/emailflare](https://github.com/0xdps/emailflare)                 | [2026-11-01 18:33:47](https://github.com/0xdps/emailflare/commit/cf31f33bbb4a324d5353b8a5db0312fedc19618f)         | [MIT](https://github.com/0xdps/emailflare/blob/cf31f33bbb4a324d5353b8a5db0312fedc19618f/LICENSE)                                  |
| [Coldplay-now/cf-mail](https://github.com/Coldplay-now/cf-mail)         | [2026-06-16 04:29:58](https://github.com/Coldplay-now/cf-mail/commit/d802826faa0f3930ea708727be18d8a384a3fb01)     | [MIT](https://github.com/Coldplay-now/cf-mail/blob/d802826faa0f3930ea708727be18d8a384a3fb01/LICENSE)                              |
| [Yuyuyang/cloudmail](https://github.com/Yuyuyang/cloudmail)             | [2025-11-23 05:29:11](https://github.com/Yuyuyang/cloudmail/commit/9ec534530974a2afd67251d586110f83b2cffa5a)       | [MIT](https://github.com/Yuyuyang/cloudmail/blob/9ec534530974a2afd67251d586110f83b2cffa5a/LICENSE)                                |
| [Mail-0/Zero](https://github.com/Mail-0/Zero)                           | [2026-10-27 01:13:50](https://github.com/Mail-0/Zero/commit/36132735ca3b734b23f48127f9271c80d1ba76e7)              | [MIT at root](https://github.com/Mail-0/Zero/blob/36132735ca3b734b23f48127f9271c80d1ba76e7/LICENSE); see file-header caveat below |

Zero's reviewed
[MCP source header](https://github.com/Mail-0/Zero/blob/36132735ca3b734b23f48127f9271c80d1ba76e7/apps/server/src/routes/agent/mcp.ts#L1-L16)
contains Apache-2.0 wording and a separate-license sentence despite the root MIT
license. This review does not resolve that inconsistency. Check the exact files and
upstream clarification before copying code. Similarly, adopting or modifying Mailflare
needs an intentional decision about its AGPL license; it should not silently become
Fumi's code base.

## Implications for Fumi

**For the current mail-only scope, evaluate Cloud Mail for a complete application and
independent components for fumi's own UI.** The
[focused comparison](web-client-options.md) records exact stars, substantive development
and frontend coupling. Mailflare remains a useful React reference, but its extra
workspace features and application contracts make a whole-app adoption a separate
choice. Its FTS5 search does not establish semantic RAG or fumi-specific active-consumer
routing. Reusing only frontend files still requires checking their license and replacing
backend/auth contracts.

**Use Agentic Inbox as the closest Cloudflare-native architecture reference.** It
demonstrates mailbox Durable Objects, R2 attachments, an email agent, and MCP together.
Its documented production trust boundary is a shared Cloudflare Access policy: every
admitted user or MCP client can access all mailboxes. Per-mailbox storage isolation must
not be mistaken for per-mailbox authorization. It requires adaptation if Fumi needs
separate consumer permissions. The older default-branch commit also warrants checking
unresolved issues and current platform compatibility before adoption.

**Use cf-mail for the small ingestion/agent boundary design.** Its protocol separates
stored untrusted message content from agent decisions, provides scoped tokens and
acknowledgements, and uses signed webhook notifications with a pull fallback. Those
concepts match a focused event-processing service well. Its documented
single-user/global-token UI and lack of IMAP/POP mean it is a narrower product than
Mailflare. Source claims about production usage have not been independently tested here.

**Keep EmailFlare and Yuyuyang/cloudmail as secondary references.** EmailFlare is
particularly relevant for a transactional sending API, team contact workflows, and reply
correlation. Yuyuyang/cloudmail demonstrates multi-user administration, attachment
storage, query APIs, and a Vue frontend, with Resend as a concrete extra service.
Neither source review established the full classification, historical migration,
semantic retrieval, and active-consumer handoff workflow Fumi would need.

**Treat Zero as a provider-client and search reference.** Its provider integrations,
MCP, and cached/searchable mail are relevant if retaining Gmail is acceptable. Its
documented PostgreSQL/OAuth/provider dependencies make it a different adoption path from
moving custom-domain receipt directly into Cloudflare.

Retain fumi's focused ingestion/archive plan. Frontend reuse is a later choice and does
not block Gmail forwarding plus R2 capture. Reuse can mean consuming an API or learning
an architecture; it does not require copying an entire application. Validate a chosen UI
adapter with synthetic list/reader/composer flows, attachments and scoped access before
using real mail.

## Primary source map

Sources are pinned to the reviewed commit where practical, so later upstream changes do
not silently change the basis of this comparison.

- **Mailflare:**
  [README/import and architecture](https://github.com/hieunc229/mailflare/blob/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310/README.md),
  [provider matrix/attachments](https://github.com/hieunc229/mailflare/blob/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310/docs/providers.md),
  [assistant/MCP permissions and review](https://github.com/hieunc229/mailflare/blob/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310/docs/email-assistant-and-mcp.md),
  [search implementation](https://github.com/hieunc229/mailflare/blob/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310/src/lib/search/conditions.ts),
  [Worker bindings](https://github.com/hieunc229/mailflare/blob/d4dc8337c3f0f833f8eb7dfa9d8daa00d39ad310/wrangler.jsonc).
- **Agentic Inbox:**
  [README/features and shared Access boundary](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/README.md),
  [bindings](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/wrangler.jsonc),
  [MCP tools](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/mcp/index.ts),
  [attachment storage](https://github.com/cloudflare/agentic-inbox/blob/48039bb6785af34e592c2966f87cde2b255c4c80/workers/lib/attachments.ts).
- **EmailFlare:**
  [README/service boundaries and Docker dependencies](https://github.com/0xdps/emailflare/blob/cf31f33bbb4a324d5353b8a5db0312fedc19618f/README.md),
  [inbox bindings](https://github.com/0xdps/emailflare/blob/cf31f33bbb4a324d5353b8a5db0312fedc19618f/services/inbox-worker/wrangler.example.jsonc),
  [inbound attachments](https://github.com/0xdps/emailflare/blob/cf31f33bbb4a324d5353b8a5db0312fedc19618f/services/inbox-worker/src/email-handler.ts),
  [compose/reply correlation](https://github.com/0xdps/emailflare/blob/cf31f33bbb4a324d5353b8a5db0312fedc19618f/services/inbox-worker/src/routes/inbox/compose.ts),
  [contact search](https://github.com/0xdps/emailflare/blob/cf31f33bbb4a324d5353b8a5db0312fedc19618f/services/inbox-worker/src/routes/inbox/people.ts).
- **cf-mail:**
  [README/features, API, webhook protocol and limits](https://github.com/Coldplay-now/cf-mail/blob/d802826faa0f3930ea708727be18d8a384a3fb01/README.md),
  [Worker entry point](https://github.com/Coldplay-now/cf-mail/blob/d802826faa0f3930ea708727be18d8a384a3fb01/src/index.ts),
  [bindings](https://github.com/Coldplay-now/cf-mail/blob/d802826faa0f3930ea708727be18d8a384a3fb01/wrangler.jsonc).
- **Cloud Mail:**
  [English README](https://github.com/Yuyuyang/cloudmail/blob/9ec534530974a2afd67251d586110f83b2cffa5a/README-en.md),
  [Worker configuration](https://github.com/Yuyuyang/cloudmail/blob/9ec534530974a2afd67251d586110f83b2cffa5a/mail-worker/wrangler.toml),
  [receive handler](https://github.com/Yuyuyang/cloudmail/blob/9ec534530974a2afd67251d586110f83b2cffa5a/mail-worker/src/email/email.js),
  [query/send implementation](https://github.com/Yuyuyang/cloudmail/blob/9ec534530974a2afd67251d586110f83b2cffa5a/mail-worker/src/service/email-service.js).
- **Zero:**
  [README/provider and PostgreSQL setup](https://github.com/Mail-0/Zero/blob/36132735ca3b734b23f48127f9271c80d1ba76e7/README.md),
  [Cloudflare server bindings](https://github.com/Mail-0/Zero/blob/36132735ca3b734b23f48127f9271c80d1ba76e7/apps/server/wrangler.jsonc),
  [MCP tools and file license header](https://github.com/Mail-0/Zero/blob/36132735ca3b734b23f48127f9271c80d1ba76e7/apps/server/src/routes/agent/mcp.ts),
  [search store](https://github.com/Mail-0/Zero/blob/36132735ca3b734b23f48127f9271c80d1ba76e7/apps/server/src/lib/mail-search-store.ts).
