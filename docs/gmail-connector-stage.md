# Native staging for connected Gmail originals

`POST /api/admin/gmail-import/stage` is an optional operator transport for small
connector originals. It uses the existing private R2 binding instead of relaying
each storage operation through the Cloudflare control API. Implementation and
synthetic tests do not establish a production throughput improvement.

The existing HTTP handler verifies Access JWT and `mail:import` before the body
is read. The endpoint also requires an exact API origin and explicit matching
`Origin` header, its exact path, no query, JSON content type and no content
encoding. It is unavailable without a valid server-owned `GMAIL_IMPORT_CONFIG`
whose transport is `connector`. It does not accept credentials, bucket names,
object keys, destinations or a new import scope.

The operator attests that these are exact originals and provider metadata from
the verified connected account. The endpoint verifies that attestation's
configuration identity and bytes, not the Gmail account itself. A self-asserted
account hash is not provider authentication. Use the existing account-profile
verification and frozen-scope listing before staging.

## Request and receipt

Send UTF-8 JSON with `Content-Type: application/json`, an explicit matching
`Origin`, and `X-Fumi-Stage-SHA256` equal to the lowercase SHA-256 of the **exact
request body bytes**. Its strict shape is:

```json
{
  "schemaVersion": 1,
  "importId": "synthetic-run",
  "accountHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "scope": {
    "accountNamespace": "synthetic-account",
    "before": 1800000000,
    "includeSpamTrash": false
  },
  "entries": [
    {
      "id": "synthetic-message",
      "threadId": "synthetic-thread",
      "internalDate": "1700000000000",
      "labelIds": ["SENT"],
      "raw": "",
      "rawSize": 0,
      "rawSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ]
}
```

`scope.after` is optional. Import ID, account hash and every scope field must
exactly match server configuration. There must be one through ten distinct
message IDs, bounded provider identifiers and unique retained labels. Internal
dates must be within the configured half-open range; excluded SPAM/TRASH labels
are rejected. Raw data is canonical base64url, optionally padded, with decoded
length and SHA-256 matching the entry. No MIME parsing or reconstruction occurs.

Actual request bytes are limited to 2,500,000, including JSON and base64 overhead;
a declared length must agree. Reading has a fifteen-second whole-stream deadline,
at most 4,096 chunks and at most eight consecutive empty chunks. Validate, decode
and hash the **entire batch before any write**. Large originals retain the existing
bounded Cloudflare chunk-transfer path and its 25 MiB original limit.

On full success the response contains only `schemaVersion:1`, the verified
`requestSha256`, and ordered `staged` receipts with `id`, `size` and `sha256`.
Every response is no-store. Fixed errors omit raw content, metadata and provider
exceptions. A non-success response is not an acknowledgement of any entry.

## Immutable storage and recovery

The server derives the same `imports/gmail-connector-v1/<configured importId>`
prefix and canonical raw/metadata keys as the existing connector helper. Metadata
property order remains `schemaVersion`, `accountHash`, `id`, `threadId`,
`internalDate`, `labelIds`, `rawSize`, `rawSha256` for immutable compatibility.
Both raw and metadata use conditional create-once writes with a supplied SHA-256,
followed by complete size/hash readback. Existing mismatched bytes are a conflict;
they are never overwritten. At most five entry tasks run together under one
thirty-second storage deadline, and all started tasks settle before returning.

A failed or timed-out request can leave a partial immutable stage. A storage
operation already in flight may commit after its deadline. Retrying the exact
batch is safe because it conditionally creates missing objects and verifies
existing ones. It must not silently skip an entry or rewrite conflicting metadata.

The single collector still owns page ordering. It must verify every small receipt,
retain the existing approved-original reuse and large-transfer paths, then commit
the existing immutable page manifest and durable local checkpoint. This endpoint
does not create a page manifest, advance a cursor, import into the catalog, start
processing, emit events or send notifications. The existing historical importer
independently reads and verifies the staged bytes and retains historical provenance
and notification suppression.

Keep one collector writer and at most one native-stage HTTP batch in flight.
Relay private payloads through a bounded local file and the already authenticated
fixed-origin operator client; raw MIME must not enter shell arguments or logs.
Verify a bounded adopted batch against the measured baseline after independent
review and deployment. Retain the existing transport if there is no meaningful
benefit. No new authentication material is required.

References:
[R2 binding operations and conditions](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
and
[atomic conditional writes and consistency](https://developers.cloudflare.com/r2/reference/consistency/).
