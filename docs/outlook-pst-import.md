# Outlook PST import

Status: the converter is implemented and was run on the owner's two exports
(2026-11-28). The catalog admits the `mailbox_export` source kind
([archive catalog](archive-catalog.md#identity-and-evidence)), and the
[Worker transport](#worker-transport) that reads the converter's output is
implemented and tested with synthetic items; it has not run in production. Readers do
not show PST folders yet, and the grouping rule of the ADR is not implemented. The
design is [ADR 0006](adr/0006-outlook-pst-import.md).

The converter turns one Outlook `.pst` export into the objects and the manifest of an
`outlook-pst-v1` run. It runs on the owner's computer, never in the Worker, because the
PST files hold whole mailboxes and the tools are native libraries.

## Tools

- libpst `readpst` 0.6.76 (Debian/Ubuntu package `pst-utils`) builds one `.eml` per
  item.
- libpff 20180714 Python bindings (`python3-pypff`) read the PST node ID, message
  class, delivery and submit times, and transport headers, which readpst does not
  print.

On Ubuntu or WSL, `apt install pst-utils python3-pypff`. Without root, the jammy debs
(`pst-utils`, `libpst4`, `libgsf-1-114`, `python3-pypff`, `libpff1`, `libbfio1`) can be
unpacked with `dpkg-deb -x <deb> <dir>` and used with `LD_LIBRARY_PATH` and
`PYTHONPATH` pointing into `<dir>`; that is how the 2026-11-28 run worked.

## Steps

1. Convert with forking turned off:

   ```sh
   readpst -j 0 -e -D -o out/ export.pst
   ```

   `-e` writes one `.eml` per item in the folder tree (`-r` would add nothing).
   `-j 0` is required. By default readpst forks `4 x CPUs` children that share the
   parent's file offset; on 2026-11-28 every such run skipped a different 23 to 41
   Inbox items and lost the `Received` headers of others. Copy the PST to a local
   disk first; reading it from a mounted Windows folder was also unreliable.

2. Build the run:

   ```sh
   python3 -s tools/outlook-pst/pst-manifest.py --pst export.pst --readpst-dir out/ \
     --namespace outlook-<24 hex> --export-date 2026-11-28 --dest upload/
   ```

   The namespace is `outlook-` + the first 24 hex digits of SHA-256 of the account's
   sign-in address in lower case, like the `gmail-` namespaces
   ([historical Gmail import](gmail-import.md)). The address is typed only on the
   owner's computer.

3. Check the printed summary (items per folder, items with synthesized headers, and
   non-mail items skipped per message class) against the folder counts Outlook shows.
   The script writes `<dest>/<namespace>/<export-date>.partial/` and renames it only
   when every item is written; it refuses an existing destination or a `.partial` left
   by an interrupted run (`destination_exists`). Remove a stale `.partial` by hand.
   Upload `upload/<namespace>/<export-date>/` (the `items/` objects and
   `manifest.jsonl`) only after the owner's go.

## How items are paired

readpst numbers every item of a folder in the folder's descriptor order (mail, other
items and subfolders share the counter), so the `.eml` files of a folder can have gaps.
pypff lists the folder's items in the same order. The script starts at the store's IPM
subtree (`PR_IPM_SUBTREE_ENTRYID`), including mail directly in it, keeps the PST items
whose message class is mail
(`IPM`, `IPM.Note*`, `IPM.Schedule.Meeting*`, `REPORT.IPM.Note*`, readpst's email
types), and pairs them by rank with the `.eml` files in numeric order. Folder names
follow readpst's directory names: `/`, `\` and `:` become `_`. readpst appends `1`,
`2`, … to a repeated sibling name only among the folders it creates, which pypff cannot
predict, so a repeated name (ignoring case) stops the script. Every pair is checked,
and the script stops with a fixed error instead of guessing:

- `folder_count_mismatch`: a folder's mail item count differs from its `.eml` files.
- `pair_mismatch`: the item's `PR_INTERNET_MESSAGE_ID` differs from the `.eml`'s
  `Message-ID`; for an item with transport headers, their first `Received` line is not
  in the `.eml`'s headers; for an item without them, the `.eml`'s `Date` is more than a
  second from the item's submit time.
- `pair_unverified`: none of these checks could run for an item (no
  `PR_INTERNET_MESSAGE_ID`, no `Received` line, no submit time).
- `item_without_time`, `duplicate_node_id`, `readpst_dir_not_one_store`,
  `pst_ipm_subtree_missing`, `pst_ipm_subtree_not_found`, `unsafe_folder_name`,
  `ambiguous_folder_name`,
  `invalid_namespace`, `invalid_export_date`, `destination_exists`.

It prints no mail content, only counts and the export's SHA-256.

## Manifest

`manifest.jsonl` has one JSON line per item, in folder order:

```json
{
  "line": 1,
  "key": "outlook-<24 hex>/2026-11-28/items/000001.eml",
  "size": 12345,
  "sha256": "<64 hex of the object>",
  "pstNodeId": 2097220,
  "folder": ["Inbox"],
  "itemKind": "note",
  "deliveredAt": "2026-01-02T03:04:05.678Z",
  "headers": "transport",
  "exportSha256": "<64 hex of the .pst file>",
  "converter": "readpst 0.6.76 -j 0 -e -D; pypff 20180714"
}
```

- `itemKind` is `note`, `schedule` (meeting requests and responses) or `report`
  (delivery reports).
- `headers` is `transport` when readpst used the delivered headers
  (`PR_TRANSPORT_MESSAGE_HEADERS`, when the block starts with a header readpst accepts:
  readpst's `valid_headers`, `Field:` or `Field:` folded as CRLF TAB) and `synthesized`
  when it built them from item properties (the owner's sent items, and any other item
  without usable transport headers).
- `deliveredAt` is the PST delivery time for an item with transport headers and the
  client submit time for a synthesized one (each falls back to the other), in UTC. It is
  the source for `received_at` and the `ingest/<date>/` key, never the `Date` header.
- The folder names are the PST's, possibly localized (for example `受信トレイ`).
- The object bytes are readpst's rebuilt MIME. readpst picks random MIME boundaries, so
  converting the same PST twice gives different `sha256` values; `pstNodeId` and
  `exportSha256` identify an item.

## Worker transport

[`src/pst-import.ts`](../src/pst-import.ts) reads one converted export and stores every
manifest line's object as its own original of source kind `mailbox_export`, with the
same durability rules as the
[Takeout transport](gmail-import.md#google-takeout-transport): a lease, a checkpoint
that advances only in the batch that records the line's outcome, one Workflow instance
at a time and a `mime-v1` processing job per imported item.

### Configuration

An operator uploads `<namespace>/<export-date>/` (the `items/` objects and
`manifest.jsonl`) to the private bucket `fumi-takeout` (binding `TAKEOUT_ARCHIVE`) at
the keys the manifest names, and sets the optional Worker secret `PST_IMPORT_CONFIG`.
Only the Workflow reads it; HTTP and mail cannot configure a run:

```json
{
  "runId": "pst-university-2026-11-28",
  "accountNamespace": "outlook-<24 hex>",
  "manifest": { "key": "outlook-<24 hex>/2026-11-28/manifest.jsonl", "size": 123456 },
  "onConflict": "stop",
  "attempt": 0,
  "skip": []
}
```

- The manifest key must be `<accountNamespace>/<YYYY-MM-DD>/manifest.jsonl`, and the
  object must have exactly the configured size, or the run stops
  (`pst_manifest_size_mismatch`, `pst_manifest_missing`).
- The five-minute cron starts the `PstImport` Workflow (`fumi-pst-import`, concurrency
  1) for a configured run that is still `running`. Each step processes at most 50 lines
  or 128 MiB of items. A step that fails after five retries stops the run with its
  fixed code. One secret configures one run; the next mailbox is a new run with a new
  `runId`, after the first one completes.
- `attempt` resumes a stopped run with the same mailbox and manifest; `skip` lists
  manifest line numbers an operator reviewed and chose not to import (`skipped`).

### Per line

1. The line must match the manifest format exactly (no other fields; `deliveredAt` in
   `YYYY-MM-DDTHH:MM:SS.mmmZ`; folder names without control characters, at most 32
   segments of 255 characters and 4 KiB as JSON), have the next line number, the key
   `<prefix>/items/<line, 6 digits>.eml`, and the same `exportSha256` as every earlier
   line of the run. Otherwise the run stops at that line: `pst_manifest_invalid`,
   `pst_manifest_line_mismatch`, `pst_manifest_key_mismatch`, `pst_export_mismatch`,
   `pst_manifest_line_too_long`.

2. Ingest ID = UUID from SHA-256(`["outlook-pst-v1", namespace, pstNodeId]`); raw key
   `ingest/<deliveredAt date>/<ingest ID>/raw.eml`.

3. If `pst_messages` already holds that mailbox and node ID, nothing is stored. The
   outcome is `verified` when the stored original came from the same export with the
   same folder, kind, headers and delivery time (a converter replay gives other bytes,
   so the raw SHA-256 is not compared), and `conflict` otherwise; with
   `onConflict: "stop"` a conflict stops the run (`pst_source_conflict`) after
   recording it. A stored original that is not present and valid stops the run
   (`pst_existing_source_invalid`).

4. Otherwise the object must exist with the manifest's size and SHA-256
   (`pst_object_missing`, `pst_object_size_mismatch`, `pst_object_sha256_mismatch`).
   Items over 32 MiB are hashed and stored in two streamed passes. The raw object gets
   metadata `sourceKind: mailbox_export`, `pstNamespace`, `pstNodeId` and
   `eventNotifications: 0`, and the receipt is `outlook-pst-v1`:

   ```json
   {
     "schemaVersion": "outlook-pst-v1",
     "accountNamespace": "outlook-<24 hex>",
     "pstNodeId": 2097220,
     "deliveredAt": "2026-01-02T03:04:05.678Z",
     "importedAt": "2026-11-28T12:00:00.000Z",
     "rawKey": "ingest/2026-01-02/<ingest ID>/raw.eml",
     "rawSize": 12345,
     "rawSha256": "<64 hex>",
     "runId": "pst-university-2026-11-28",
     "objectKey": "outlook-<24 hex>/2026-11-28/items/000001.eml",
     "manifestLine": 1,
     "exportSha256": "<64 hex>",
     "converter": "readpst 0.6.76 -j 0 -e -D; pypff 20180714",
     "folder": ["Inbox"],
     "itemKind": "note",
     "headers": "transport"
   }
   ```

   `received_at` is `deliveredAt`. The catalog row and its `pst_messages` row (raw key,
   mailbox, node ID, folder JSON, kind, headers, delivery time, export, run and line)
   commit together, and the [reconciler](archive-catalog.md) restores both from the
   receipt.

### Tables

- `pst_import_runs`: configuration, manifest size, `next_offset` and `next_line`, the
  run's `export_sha256`, status, `stop_code` and `stop_line`, lease and Workflow
  instance.
- `pst_import_items`: one row per manifest line with `imported`, `verified`,
  `conflict` or `skipped`, the node ID and the stored original's key, size and SHA-256.
- `pst_messages`: one row per PST original, unique per mailbox and node ID.

Useful checks after a run: `SELECT status,stop_code,stop_line,next_line FROM
pst_import_runs`, `SELECT outcome,COUNT(*) FROM pst_import_items WHERE run_id=? GROUP
BY outcome`, and the items' `raw_key` joined to `mail_extractions` and
`processing_jobs`.

## Run of 2026-11-28 (not uploaded)

| Mailbox | Items | With synthesized headers |
| --- | --- | --- |
| University Microsoft 365 | 2,666 (Inbox 2,614, Sent Items 33, Junk Email 17, Archive 2) | 35 (Sent Items, Archive) |
| Personal Microsoft account | 89 (受信トレイ 2, Archive 87) | 0 |

Every item paired. The objects total about 354 MB. Skipped as non-mail: 87
`IPM.Appointment` (university); 69 `IPM.Contact`, 124 `IPM.AbchPerson` and 1
`IPM.Network` (personal).
