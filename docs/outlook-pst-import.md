# Outlook PST import

Status: the converter is implemented and was run on the owner's two exports
(2026-11-28). The Worker transport that reads its output is not implemented yet. The
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
   readpst -j 0 -r -e -D -o out/ export.pst
   ```

   `-j 0` is required. By default readpst forks `4 x CPUs` children that share the
   parent's file offset; on 2026-11-28 every such run skipped a different 23 to 41
   Inbox items and lost the `Received` headers of others. Copy the PST to a local
   disk first; reading it from a mounted Windows folder was also unreliable.

2. Build the run:

   ```sh
   python3 tools/outlook-pst/pst-manifest.py --pst export.pst --readpst-dir out/ \
     --namespace outlook-<24 hex> --export-date 2026-11-28 --dest upload/
   ```

   The namespace is `outlook-` + the first 24 hex digits of SHA-256 of the account's
   sign-in address in lower case, like the `gmail-` namespaces
   ([historical Gmail import](gmail-import.md)). The address is typed only on the
   owner's computer.

3. Check the printed summary (items per folder, items with synthesized headers) against
   the folder counts Outlook shows. Upload `upload/<namespace>/<export-date>/` (the
   `items/` objects and `manifest.jsonl`) only after the owner's go.

## How items are paired

readpst writes the mail items of a folder as `1.eml`, `2.eml`, … in the folder's
descriptor order, and pypff lists the folder's items in the same order. The script
keeps the PST items whose message class is mail (`IPM`, `IPM.Note*`,
`IPM.Schedule.Meeting*`, `REPORT.IPM.Note*`, readpst's email types) and pairs them by
position. It stops with a fixed error instead of guessing:

- `folder_count_mismatch`: a folder's mail item count differs from its `.eml` files.
- `pair_mismatch`: the Message-ID of the PST item's transport headers differs from the
  `.eml`'s, or, for an item without transport headers, its subject is not in the
  `.eml`'s `Subject` (an RFC 2047 encoded subject is not compared).
- `item_without_time`, `duplicate_node_id`, `readpst_dir_not_one_store`,
  `pst_top_folder_not_found`, `invalid_namespace`, `invalid_export_date`.

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
  "converter": "readpst 0.6.76 -j 0 -r -e -D; pypff 20180714"
}
```

- `itemKind` is `note`, `schedule` (meeting requests and responses) or `report`
  (delivery reports).
- `headers` is `transport` when the PST kept the delivered headers
  (`PR_TRANSPORT_MESSAGE_HEADERS`) and `synthesized` when readpst built them from item
  properties (the owner's sent items).
- `deliveredAt` is the PST delivery time for an item with transport headers, else the
  client submit time, in UTC. It is the source for `received_at` and the
  `ingest/<date>/` key, never the `Date` header.
- The folder names are the PST's, possibly localized (for example `受信トレイ`).
- The object bytes are readpst's rebuilt MIME. readpst picks random MIME boundaries, so
  converting the same PST twice gives different `sha256` values; `pstNodeId` and
  `exportSha256` identify an item.

## Run of 2026-11-28 (not uploaded)

| Mailbox | Items | With synthesized headers |
| --- | --- | --- |
| University Microsoft 365 | 2,666 (Inbox 2,614, Sent Items 33, Junk Email 17, Archive 2) | 35 (Sent Items, Archive) |
| Personal Microsoft account | 89 (受信トレイ 2, Archive 87) | 0 |

Every item paired. The objects total about 346 MB and 4.8 MB.
