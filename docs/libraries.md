# Library and service evaluation

Status: selected decisions and proposals checked against primary sources on
2026-11-07. Valibot, Cloudflare Email Sending and CEL are selected for later
stages. The initial R2/Gmail handler uses native platform APIs with no third-party
application dependencies; the cf build and Workers runtime tests are installed.

## Installed foundation

Bun 1.4.4, Node 26.13.0, mise tasks/lockfile, hk 2.11.1 with
[hk-config v3.1.0](https://github.com/risu729/hk-config/tree/v3.1.0), TypeScript 7.0.2,
[@risu729/tsconfigs 3.0.1](https://github.com/risu729/tsconfigs), Oxlint 1.91.0, Oxfmt
0.75.0, shared
[Renovate configuration](https://github.com/risu729/renovate-config/tree/3.23.0). The
task graph and pinned actions follow
[pateat](https://github.com/risu729/pateat/blob/b5da8bc93903323478b04cb94c12b12ad28dbc65/mise.toml)
and
[kogane](https://github.com/risu729/kogane/blob/02a915ac67bb28412e1294fe531ea4c4ba121089/mise.toml).
Bun installs are selected for this small package, as in Kogane; Pateat's aube installer
and monorepo-specific checks are not copied.

## Runtime stack

| Area                      | First candidate                   | Why / adoption gate                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers toolchain         | `cf` and native configuration     | Installed: cf 1.0.0-beta.28 with native TypeScript configuration, following Pateat. See [cf agents guide](https://developers.cloudflare.com/cf/agents/).                                                                                                                                                                                                        |
| Runtime tests             | Vitest + Cloudflare Vitest plugin | Installed: Vitest 5.1.0 and Cloudflare Vitest plugin 1.6.0 exercise the handler and R2 in the Workers runtime. SMTP forwarding acceptance is verified separately. [Testing guide](https://developers.cloudflare.com/workers/testing/vitest-integration/).                                                                                                       |
| MIME                      | `postal-mime`                     | Workers-oriented MIME/attachment parser; set nesting/header/input limits and run asynchronously. [Upstream](https://github.com/postalsys/postal-mime).                                                                                                                                                                                                          |
| HTTP API                  | Hono + @hono/standard-validator   | Follow the current Pateat pattern with a schema-neutral wrapper. Keep native email/queue handlers separate. [Integration policy](schema-boundaries.md).                                                                                                                                                                                                         |
| Runtime schemas           | Valibot + Standard Schema         | Selected: Valibot authoring, Standard Schema validation boundaries, and explicit Standard JSON Schema conversion for MCP/model APIs. [Integration policy](schema-boundaries.md).                                                                                                                                                                                |
| Claude/GPT abstraction    | Vercel AI SDK                     | Useful when both providers are required; direct provider SDKs remain a smaller alternative. Check the pinned version's structured-output API and budgets. [Official docs](https://ai-sdk.dev/docs/introduction).                                                                                                                                                |
| MCP                       | `@modelcontextprotocol/server`    | Current v2 server package and Streamable HTTP. Avoid starting on the old v1 `@modelcontextprotocol/sdk` line. Optional Cloudflare transport adapter, no DO solely for stateless tools. [SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Workers transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/). |
| Search                    | AI Search hybrid baseline         | Evaluate exact-match filters, Japanese tokenization, attachment coverage, freshness and costs before selection. [Limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).                                                                                                                                                                 |
| Custom search alternative | D1 FTS5 + Vectorize               | More control, more indexing/ranking maintenance. [D1 indexes](https://developers.cloudflare.com/d1/best-practices/use-indexes/), [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/).                                                                                                                                              |
| State and background work | D1 + R2 + Queues                  | Metadata/outbox, immutable bytes and asynchronous work respectively. DO/Workflows only when a specific coordination or durable multi-step requirement warrants them.                                                                                                                                                                                            |

## Rule language

**CEL is the Google-origin library/language family.** Google moved the official
repositories to `cel-expr` in June 2026. Its listed official implementations are
Go/C++/C/Java/Python; this review did not establish an official Google TS runtime. Buf's
ECMAScript package below is an independent implementation, not Google's TypeScript SDK.
[Google announcement](https://opensource.googleblog.com/2026/06/cel-finds-a-new-home-at-githubcomcel-expr.html),
[official implementations](https://cel.dev/reference/api-reference).

**CEL is selected, subject to a review before routing implementation.** The
language choice is provisional until the evaluator, supported subset, resource
limits and owner-plugin contract pass the gates below. No CEL runtime is installed
in the initial R2 sink. It expresses typed predicates with familiar
operators and separates matching from privileged actions. A manifest can carry
an upstream-owned expression such as this synthetic candidate selector:

```text
mail.kind == "authentication_code" && mail.recipient_group == "demo-account"
```

This only selects a plugin candidate. It does not prove the code was requested,
authorize a destination or cause an action; the owner validates current state.

| Language                                             | Strength                                            | Trade-off                                                                                             |
| ---------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [CEL](https://github.com/cel-expr/cel-spec)          | Readable predicates, types, useful policy ecosystem | JS implementation conformance and evaluation limits need verification                                 |
| [Sieve](https://www.rfc-editor.org/rfc/rfc5228.html) | Standard language specifically for mail filtering   | Worker/plugin/model flows need extensions; consider if mail-server interoperability becomes important |
| [JSON Logic](https://jsonlogic.com/)                 | JSON AST works well with a future visual editor     | Verbose to author; coercion/typing semantics need care                                                |

Spike [@bufbuild/cel](https://github.com/bufbuild/cel-es) first, compare
[@marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) for size and runtime
compatibility. CEL as a language does not guarantee any particular JS engine is
safe, conformant or cost-metered. Verify the used subset, no dynamic code/native
addons, bounded AST/input/comprehension/regex evaluation, prototype escape
resistance, startup/bundle size and Workers CPU. Pin the evaluator version with
the adopted manifest. Do not run arbitrary plugin JS in fumi. An official Go
runtime would require another execution strategy; do not add a server just for
predicates. WASM would be a separate evaluated option, not a presumed drop-in.

## Outbound and mailbox reuse

Cloudflare Email Sending's native binding is selected; see
[outbound MCP](outbound-mcp.md). Historical Gmail SENT backfill is included, ongoing
Gmail Sent sync is excluded. For mailbox and UI reuse rather than individual backend
libraries, see [existing projects](existing-projects.md) and
[maintained UI options](web-client-options.md).

## Schema boundaries and attachment representations

Use Valibot internally and Standard Schema at reusable validation boundaries. Hono's
standard validator accepts Valibot directly; MCP and model APIs also need JSON Schema
conversion. This keeps integrations replaceable without pretending all library semantics
are identical. [Schema policy and repository evidence](schema-boundaries.md).

Attachment RAG does not require fumi to turn every file into `.txt`. Supported
objects can use managed conversion/OCR, and visual retrieval can use image
representations. Keep originals and retrieval derivatives distinct.
[Attachment retrieval design](attachment-retrieval.md).

## Encrypted attachments

| Format                 | Candidate                                                                 | Gate                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ZIP (AES / ZipCrypto)  | [@zip.js/zip.js](https://gildas-lormeau.github.io/zip.js/)                | Disable browser Web Worker assumptions; verify Workers runtime, integrity validation, expansion/path limits and non-ASCII passwords |
| Encrypted PDF          | [@libpdf/core](https://github.com/LibPDF-js/core)                         | Beta candidate with encryption support; validate compatibility, memory use, malformed files and decrypted output preservation       |
| PDF preview/extraction | [PDF.js](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) | Password-aware reading is different from producing an unencrypted archival derivative                                               |

[pdf-lib explicitly does not decrypt](https://github.com/Hopding/pdf-lib#encryption-handling);
`ignoreEncryption` is not a solution. Native qpdf cannot run directly inside an
isolate; a WASM port would require its own audit. Do not promise universal Office,
RAR, PDF or OCR support within Workers before measuring it.

## Minimum experiments before adopting runtime dependencies

1. Gmail forwarding plus byte-preserved R2 capture, including partial failures.
2. MIME stress corpus and attachment size/CPU/memory measurements in Workers.
3. CEL subset tests and plugin replay with side effects disabled.
4. Hybrid versus DecisionRAG retrieval on cited bilingual evidence.
5. Classifier schema failures, prompt injection, provider errors and cost ceilings.
6. Encrypted ZIP/PDF corpus: wrong passwords, corrupt files, nested archives,
   bombs, Unicode passwords and high-memory documents.

Production observations and real-mail fixtures remain private. Public examples
and tests use synthetic data only.
