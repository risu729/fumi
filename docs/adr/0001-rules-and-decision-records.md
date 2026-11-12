# ADR 0001: Agent rules in AGENTS.md and decisions in the repository

Status: accepted. The owner gave the rules on 2026-11-12 22:09 UTC: "Record every
design decision risu makes in the repo: an ADR for large ones, otherwise the
owning docs/ page. Nothing lives only in a thread or memory. Rules live in
AGENTS.md only (no CLAUDE.md)." Implemented in
[#59](https://github.com/risu729/fumi/pull/59).
Date: 2026-11-12

## Context

Fumi is developed mostly by agents across many parallel threads. Before this
ADR, decisions were spread across feature pages, PR descriptions and thread
conversations, and the repository had no ADR directory or
documentation index. An agent starting a new thread could not tell which owner
decisions were current, or where to record a new one. The owner's sibling
repositories, [Pateat](https://github.com/risu729/pateat) and
[Kogane](https://github.com/risu729/kogane), already keep agent rules in
`AGENTS.md`, decisions in `docs/adr/` and a documentation index in
`docs/README.md`.

## Decision

- [AGENTS.md](../../AGENTS.md) is the only agent rules file. No `CLAUDE.md` or
  other agent-specific rules file is added.
- Larger owner decisions are ADRs in `docs/adr/`; smaller ones go into the
  owning `docs/` page with the date and UTC time. A decision that exists only in
  a thread or in agent memory is not recorded.
- [docs/README.md](../README.md) indexes the documentation, states which page
  owns which kind of fact, and holds the ADR format and list.
- [The roadmap](../roadmap.md) stays the only work tracker.

The ADR format, the ownership table, the grouping of the page list, the rule
for documentation-only PRs and the use of UTC without JST inside the repository
were chosen by an agent from the sibling repositories and are not confirmed by
the owner.

## Consequences

- New threads read `AGENTS.md` and `docs/README.md` to find the rules and the
  current decisions, instead of relying on a previous thread.
- Decisions made before this ADR stay in their owning pages, such as the
  library selections in [libraries](../libraries.md), and are not backfilled as
  ADRs unless they change.
- Agent-facing conventions such as language, link style and time format are
  rules in `AGENTS.md`, not ADRs.

## Alternatives

- Keep decisions only in feature pages: works for small choices, but loses the
  alternatives and rationale of larger ones and has no single list to review.
- Backfill every earlier decision as an ADR now: large documentation churn with
  no new information; the owning pages already record them.
- A chronological decision log: Pateat rejects one because it duplicates the
  owning pages and goes stale; Kogane keeps long chronological records apart in
  `docs/history/`. Fumi has no such records yet.
