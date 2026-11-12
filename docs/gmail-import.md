# Historical Gmail import

Status: implemented for synthetic local validation. OAuth provisioning, production
migration, activation and real-mail import require explicit operator execution.
This is a historical migration, not Gmail synchronization or archive-gap recovery.

## Trusted operator surface

`startGmailImport` and `runGmailImportPage` implement the import. The separate
`handleGmailImport` adapter exposes these operations behind the existing origin
and JWT checks and a dedicated `mail:import` grant:

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/admin/gmail-import/start` | Create or verify the configured immutable run |
| GET | `/api/admin/gmail-import/status` | Counts, pending size, revision and lease state |
| POST | `/api/admin/gmail-import/page` | Process one persisted page of at most ten IDs |

Requests have no body or query parameters. They cannot supply tokens, account
namespaces, queries, destinations or cutoffs. The adapter is mounted after
`authenticate` and the same-origin check; it is not a standalone authentication
boundary. It is deliberately absent from ordinary MCP mail tools.

The two import secrets are optional and are not native `bindings.secret()`
declarations: the pinned cf configuration converter marks those declarations as
required before upload. Optional runtime types are declared beside the adapter.
Without either secret, ordinary mail routes remain available and an authorized
import request receives `gmail_import_not_configured`. Provisioning credentials
remains an explicit activation step. Before activation, verify that the selected
versions upload inherits both optional secret bindings and verify import status
again after deployment; do not infer credential persistence from compilation or
declarations. The installed upload encoder supports retaining `secret_text` and
`secret_key` through `keep_bindings`, and the full cf deployment path sets
`keepSecrets`, but this is not a production readback of import credentials.
[Secret configuration and required-secret validation](https://developers.cloudflare.com/workers/configuration/secrets/).

`gmailImportRuntime` reads server-owned `GMAIL_IMPORT_CONFIG` and
`GMAIL_IMPORT_ACCESS_TOKEN`. Both remain private configuration. The configuration
contains `importId`, `expectedAccountHash`, and `scope`: an opaque `accountNamespace`, a
fixed `before` Unix timestamp in seconds, optional `after`, and explicit
`includeSpamTrash`. `expectedAccountHash` is the SHA-256 hex digest of the expected
Gmail profile email address after trimming and lowercasing. Before the first mailbox
operation and whenever the access token changes, the transport verifies
`/users/me/profile` against that hash. The exact verified token is then used for the
operation. A token for another mailbox fails before listing or fetching mail. Do not
reuse an account namespace with a different Google account. The token must be
provisioned with exactly `https://www.googleapis.com/auth/gmail.readonly`. The runtime
does not implement consent, token storage, refresh-token exchange or grant changes. An
expired token stops the page; replace it through trusted secret configuration and retry.
A trusted embedding can inject a refreshing token provider into
`createReadonlyGmailTransport` instead. Scope declarations do not inspect or prove the
scopes of an externally provisioned token.

The transport has only fixed-host GET profile, list and `format=raw` operations with
redirects rejected. No Gmail label, read-state, draft, send, delete, insert or import
method exists. The word import here means copying out of Gmail into Fumi.

## Durability, identity and coverage

The list query uses the frozen date interval without an INBOX filter, so historical
SENT mail is included. Spam/Trash inclusion is explicitly configured. Gmail internal
date, Gmail message and thread IDs, label IDs and the first import timestamp are
preserved in private R2 provenance and `gmail_messages`. Header dates, Message-ID,
thread headers, bodies and original attachment encodings remain in exact raw MIME.
The normal MIME pipeline produces attachment hashes and versioned derivatives.
After each source commits, the importer immediately requests its existing durable
`mime-v1` Workflow, overlapping at most three dispatch-and-item-record tasks for
the at most ten sources per page. Raw reads and archive/catalog commits remain
sequential, retaining only one bounded original in memory. Every launched task
settles before checkpoint advancement or account-lease release, including when a
later raw read or ledger operation fails. Replayed sources
use the same job identity. A dispatch ambiguity remains in the pending job ledger
for bounded repair; an error before a durable job can be created retains the
import's pending page and original for replay. The importer does not wait for MIME
completion, and its archive checkpoint is not a claim of search completeness.
Successful extraction separately attempts bounded lexical indexing. Historical
sources still emit no mail lifecycle events or routing notifications.

