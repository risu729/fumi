# fumi

A planned Cloudflare Workers email archive and routing service. The name comes
from _fumi_ (a letter or written message).

**Status: development foundation only.** There is no email handler, deployed
Worker, storage binding, backfill job, search service, or webhook delivery yet.
The TypeScript entry point is intentionally empty. No production route changes
are part of this repository bootstrap.

## Direction

1. Preserve existing Gmail forwarding and archive incoming raw MIME in R2.
2. In parallel, backfill historical Gmail and build attachment-aware search/MCP;
   build deterministic routing, bounded model classification, and webhook delivery.
3. Add password-protected attachment processing, then a low-priority web client.

See [the roadmap](docs/roadmap.md), [architecture proposal](docs/architecture.md),
and [library evaluation](docs/libraries.md). Runtime choices remain proposals.

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
repository is public. There is no deployment workflow or configured secret.

The toolchain follows [pateat](https://github.com/risu729/pateat) and
[kogane](https://github.com/risu729/kogane), scaled down to a single package.
There are no runtime dependencies or application tests yet; meaningful Worker
tests will accompany the first behavior rather than assert an empty scaffold.
