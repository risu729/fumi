# File transfer in MCP

Research snapshot: **2026-11-17, 14:30–15:30 UTC**. Source review only; no client or
extension was implemented or tested. It answers how the Model Context Protocol (MCP)
moves files between client and server, especially large files sent from the client
to a tool, and separates the released specification from drafts and vendor
extensions. Fumi's own upload design is out of scope here and follows separately.

**The released specification has no client-to-server file transfer. The
standardization effort is the File Uploads Working Group's experimental extension
`io.modelcontextprotocol/files`: a tool argument carries file metadata, small files
may travel inline as base64, and larger files go out of band to an upload URL that
the server returns, after which the client retries the same tool call.** It is a
draft, not a SEP, and no surveyed client implements it yet.

## Released specification (2026-07-28)

[MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
is the latest release; the
[draft changelog](https://modelcontextprotocol.io/specification/draft/changelog) lists
no file-related changes since. Binary data appears only as base64 inside JSON, and
only from server to client:

| Where                                                                                            | Shape                                                                      | Direction        |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------- |
| [Tool result image/audio](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) | `{"type": "image", "data": "<base64>", "mimeType": "image/png"}`           | Server to client |
| [Resource contents](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)   | `{"uri": "file:///example.png", "mimeType": "image/png", "blob": "<base64>"}` | Server to client |
| Embedded resource in a tool result                                                               | `{"type": "resource", "resource": {...}}`                                  | Server to client |
| Resource link in a tool result                                                                   | `{"type": "resource_link", "uri": "...", "name": "...", "mimeType": "..."}` | Reference only   |

- Tool arguments are plain JSON shaped by `inputSchema`. No content type, schema
  keyword or capability marks an argument as a file, so a file reaches a tool only
  as a base64 string or a URL by the server's own convention. 2026-07-28 allows any
  JSON Schema 2020-12 keyword in `inputSchema`, which the extension below relies on.
- [Elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
  form mode accepts only flat primitive fields (`email`, `uri`, `date`, `date-time`
  string formats), not files. URL mode sends the user to a server page "for
  out-of-band interactions that must not pass through the MCP client"; the spec's
  examples are credentials, OAuth and payments. Using it for uploads is possible
  but is not described by the spec.
- No size limit, streaming, chunking or range read is defined. `resources/read`
  takes only a `uri`, and Resource has an optional `size` in bytes.
- The release adds an `extensions` field to client and server capabilities, which is
  how the file extension below is negotiated.
- Deprecating Roots, the changelog tells servers to "pass directories or files via
  tool parameters, resource URIs, or server configuration instead".

Base64 costs about 33% on top of the file and keeps the whole payload in JSON-RPC
messages. When a model writes the argument, every byte is an output token, which is
why fumi's `upload_attachment.content_base64` caps each file at 1 MiB
([agent mail API](agent-mail.md)).

## Proposals and their status

| Proposal                                                                                                                        | Mechanism                                                                                                                                         | Status (2026-11-17)                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [SEP-1306](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1306) binary mode elicitation                    | Third elicitation mode `binary` with server `uploadEndpoints` and multipart POST                                                                  | Opened 2025-08-05; closed 2026-03-12, superseded by SEP-2356                                        |
| [SEP-2356](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2356) file input for tools and elicitation          | String argument with `"format": "uri"` and `x-mcp-file: {accept, maxSize}`, carrying an RFC 2397 `data:` URI; URL-mode elicitation for large files | Opened 2026-03-05; closed 2026-06-26 in favor of SEP-2631                                           |
| [SEP-2631](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2631) file objects and transfer                     | `files/authorizeUpload` and `files/authorizeDownload` return HTTPS transfer descriptors; tools receive a file URI such as `mcp-file://server/file_01HXYZ` | Opened 2026-04-22 (OpenAI author); closed 2026-10-14 in favor of the WG extension                   |
| [SEP-2532](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2532) resource streaming                            | New `resources/stream` that answers with raw bytes, a 302/307 redirect to a presigned URL, or a `downloadUrl`                                     | Draft, opened 2026-04-07 (Microsoft author), seeking a sponsor; server-to-client only               |
| [experimental-ext-file-uploads](https://github.com/modelcontextprotocol/experimental-ext-file-uploads) `io.modelcontextprotocol/files` | Below                                                                                                                                             | Experimental extension draft from [PR #1](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/pull/1) (opened 2026-10-14); not a SEP; no reference implementation yet |

The
[File Uploads Working Group](https://modelcontextprotocol.io/community/working-groups/file-uploads)
was chartered on 2026-04-23, led by Den Delimarsky (Anthropic) with members from
Anthropic and OpenAI. Its meeting notes record the current direction:

- [2026-10-02](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3412):
  the File Uploads and Filesystems groups merge into one Files WG; SEP-2631 is closed
  and replaced by a new draft; "Nothing goes into the core specification until it has
  been validated in use"; the order is "metadata first, upload target back, bytes, then
  finalize", building on multi round-trip requests; v0 is "a single HTTP PUT (roughly
  up to 250 MB)", with resumable transfer later behind a capability; auth must cover
  bearer tokens and presigned URLs.
- [2026-10-16](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3442):
  the draft stays an experimental extension outside the spec release cycle ("the next
  release is in March"); the first version stays a single PUT; downloads to be drafted.
- [2026-10-30](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3501):
  credentialed transfers are bound to the host; downloads are returned directly by the
  tool call, with HTTP range requests for partial reads; presigned URL origin binding
  is still open; next step is to "merge the PR, and start prototyping".

The community thread
[discussion #1197](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1197)
(since 2024-12) records the same starting point: no interoperable upload primitive
exists in the released spec.
[Discussion #3325](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3325)
measured the cost of the base64 alternative with OpenAI's `cl100k` tokenizer: 126,327
random bytes became about 120,666 tokens and 512,000 bytes about 489,607 tokens, about
0.96 tokens per input byte. It also notes that the Python SDK's Streamable HTTP server
rejects request bodies over 4 MiB with HTTP 413.

## The `io.modelcontextprotocol/files` draft

From the
[draft specification](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/blob/main/specification/draft/file-uploads.md)
on the extension's main branch (read 2026-11-17), which targets protocol 2026-07-28
and later. The WG "plans to submit this document as an Extensions Track SEP once a
reference implementation exists. Anything here can change before then." Earlier
meeting notes describe inline files as `data:` URIs; the current text uses a `data`
member instead.

1. The client declares `"io.modelcontextprotocol/files": {"upload": {}, "download": {}}`
   in its capabilities. The server declares
   `"io.modelcontextprotocol/files": {"upload": {}, "maxInlineBytes": 1048576}`.
   `maxInlineBytes` is the total decoded inline bytes per request; 0 or absent means
   no inline files.
2. A file argument is an object schema marked with `x-mcp-file`:

   ```json
   "file": {
     "type": "object",
     "x-mcp-file": { "accept": ["application/pdf"], "maxSize": 157286400 },
     "required": ["id", "mimeType", "size"]
   }
   ```

   Its value has `id` (unique per call), `name`, `mimeType`, `size`, an optional
   `digest` (SHA-256, base64url) and an optional `data` (base64). With `data` the
   file is inline; without it the file goes out of band.
3. For an out-of-band file the client first calls the tool with metadata only:
   `{"id": "file-1", "name": "Q3 report.pdf", "mimeType": "application/pdf", "size": 41204133}`.
4. The server answers `"resultType": "upload_required"` with one upload target per
   file and an opaque `requestState`:

   ```json
   {
     "fileId": "file-1",
     "url": "https://upload.example.com/u/01JD3V7K2M?sig=...",
     "headers": { "Content-Type": "application/pdf" },
     "credentials": "omit",
     "expiresAt": "2026-11-04T18:30:00Z"
   }
   ```

   A target has `url` or `path` (exactly one), `method` (`PUT` by default, or
   `POST` with `form` fields for multipart-only storage), `headers`, `credentials`
   (`omit` for a signed URL, `include` to send the MCP session's credentials) and an
   advisory `expiresAt`.
5. The client uploads the bytes, then retries the same tool name and arguments with a
   new JSON-RPC id and the echoed `requestState`. The retry does not prove the upload
   arrived; the server checks its storage (for example with HEAD) before running.

Hosts "SHOULD NOT show `x-mcp-file` schemas to a model that emits arguments as
tokens", and may instead show the model a host-defined handle that the host replaces
with a `FileInput`. Targets never enter model context. Clients reject targets that
are not absolute `https` URLs, that set `Authorization` or `Cookie` headers, or that
redirect, and send the MCP credential (`credentials: "include"`) only to the
server's own origin. A tool that is unsafe to run twice accepts each `requestState`
at most once.

The draft's own example: with `maxInlineBytes` 1 MiB and `maxSize` 150 MiB, a 200 KiB
file goes inline, a 40 MiB file goes out of band, and a 200 MiB file is rejected.
Downloads (`_meta["io.modelcontextprotocol/files"].downloads` with URL targets) are
in the draft but marked as not yet reviewed. Chunked or resumable uploads, an opt-in
mode that sends files with the first call, and uploads from elicitation forms are
listed as future work. Open review questions include whether the upload request
should be an input request of the `input_required` result instead of a separate
result type, PUT versus POST, retry idempotency, and gateways that do not see the
inner tool's schema.

## What clients do today

| Client                                                                                                              | Client-to-server files                                                                                                                                                                                                                                                                                                | Kind                     |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ChatGPT ([Apps SDK reference](https://developers.openai.com/plugins/reference))                                     | `_meta["openai/fileParams"]` lists top-level arguments that are files; each receives `{ download_url, file_id, mime_type?, file_name? }`, and the server fetches the bytes from `download_url`. Widgets have `window.openai.uploadFile`, `selectFiles` and `getFileDownloadUrl`                                     | OpenAI vendor extension  |
| Claude API ([MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector))                    | "Only tool calls are currently supported"; no file input                                                                                                                                                                                                                                                              | Anthropic, beta          |
| Claude app connectors (observed in this project's Gmail connector, 2026-11-17)                                      | The app adds a "FILE REFERENCES" note to a tool description: the model writes `sha256:<64 hex>:<absolute path>` in a base64 field and "the app fills in the file's content when the call runs". The server still receives base64 in JSON (Gmail `create_draft` caps attachments at 25 MB)                           | Host feature, not MCP    |
| [Cursor](https://cursor.com/docs/mcp)                                                                               | Supports tools, prompts, resources, roots, elicitation and MCP Apps; tool-result images are attached to chat. No file input documented                                                                                                                                                                              | Spec features only       |
| [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (`io.modelcontextprotocol/ui`, stable 2026-01-26)      | No upload or download method between app and host                                                                                                                                                                                                                                                                    | Official extension       |
| Server-side workaround, for example [FutureSearch](https://futuresearch.ai/blog/mcp-large-dataset-upload/)          | A tool returns a short-lived signed upload URL; the agent's code sandbox runs `curl` to upload; later calls pass the returned ID                                                                                                                                                                                     | Per-server convention    |

ChatGPT's `fileParams` and the extension's upload targets are the two shapes that
keep bytes out of the model and out of JSON-RPC, and they run in opposite
directions: ChatGPT gives the server a URL to download from, while the extension
gives the client a URL to upload to. The Claude app's file reference removes the
model's output tokens but not the base64 in JSON-RPC, so the server's JSON size limit
still applies.

## Implications for fumi

- No surveyed client sends files through a standard mechanism today. Grok, fumi's main
  target client, was not surveyed here. The draft also assumes a host that holds the
  file and hides the schema from the model, so a model-only client cannot use it. Any
  fumi upload path needs a fallback that works with plain tool calls.
- An upload design that follows the draft would keep the shape of its pieces: an
  `x-mcp-file` object argument with `id`, `name`, `mimeType`, `size` and an optional
  SHA-256 `digest`; a server-issued upload target with `url`, `method`, `headers`,
  `credentials: "omit"` and `expiresAt` (an R2 presigned PUT fits this directly); a
  server-side storage check before the tool runs; and inline base64 kept for small
  files under a server-declared limit.
- Until clients implement `upload_required`, the same target can be returned by an
  ordinary tool, which the caller (a code sandbox or the owner's own script) uses
  before passing the file ID to `create_draft` or `send_email`. This is the
  FutureSearch pattern and the "upload ticket" pattern of discussion #3325.
- For downloads, a short-lived URL (as in SEP-2532's redirect mode and ChatGPT's
  `download_url`) matches the direction of both drafts better than larger base64 tool
  results.
- The draft is not stable. Revisit this page when PR #1 merges, when the WG submits an
  Extensions Track SEP, or when a client fumi uses ships support.