The three-dispatch bound is independent of the declared 25-instance
[Workflow concurrency cap](processing-workflows.md). A dispatch can be queued for
capacity after acknowledgment; archive progress is not a processing-start or
search-completion measurement.

Raw import supports originals up to 25 MiB, while the unchanged MIME input limit
is 4 MiB. Larger originals remain archived with explicit blocked extraction and
omitted search coverage; immediate dispatch does not make them searchable.
Gmail internal date is a provider fact; it is not a claimed SMTP receipt date.
There is no fabricated SMTP envelope or forwarding success for historical sources.

SHA-256 of the trusted namespace and provider message ID produces a deterministic
UUID-shaped public Fumi identity. Gmail originals use the existing validated
`ingest/<internal-date>/<uuid>/raw.eml` key shape and a distinct
`gmail-import-v1` provenance receipt. Catalog source kind is `gmail`. Equal MIME
hashes never collapse live SMTP deliveries or different Gmail messages/accounts.
Existing Gmail source bytes and the first label/thread snapshot are immutable.
Retries verify existing R2 checksums and provenance rather than replacing evidence.

The runner persists the current list of IDs and next token before retrieving mail. It
retrieves and archives one original at a time; the client spaces Gmail requests by at
least 250 ms and retries transient network failures, HTTP 429 and server failures up to
four attempts. Numeric Retry-After values up to thirty seconds are honored; longer or
unsupported retry dates stop cleanly for later operator retry. HTTP 401/403/404 stop
without discarding IDs or advancing the page. In particular, a message deleted from
Gmail after listing remains an unresolved coverage gap unless already archived.

Raw R2 and provenance writes precede an atomic catalog/provider-provenance D1 commit.
Only then is the import item recorded. The page token and unique-message count move
after every listed item is durable. An item ledger prevents repeated IDs on later
pages from inflating counts. A lost response can replay the same page safely; durable
items are validated locally without another Gmail read. Counts describe unique IDs
committed by this run, not newly created archive originals. An account-scoped ten-minute
lease fences simultaneous runs and page checkpoints, renewing before each message.
Expired or superseded runners cannot advance checkpoints. R2 conditional writes keep
their late attempts from overwriting originals. A failed final checkpoint leaves the
same pending page replayable.

Gmail list traversal is not treated as a transactional mailbox snapshot. `complete`
means this bounded traversal ended, not proof that a changing mailbox has no gaps.
For final migration acceptance, compare scoped Gmail and import counts, inspect all
stopped pages, and repeat the frozen interval under a new run ID. Provider IDs make
overlap idempotent. Invalid/expired page tokens require operator investigation or a
new run; the runner never silently resets the traversal.

## Bounds and integration

Raw MIME is bounded at 25 MiB, matching live capture. The transport incrementally
decodes the base64 raw field into a bounded buffer, retains at most 32 KiB of JSON
metadata, and applies a fifteen-second request deadline. Up to one hundred label
IDs of at most 128 characters are accepted without truncation. Unsupported or
oversized messages retain their pending page and an explicit fixed error code;
there is no silent exclusion. The independent MIME stage currently blocks originals
larger than 4 MiB while retaining the archived original and coverage reason.

`0008_gmail_import.sql` preserves existing source fields and sparse rowids used by
metadata-search cursor snapshots, admits Gmail source identities, and adds run, unique
item and provider-provenance tables. Apply it before deploying this code, including when
OAuth is still unconfigured: ordinary mail reads also join the new provider-provenance
table. The reconciler understands Gmail receipts, reconstructs catalog and provider
provenance, and records incomplete raw/receipt pairs without fabricating forwarding or
stopping unrelated pages. Catalog discovery feeds the existing bounded MIME processing
repair loop. Import completion establishes archival durability; MIME completion and
search coverage are separate checks.

Historical sources always have `notify_events=0`; this is enforced by the catalog
schema as well as the runner. Import and later MIME completion emit neither received,
ready nor failed-mail historical notifications. Import does not forward mail.

No real mailbox or credentials belong in repository fixtures, logs or API errors.
Operator status returns counts only; provider bodies and exceptions become fixed
codes. Keep OAuth material, private import configuration and acceptance evidence
outside source control.

## Primary references

- [Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail raw message retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get)
- [Gmail account profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail message fields and internal date](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Gmail errors and retry guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Gmail date search](https://developers.google.com/workspace/gmail/api/guides/filtering)
- [R2 conditional writes and checksums](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
