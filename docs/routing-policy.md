# Private classification and notification context

Unresolved mail may use a bounded Claude classification after deterministic rules
and exclusive owner offers. Configuration is private and opt-in: the fixed R2
object `config/routing-policy-v1.json` selects a model, administrator instructions,
minimum confidence, daily call cap and whether explicit policy exclusions may be
ignored. `ROUTING_ANTHROPIC_API_KEY` is an optional Worker secret. Absent, disabled
or invalid configuration holds unresolved mail without calling a provider.

The configuration has `schemaVersion: 1`, `enabled`, `provider: "anthropic"`,
`model`, `instructions`, `maxCallsPerDay` (1–1000), `minimumConfidence` (0.5–1), and
`allowModelIgnore`. No account, endpoint, password or private policy belongs in
the repository. Operators choose the model and budget before activation; the
implementation does not select a paid model or provision credentials implicitly.

Fumi forwards review decisions to one administrator-configured generic webhook or
adapter. Descriptive categories do not choose a bot, account or endpoint. Downstream
routing, including Techo bot selection and account switching, belongs to the receiver.

The API origin is fixed to Anthropic. Requests have no tools, no URL fetches and
no ability to select credentials or notification endpoints. Administrator policy
is separate from JSON-encoded untrusted mail metadata and body. The output is a
strict schema of symbolic outcome, descriptive category, urgency, confidence and a
fixed reason code. Validation rejects extra fields, refusal, partial output,
invalid classification combinations and oversized responses. A security alert always
becomes urgent review. Model suppression requires an explicit administrator
grant, a policy-exclusion reason, no category and no urgency. Low confidence holds.

Input is complete UTF-8 plain text of at most 24 KiB, verified against its stored
SHA-256. Larger or HTML-only messages hold for review rather than silently
classifying a truncated prefix. The private policy is at most 64 KiB; responses
are at most 16 KiB, with a twenty-second request/body deadline. Redirects are not
followed. Provider failures and invalid outputs use fixed error codes; neither
prompts nor provider responses appear in logs or durable result records.

Migration `0012_routing_policy.sql` persists classification leases, results,
attempt counts, a shared UTC-day budget and trusted notification context. A
sixty-second lease excludes overlapping calls for the same source/policy. Calls
reserve budget atomically before submission. Errors retry no sooner than fifteen
minutes and at most three submitted attempts per source/policy; ambiguous provider
requests consume budget. Changing policy cannot reset the shared daily budget.
Completed decisions are reused only for the same source and MIME manifest.
Concurrent policy revocation, source changes or lost leases invalidate the answer.
Historical provenance is rejected before any provider request.

## Trusted case and acknowledgement context

Only an authenticated `mail:routing` operator can write context. The parent HTTP
handler enforces origin and JWT authentication before these routes:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/admin/routing/policy/status` | Counts by classification state/error and today's reserved model calls |
| GET | `/api/admin/routing/context/<mail_id>` | Current trusted context and revision |
| PUT | `/api/admin/routing/context/<mail_id>` | Compare-and-swap context for an exact source digest |

Context fields are `sourceSha256`, `expectedRevision` (zero for creation),
`trustedThreadKey`, `acknowledgement` (`none`, `done`, `case`, `digest_reported`),
`caseState` (`unknown`, `action_required`, `waiting`, `scheduled`, `complete`),
`requiresMailAction` and `alreadyNotified`. A stale revision or changed source
rejects the update. These facts must come from the owning case/acknowledgement
system, never MIME headers, retrieved mail or model output.

Missing context does not silently suppress a new message. Exact-source prior
notification suppresses duplicates. Urgent or mail-action-required items remain
eligible; a known acknowledgement plus waiting/scheduled/completed case can
suppress ordinary repeat notification. A distinct follow-up source remains
eligible even if its RFC References claim an already handled thread. Suppression
is not deletion, Gmail label mutation, or completion of the underlying case.

## Validation and activation

Synthetic workerd tests cover provider boundaries, injection-shaped data,
malformed/refused output, budget/lease races, revocation, source integrity,
historical suppression and context revision handling. Real model quality and
delivery are separate activation checks. Private policy compilation must retain
dated exception precedence, use the latest explicit instructions when old rules
conflict, and keep ambiguous cases for review. No private policy or real model
call is established by synthetic tests.

Primary references:
[Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
and
[Workers request redirect behavior](https://developers.cloudflare.com/workers/runtime-apis/request/).
