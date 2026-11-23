# Repository conventions

Comparison refreshed on 2026-11-07. Fumi follows the same tooling and delivery
conventions as the owner's other repositories, scaled to one Email Worker.

## CI and deployment

- The shared
  [deploy action v4](https://github.com/risu729/wrangler-deploy-action/tree/52b0bb0f6c0969897cb84b47f4d5ebc3650f2d0c)
  uses the caller's pinned `cf` package despite its historical repository name, and
  reads Build Output v1 (`.cloudflare/output/v1`), which `cf` writes from 1.0.0-rc.0.
  Fumi uses it for credential-free CI validation and production publishing, matching
  [github-notification-cleanup](https://github.com/risu729/github-notification-cleanup/blob/5ca3542b39ffb8df563773c54b181a18073f849a/.github/workflows/worker-deploy.yml).
- Every main push or manual CI run on main whose checks and CodeQL pass deploys that
  commit, as in
  [Pateat's CI](https://github.com/risu729/pateat/blob/200756fda7054e4a7403311402b0ebf2e22dbe33/.github/workflows/ci.yml)
  ([ADR 0002](adr/0002-continuous-deployment.md)). Main runs are serialized and never
  cancelled once running. The deploy job skips a commit that is no longer the main head,
  verifies the catalog database, records pending migrations and a Time Travel bookmark,
  applies them and requires none to remain. The versions strategy then verifies the
  uploaded version at 100 percent traffic and preserves existing secrets. It then
  synchronizes the configured triggers (Cron, Workflows, queue consumer and Custom
  Domain), as ADR 0002 was amended on 2026-11-23. Version/deployment IDs, commit SHA and
  run URL appear in the job summaries.
- [Pateat's CodeQL setup](https://github.com/risu729/pateat/blob/cf2be052bb580a65b92379f268252129bd8637c3/.github/workflows/codeql.yml)
  supplies the JavaScript/TypeScript and Actions analyses with extended security
  queries, no dependency or TRAP cache, and SHA-pinned actions. Fumi runs them on
  PRs, main pushes, a weekly schedule, manual requests and before deployment.
  Successful analysis means the scan completed; review code-scanning findings
  separately, since completion alone does not mean there are no findings.
- [Kogane CI](https://github.com/risu729/kogane/blob/5342db6a832c3f3a3f6596fcb8386e69e47489d8/.github/workflows/ci.yml)
  and github-notification-cleanup supply the Actions Timeline convention. Local
  checks stay in mise and hk; workflow permissions, credentials and publication
  stay in GitHub Actions. All action references are pinned to commit SHAs.

## Local tooling and dependencies

The shared `hk-config` preset and `@risu729/tsconfigs/bundler` remain the source
of common policy. Fumi uses TypeScript, import and promise lint plugins with
correctness, suspicious and performance findings treated as errors. The
sequential streaming read has a narrow documented exception because the next
chunk depends on the previous read.

Markdown is checked and formatted by rumdl; Pkl configuration is validated and
formatted; mise configuration is validated. Oxfmt leaves Markdown, YAML, TOML
and generated lockfiles to their dedicated tools. Existing spelling, hygiene,
secret scanning and workflow security checks remain enabled. Windows overrides
only replace POSIX wrappers with equivalent direct tool invocations.

Bun records exact dependency versions and uses the frozen isolated lockfile. Renovate
follows the shared configuration, groups Cloudflare runtime/build/test dependencies and
TypeScript dependencies, and follows the Vite plugin's beta tag as in
[Pateat's configuration](https://github.com/risu729/pateat/blob/cf2be052bb580a65b92379f268252129bd8637c3/.github/renovate.json).
The tool lock covers Linux and Windows. Existing LF/two-space editor conventions,
private mail exclusions and generated Cloudflare type exclusions are retained.

## Intentional differences

PRs only validate locally: there is no preview mailbox or production-data
binding exposed to a preview.

The catalog migrations are exercised against local D1 in CI and applied to production by
the deploy job before upload ([ADR 0002](adr/0002-continuous-deployment.md)).
Provisioning the database stays a separate step in the
[catalog runbook](archive-catalog.md). There is no Container rollout, multi-Worker
release ledger, extension packaging, browser suite, package release or release
attestation in this single-Worker slice. Those checks belong to the corresponding
products in Pateat, Kogane or Kuebiko. The deploy job does not reuse an artifact from
the `CI Check` job: it checks out the same commit after that job passes and rebuilds it
for publication.

Branch protection is separate GitHub repository configuration, not a workflow file. The
aligned default-branch ruleset requires pull requests, the GitHub Actions `CI Check`,
signed commits, linear history, and CodeQL analysis that blocks every new alert a pull
request introduces, whatever its severity or level. A push dismisses earlier approvals.
It prevents deletion and force-pushes, with the same repository-administrator bypass as
Pateat and Kogane, which works only through a pull request. As in the reference
repositories, it does not require an approval count or strict up-to-date status checks.
Contributors must still obtain the independent review that AGENTS.md requires for
implementation and test changes; a zero approval-count policy does not waive it.

Mail route acceptance, Gmail inbox placement and original-byte archival are
verified independently of CI and deployment. See the [ingress runbook](ingress.md).
