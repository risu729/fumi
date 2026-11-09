# fumi

A Cloudflare Workers email archive and routing service. The name comes
from _fumi_ (a letter or written message).

**Status: initial email capture implemented.** The Email Worker preserves Gmail
forwarding, archives original MIME bytes and private receipts in R2, and records
archive and forwarding outcomes independently. Runtime tests use synthetic mail.
A D1 catalog and bounded scheduled reconciler index existing R2 evidence separately
from delivery. Cloudflare Workflows now adds immediate catalog registration,
durable processing state and missing-start repair; its production activation is
pending. See [processing Workflows](docs/processing-workflows.md) and
[catalog recovery](docs/archive-catalog.md) for identity, failures and rollout.
Backfill, search, plugin routing, model classification, webhooks and outbound MCP
are planned. See the [ingress runbook](docs/ingress.md) for deployment, acceptance
and recovery; a deployed Worker alone does not establish production delivery.

## Direction

1. Temporarily preserve existing Gmail forwarding while capturing raw MIME in R2.
2. In parallel, backfill historical Gmail and build attachment-aware search/MCP;
   build deterministic routing, bounded model classification, and webhook delivery;
   add authenticated MCP email sending and replies.
3. Retire Gmail forwarding once fumi can reliably receive, store, retrieve, route
   and send mail independently. Gmail-based archive recovery is out of scope;
   historical Gmail backfill remains part of migration.
4. Add password-protected attachment processing, then a low-priority web client.

See [the roadmap](docs/roadmap.md), [architecture proposal](docs/architecture.md),
and [library evaluation](docs/libraries.md). See also the
[existing Cloudflare mail projects](docs/existing-projects.md) and
[outbound MCP proposal](docs/outbound-mcp.md).

Selected decisions: Cloudflare Email Sending for outbound mail, Valibot with
Standard Schema integration boundaries, and CEL for rules. Revisit the CEL
evaluator and safety limits before implementing routing. These future adapters
are not installed in the R2 sink. Backfill includes historical Gmail SENT messages;
ongoing Gmail Sent synchronization is out of scope.

Further evidence:
[schema integration and existing repository conventions](docs/schema-boundaries.md),
[maintained webmail and frontend components](docs/web-client-options.md), and
[attachment retrieval representations](docs/attachment-retrieval.md).
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
deploying; the initial handler needs no third-party application dependencies.
