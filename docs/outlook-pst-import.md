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
   when every item is written; it refuses an existing destination
   (`destination_exists`). Upload `upload/<namespace>/<export-date>/` (the
   `items/` objects and `manifest.jsonl`) only after the owner's go.

## How items are paired

readpst numbers every item of a folder in the folder's descriptor order (mail, other
items and subfolders share the counter), so the `.eml` files of a folder can have gaps.
pypff lists the folder's items in the same order. The script starts at the store's IPM
subtree (`PR_IPM_SUBTREE_ENTRYID`), keeps the PST items whose message class is mail
(`IPM`, `IPM.Note*`, `IPM.Schedule.Meeting*`, `REPORT.IPM.Note*`, readpst's email
types), and pairs them by rank with the `.eml` files in numeric order. Folder names
follow readpst's directory names: `/`, `\` and `:` become `_`, and a repeated sibling
name gets `1`, `2`, … appended. Every pair is checked, and the script stops with a
fixed error instead of guessing:

- `folder_count_mismatch`: a folder's mail item count differs from its `.eml` files.
- `pair_mismatch`: the item's `PR_INTERNET_MESSAGE_ID` differs from the `.eml`'s
  `Message-ID`; for an item with transport headers, their first `Received` line is not
  in the `.eml`'s headers; for an item without them, the `.eml`'s `Date` is more than a
  second from the item's submit time.
- `item_without_time`, `duplicate_node_id`, `readpst_dir_not_one_store`,
  `pst_ipm_subtree_missing`, `pst_ipm_subtree_not_found`, `unsafe_folder_name`,
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
  "converter": "readpst 0.6.76 -j 0 -r -e -D; pypff 20180714"
}
```

- `itemKind` is `note`, `schedule` (meeting requests and responses) or `report`
  (delivery reports).
- `headers` is `transport` when readpst used the delivered headers
  (`PR_TRANSPORT_MESSAGE_HEADERS`, when the block starts with a header readpst accepts,
  as in readpst's `valid_headers`) and `synthesized` when it built them from item
  properties (the owner's sent items, and any other item without usable transport
  headers).
- `deliveredAt` is the PST delivery time for an item with transport headers and the
  client submit time for a synthesized one (each falls back to the other), in UTC. It is
  the source for `received_at` and the `ingest/<date>/` key, never the `Date` header.
- The folder names are the PST's, possibly localized (for example `受信トレイ`).
- The object bytes are readpst's rebuilt MIME. readpst picks random MIME boundaries, so
  converting the same PST twice gives different `sha256` values; `pstNodeId` and
  `exportSha256` identify an item.

## Run of 2026-11-28 (not uploaded)

| Mailbox | Items | With synthesized headers |
| --- | --- | --- |
| University Microsoft 365 | 2,666 (Inbox 2,614, Sent Items 33, Junk Email 17, Archive 2) | 35 (Sent Items, Archive) |
| Personal Microsoft account | 89 (受信トレイ 2, Archive 87) | 0 |

Every item paired. The objects total about 354 MB. Skipped as non-mail: 87
`IPM.Appointment` (university); 69 `IPM.Contact`, 124 `IPM.AbchPerson` and 1
`IPM.Network` (personal).
