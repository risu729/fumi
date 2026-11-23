# ADR 0002: Deploy every main commit and apply its migrations

Status: accepted. The owner approved automatic deployment on 2026-11-17 11:41 UTC
("はい、そうして", "yes, do that") and, in the next message, asked for migrations to be
automatic as in the other repositories
("migrationも自動じゃないっけ？他のrepos見てみて", "aren't migrations automatic too?
look at the other repos"). Implemented in the PR that adds this ADR. It replaces the
manual-dispatch rule in
[repository conventions](../repository-conventions.md#intentional-differences).
Date: 2026-11-17. Amended on 2026-11-23 to synchronize triggers; see
[the amendment](#amendment-2026-11-23-trigger-synchronization).

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
- Provisioning D1, Email Routing changes and the archive-only cutover in
  [standalone ingress](../standalone-ingress.md) stay separate, explicitly
  authorized operations. Cron, Workflows, the queue consumer and the Custom Domain
  were separate operations too until the
  [2026-11-23 amendment](#amendment-2026-11-23-trigger-synchronization).
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

## Amendment 2026-11-23: trigger synchronization

Status: accepted. On 2026-11-23 at 14:39 UTC the owner approved enabling trigger
deployment in CI ("CI でトリガーの反映を有効にする" / "これでいい", "enable trigger
deployment in CI" / "that's fine"). At 14:48 UTC the owner chose to try narrow token
grants first and to add account-wide Workers Scripts Write only if they are not enough
("狭い権限でダメならscripts writeで", "if narrow permissions fail, use Scripts Write").

### Context

The deploy job ran the shared action with `deploy-triggers: "false"`, so CI never
applied the `triggers`, `domains` or Workflow `exports` in
[`cloudflare.config.ts`](../../cloudflare.config.ts). `fumi-mail-processing` existed
from a manual `cf deploy` before CI deployed (Cloudflare reports it created on
2026-11-09 at 20:43 UTC). `fumi-gmail-takeout`, added in
[#162](https://github.com/risu729/fumi/pull/162), was never registered: the Worker
version deployed, but the Workflow was missing in production until it was created by
hand on 2026-11-23 at 14:15 UTC, without its declared concurrency limit and retention.

A read-only comparison at about 14:50 UTC found production equal to the configuration
for the Cron `*/5 * * * *`, workers.dev and preview URLs (both off), `fumi.takuk.me`
and the `fumi-delivery-events` consumer (batch 10, 5 retries,
`fumi-delivery-events-dlq`). The Workflow concurrency limits and retention cannot be
read back through the API. `cf workers triggers deploy --dry-run` validates the
configuration and exits before any API request, so it cannot show this comparison.

### Decision

- The deploy step sets `deploy-triggers: "true"`. After verifying the new version at
  100 percent, the action runs `cf workers triggers deploy --prebuilt --mode production
  --worker fumi`. That sets the Worker's workers.dev and preview settings and its Cron
  schedules, attaches the Custom Domain, updates the queue consumer and `PUT`s both
  Workflows with their class, concurrency limit and retention. The action checks the
  Custom Domain changeset before upload, before synchronization and after it, and
  refuses removals, conflicts or a domain attached to another Worker.
- The production token gets account-wide Queues Write and Workers Routes Write on
  `takuk.me` in [risu729/infra](https://github.com/risu729/infra), the grants Kogane and
  Pateat already hold for the same steps. The Workflow `PUT` is documented with
  account-wide Workers Scripts Write only. If the first synchronizing deployment is
  refused there, that grant is added as the owner allowed. It would let the token change
  or delete every Worker in the account.

### Outcome

The narrow grants were applied in
[risu729/infra#163](https://github.com/risu729/infra/pull/163). The first synchronizing
deployment, [run 45238054024](https://github.com/risu729/fumi/actions/runs/45238054024)
(18:27 UTC), applied the Custom Domain, the Cron schedule and the queue consumer, but
both Workflow `PUT` requests were refused with code 10105 (`not_entitled`). Account-wide
Workers Scripts Write was then added in
[risu729/infra#167](https://github.com/risu729/infra/pull/167), and
[run 45243046142](https://github.com/risu729/fumi/actions/runs/45243046142) (18:55 UTC)
synchronized every trigger, including both Workflows (`fumi-mail-processing` and
`fumi-gmail-takeout`).
The production token can therefore change or delete every Worker in the account.

### Consequences

- A change to `triggers`, `domains` or a Workflow export reaches production with the
  next main deployment. Removal is not symmetric: a removed Cron schedule is removed
  (the schedules are replaced as a whole), but a removed queue consumer or Workflow
  stays in production until deleted separately, and a removed Custom Domain makes
  the domain guard fail the deployment before upload.
- Synchronization runs after the new version is live. If it fails, the job fails, that
  version stays live and the trigger changes already made are kept; nothing is rolled
  back. Fix the cause and start CI on main again.
- Setting a Workflow's retention applies to its instance history; the concurrency limit
  of 1 on `fumi-gmail-takeout` matches the import's one-instance-at-a-time design.
- Email Routing is not touched: the configuration declares no `addresses`.
