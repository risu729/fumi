# ADR 0002: Deploy every main commit and apply its migrations

Status: accepted. The owner approved automatic deployment on 2026-11-17 11:41 UTC
("はい、そうして", "yes, do that") and, in the next message, asked for migrations to be
automatic as in the other repositories
("migrationも自動じゃないっけ？他のrepos見てみて", "aren't migrations automatic too?
look at the other repos"). Implemented in the PR that adds this ADR. It replaces the
manual-dispatch rule in
[repository conventions](../repository-conventions.md#intentional-differences).
Date: 2026-11-17

## Context

Production was deployed only by a manual `workflow_dispatch` of a separate
Deploy workflow, and D1 migrations were applied by hand. The only recorded
reason was "Production remains manually dispatched during staged mail
migration". In practice the owner dispatched a deployment after almost every
feature merge on 2026-11-11 and 2026-11-12. Then nobody dispatched one for five
days while about 30 PRs merged, so production fell behind main without anyone
noticing. Migration
`0014_standalone_ingress.sql` was merged on 2026-11-12 and applied by hand on
2026-11-17.

The sibling repositories already deploy every main commit and apply
migrations in that release:

- [Pateat's CI](https://github.com/risu729/pateat/blob/200756fda7054e4a7403311402b0ebf2e22dbe33/.github/workflows/ci.yml)
  runs a `deploy` job after its checks pass on a main push. The job checks the
  database UUID and name, runs `cf d1 migrations apply`, requires an empty
  `migrations list`, and then activates the version.
- [Kogane's release workflow](https://github.com/risu729/kogane/blob/68dacd8e03969e352a988d03cbb96a14e622bb07/.github/workflows/deploy.yml)
  runs after CI succeeds on main. It applies pending migrations before upload,
  and its migrations are additive and never reverted.

Both deploy tokens hold D1 write access. Fumi's token held Workers access only.

## Decision

- [`ci.yml`](../../.github/workflows/ci.yml) deploys every main push, or every
  manual run on main, whose checks pass. A `security` job runs
  [CodeQL](../../.github/workflows/codeql.yml) first, and the `deploy` job needs
  both. The separate Deploy workflow is removed. A manual deployment is a
  `workflow_dispatch` of CI on main, which joins the same queue as pushes.
- CI runs on main share one concurrency group that never cancels a running run,
  so a migration or upload always finishes. Main runs execute one at a time.
  GitHub keeps only the latest queued run in the group, which is the newest
  push, and cancels the waiting runs it replaces. A run whose commit is no
  longer the main head skips its migrations and deployment, because the newer
  commit's run is queued behind it. Before this ADR, the workflow failed in that
  case.
- Before deploying, the job checks that `FUMI_CATALOG_DATABASE_ID` names the
  `fumi-catalog` database. If migrations are pending, it records them and a
  D1 Time Travel bookmark in the job summary. It then runs
  `cf d1 migrations apply` and requires `cf d1 migrations list` to be empty. A
  failed migration stops the job before the Worker is uploaded.
- A migration must work with the Worker version that is already running,
  because it is applied before the new version goes live. This rule is in
  [AGENTS.md](../../AGENTS.md#operations-and-safety). Migrations are never
  reverted. To roll back, deploy an earlier version that still works with the
  newer schema.
- The production deploy token gets the account-level `D1 Write` permission, as
  Pateat's and Kogane's tokens have. The change is made in
  [risu729/infra](https://github.com/risu729/infra). The permission reaches every
  D1 database in the account; only this workflow's UUID-and-name check limits it
  to `fumi-catalog`. This is accepted as for the sibling repositories. The job
  installs dependencies before any step that receives the token.

An agent added the following details beyond the owner's answer, and the owner
has not confirmed them: CI calls CodeQL instead of keeping a separate Deploy
workflow, a stale run skips instead of failing, the job records a Time Travel
bookmark, and the migration-compatibility rule exists.

## Consequences

- Merging to main deploys to production and applies its migrations. Merging a
  PR is therefore a production change, including a merge by an agent.
- Renovate merges also deploy. Intermediate main commits pushed while a run is
  in progress may be cancelled while waiting and never run; the newest one runs.
- If the newest main commit fails its checks, nothing newer is deployed and
  production stays on the last deployed commit until a fix merges or someone
  starts CI on main with `workflow_dispatch`, which always uses the current main
  head. Re-running an older main run instead joins the queue last, replaces a
  newer waiting run and then skips, so it deploys nothing.
- Provisioning D1, Email Routing changes, Cron activation (`deploy-triggers` stays
  `false`) and the archive-only cutover in
  [standalone ingress](../standalone-ingress.md) stay separate, explicitly
  authorized operations.
- D1 Time Travel can restore the database to the recorded bookmark. A restore
  also reverts every write made after the bookmark, so it is a last resort,
  not a rollback step.

## Alternatives

- Keep manual dispatch: production silently falls behind main, as it did for
  five days.
- Deploy automatically but stop when `migrations/` changes, and apply those
  migrations by hand: avoids widening the token, but keeps a manual step that
  the other repositories do not need. The owner chose automatic migrations.
- A `workflow_run` trigger as in Kogane: needs `secrets: inherit` or a
  privileged trigger, plus a check of `workflow_run.head_sha`. A job inside CI,
  as in Pateat, needs neither.
