# Documentation

Fumi is one Cloudflare Email Worker that captures, archives, retrieves, routes
and sends mail. This page is the index of its documentation and the rules for
where each kind of fact lives. Agent rules live in [AGENTS.md](../AGENTS.md)
only.

## Ownership

| Document                                            | Owns                                                        | Update rule                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| [Roadmap](roadmap.md)                               | Future work, phase order and done-when criteria             | The only work tracker; check an item only with linked evidence |
| [Architecture](architecture.md)                     | Product scope, runtime boundaries and contracts             | Update with changes; mark unimplemented behavior as proposed   |
| Feature pages (below)                               | Current behavior, limits, rollout and recovery for one area | Update in the PR that changes the behavior                     |
| [ADRs](adr/)                                        | Larger decisions, their alternatives and rationale          | Amend explicitly or supersede; preserve accepted text          |
| [Repository conventions](repository-conventions.md) | Tooling, CI, deployment and differences from sibling repos  | Update with the workflow or tool change                        |
| Research snapshots                                  | Dated observations and primary sources                      | Append or supersede; never imply current verification          |

Keep one authoritative location for each fact. Link to it rather than copying
it. Do not keep a chat transcript, a chronological decision log or a second
status list. Verification belongs in the PR; keep a dated record only when it
supports a lasting compatibility or operational claim. Private evidence (route
inventories, real-mail acceptance, private rule sets) stays outside this
repository.

## Decision records

Record a larger owner decision as an ADR in [`adr/`](adr/), and a smaller one in
the owning page with the date and UTC time, for example
`(owner, 2026-11-12 22:09 UTC)`. Land the record with the implementation PR or as
its own docs PR.

A new ADR is named `NNNN-short-title.md`, numbered after the highest existing
one; check open PRs for the same number first. It starts with `Status:` and
`Date:` lines. `Status:` says who accepted it and when (UTC), quotes the owner's
words where they decided it, says whether it is implemented, and names the ADRs
it amends or replaces. The body has Context, Decision, Consequences and
Alternatives sections. Mark anything an agent added beyond the owner's answer as
not confirmed by the owner.

After acceptance, change an ADR only through a dated amendment section, keep the
accepted text, and note the amendment in its `Status:`. An ADR that amends
another also updates the other's `Status:`. Add each new ADR to the list below in
the same PR. An accepted ADR can still be wrong; propose an amendment when the
code or evidence shows a better option.

- [0001: Agent rules in AGENTS.md and decisions in the repository](adr/0001-rules-and-decision-records.md)

Decisions made before ADRs were introduced stay in their owning pages, for
example the library selections in [libraries](libraries.md). They move to an ADR
only when they change.

## Pages

Capture and archive:

- [Initial email capture and ingress runbook](ingress.md)
- [Mail API activation](mail-activation.md)
- [Archive catalog and reconciliation](archive-catalog.md)
- [Archive health](archive-health.md)
- [Operator archive repair](archive-repair.md)
- [Processing with Cloudflare Workflows](processing-workflows.md)
- [MIME extraction](mime-extraction.md)
- [Optional processing activation](optional-processing.md)

Historical import:

- [Historical Gmail import](gmail-import.md)
- [Import from a connected Gmail account](gmail-connector-import.md)
- [Native staging for connected Gmail originals](gmail-connector-stage.md)

Attachments and retrieval:

- [Attachment conversion and local ZIP extraction](attachment-conversion.md)
- [Attachment retrieval representations](attachment-retrieval.md)
- [Content search](content-search.md)
- [Managed semantic retrieval](managed-mail-search.md)

Agent API and outbound mail:

- [Agent mail API](agent-mail.md)
- [Outbound email through MCP](outbound-mcp.md)

Routing:

- [Routing shadow](routing-shadow.md)
- [Routing policy and notification context](routing-policy.md)
- [Routing dispatch](routing-dispatch.md)
- [Owner-maintained plugins](plugins.md)

Evaluations and research snapshots:

- [Library and service evaluation](libraries.md)
- [Schema boundaries](schema-boundaries.md)
- [Cloudflare feature evaluation](cloudflare-features.md)
- [Existing Cloudflare mail projects](existing-projects.md)
- [Web client options](web-client-options.md)
- [Gmail connector tool reference](reference/gmail-tools.md)

This layout follows
[Pateat's documentation index](https://github.com/risu729/pateat/blob/main/docs/README.md)
and
[Kogane ADR 0041](https://github.com/risu729/kogane/blob/main/docs/adr/0041-documentation-scope.md),
scaled down to one Worker.
