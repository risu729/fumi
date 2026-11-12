# fumi

A Cloudflare Workers email archive and routing service. The name comes
from _fumi_ (a letter or written message).

**Status: capture, MIME extraction, agent mail API and historical import implemented.**
The Email Worker preserves Gmail forwarding, archives original MIME bytes and private
receipts in R2, and records archive and forwarding outcomes independently. Runtime tests
use synthetic mail. A D1 catalog and bounded scheduled reconciler index existing R2
evidence separately from delivery. Cloudflare Workflows now adds immediate catalog
registration, durable processing state and missing-start repair. Production activation
and synthetic forwarding/archive/Workflow acceptance were verified on 2026-11-10.
Bounded MIME extraction is implemented and active: selected headers in D1, body and
decoded attachments in private R2, with source hashes and explicit coverage failures.
Production byte-level acceptance passed on 2026-11-11; see
[MIME extraction](docs/mime-extraction.md) for limits and rollout. See
[processing Workflows](docs/processing-workflows.md) and
[catalog recovery](docs/archive-catalog.md) for identity, failures and rollout.
Agent-facing read/search/draft/send MCP, durable sending records, provider delivery
event ingestion and signed MCP Events are implemented with synthetic tests.
Authenticated MCP reads, sending/replies and provider delivery events were verified in
production on 2026-11-11; the MCP webhook receiver remains deferred. See the
[agent mail API](docs/agent-mail.md). The bounded lexical
[content search](docs/content-search.md) baseline was verified in production on
2026-11-12 with authenticated source downloads and matching hashes. Read-only
[historical Gmail import](docs/gmail-import.md) now has resumable bounded pages,
provider provenance, retained labels and account-scoped threads. The
[connected Gmail transport](docs/gmail-connector-import.md) is deployed and real-mail
backfill is in progress; a completed page does not establish mailbox completeness.
Private [routing shadow](docs/routing-shadow.md) remains available independently.
[Durable dispatch](docs/routing-dispatch.md) implements owner offers followed by one
configurable generic webhook, with
[optional classification and trusted context](docs/routing-policy.md). Fumi does not
select Techo bots or accounts. A real webhook receiver and classifier key remain
deferred. [Managed semantic/hybrid retrieval](docs/managed-mail-search.md) is
implemented with separate private ingestion/query budgets. Bounded attachment
conversion/OCR, original/derived citations, local ZIP decryption and isolated
password-protected PDF processing have controlled production
[attachment acceptance](docs/attachment-conversion.md), including all four fixture
formats in lexical, semantic and hybrid retrieval. This establishes bounded
fixture coverage; whole-archive conversion and retrieval coverage remain separate.
Private owner-only RPC adoption has a verified first durable decline of a no-code
test message; repeat receipt and handled OTP acceptance remain unverified. See the
[ingress runbook](docs/ingress.md) for
deployment, acceptance and recovery; a deployed Worker alone does not establish
production delivery.

The protected API hostname is `fumi.takuk.me`. Its Worker domain, Access protection
and authenticated reads were verified on 2026-11-12; see the
[activation runbook](docs/mail-activation.md).

## Direction

Optional [standalone ingress](docs/standalone-ingress.md) now supports receiving
without Gmail forwarding, with explicit storage-failure rejection and compatible
archive recovery. The default remains forwarding; production cutover is separate.

1. Temporarily preserve existing Gmail forwarding while capturing raw MIME in R2.
2. In parallel, backfill historical Gmail and build attachment-aware search/MCP;
   build deterministic routing, bounded model classification, and webhook delivery;
   add authenticated MCP email sending and replies.
3. Retire Gmail forwarding once fumi can reliably receive, store, retrieve, route
   and send mail independently. Gmail-based archive recovery is out of scope;
   historical Gmail backfill remains part of migration.
4. Add password-protected attachment processing, then a low-priority web client.

See the [documentation index](docs/README.md), [the roadmap](docs/roadmap.md),
[architecture proposal](docs/architecture.md),
and [library evaluation](docs/libraries.md). See also the
[existing Cloudflare mail projects](docs/existing-projects.md) and
[outbound MCP proposal](docs/outbound-mcp.md).

Selected decisions: Cloudflare Email Sending for outbound mail, Valibot with
Standard Schema integration boundaries, and a pinned bounded CEL subset for
metadata rules, with explicit grants for owner offers and notifications.
Backfill includes historical Gmail SENT messages;
ongoing Gmail Sent synchronization is out of scope.

Further evidence:
[schema integration and existing repository conventions](docs/schema-boundaries.md),
[maintained webmail and frontend components](docs/web-client-options.md), and
[attachment retrieval representations](docs/attachment-retrieval.md).
See [Cloudflare feature evaluation](docs/cloudflare-features.md) for adopted
monitoring and concurrency controls and candidates for later processing stages.
The [Gmail connector tool reference](docs/reference/gmail-tools.md) preserves the
tool descriptions and argument declarations available during design work.

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run:

```sh
mise trust
mise install
mise run install
mise run hooks:install
mise run ci
```

`mise run fix` applies formatting and lint fixes. CI runs the same checks on Linux.
The foundation includes TypeScript, Oxlint, Oxfmt, hk, YAML/TOML and workflow
validation, spelling/hygiene checks, secret scanning, and Renovate configuration.
`package.json` is private to prevent accidental npm publication; the GitHub
repository is public. Production deployment is manual through GitHub Actions,
using a Worker-scoped account token in an Actions secret and an account-ID variable.
The shared deploy action verifies the active version; CodeQL checks TypeScript
and workflows. See [repository conventions](docs/repository-conventions.md) for
the comparison and intentional differences from the larger repositories.
No private addresses, credentials, mail or production route inventory belong here.

The toolchain follows [pateat](https://github.com/risu729/pateat) and
[kogane](https://github.com/risu729/kogane), scaled down to a single package.
The native cf toolchain builds the Worker. Vitest with Cloudflare's plugin tests
the handler in the Workers runtime. See mise tasks for checking, building and
deploying. Background extraction uses the pinned `postal-mime` parser.
