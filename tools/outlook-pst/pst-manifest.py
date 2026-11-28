#!/usr/bin/env python3
"""Convert one Outlook PST export into the objects and manifest of an `outlook-pst-v1` run.

ADR 0006 (docs/adr/0006-outlook-pst-import.md) and docs/outlook-pst-import.md describe
the format. Runs on the owner's computer, never in the Worker:

    python3 -I pst-manifest.py --pst export.pst --readpst-dir out/ \
        --namespace outlook-<24 hex> --export-date 2026-11-28 --dest upload/

`out/` must be the output of `readpst -j 0 -r -e -D -o out/ export.pst` for the same
file. Each mail item of readpst is paired with the PST item at the same position in the
same folder (both follow the folder's descriptor order), and the pair is checked: the
Message-ID of the transport headers, or the subject when there are none. Any mismatch
stops the script. Mail content is never printed.
"""
import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import sys

import pypff  # libpff Python bindings (python3-pypff)

MAIL_CLASSES = (("REPORT.IPM.NOTE", "report"), ("IPM.SCHEDULE.MEETING", "schedule"), ("IPM.NOTE", "note"))
NAMESPACE = re.compile(r"^outlook-[0-9a-f]{24}$")


def item_kind(message_class):
    upper = (message_class or "").upper()
    if upper == "IPM":
        return "note"
    for prefix, kind in MAIL_CLASSES:
        if upper.startswith(prefix):
            return kind
    return None


def message_class(message):
    for r in range(message.number_of_record_sets):
        record_set = message.get_record_set(r)
        for e in range(record_set.number_of_entries):
            entry = record_set.get_entry(e)
            if entry.entry_type == 0x001A:
                return entry.data_as_string
    return None


def header_message_id(text):
    """First Message-ID of a header block, without angle brackets, as fumi normalizes it."""
    unfolded = re.sub(r"\r?\n[ \t]+", " ", text or "")
    match = re.search(r"(?im)^message-id:[ \t]*(.*)$", unfolded)
    if not match:
        return None
    value = re.sub(r"\s+", " ", match.group(1)).strip()
    bracket = re.search(r"<([^<>\s]+)>", value)
    if bracket:
        return bracket.group(1)
    return value if re.fullmatch(r"[^\s<>()]+", value) else None


def eml_header(raw, name):
    end = raw.find(b"\r\n\r\n")
    if end < 0:
        end = raw.find(b"\n\n")
    block = raw[: end if end >= 0 else len(raw)].decode("utf-8", "replace")
    unfolded = re.sub(r"\r?\n[ \t]+", " ", block)
    match = re.search(r"(?im)^" + re.escape(name) + r":[ \t]*(.*)$", unfolded)
    return match.group(1).strip() if match else None


def iso(value):
    if value is None:
        return None
    if value.tzinfo is None:  # libpff returns FILETIME values as naive UTC
        value = value.replace(tzinfo=datetime.timezone.utc)
    return value.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def folders(folder, path):
    for i in range(folder.number_of_sub_folders):
        sub = folder.get_sub_folder(i)
        sub_path = path + [sub.name or ""]
        yield sub, sub_path
        yield from folders(sub, sub_path)


def fail(code, detail=""):
    print(json.dumps({"error": code, "detail": detail}), file=sys.stderr)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pst", required=True)
    parser.add_argument("--readpst-dir", required=True)
    parser.add_argument("--namespace", required=True)
    parser.add_argument("--export-date", required=True)
    parser.add_argument("--dest", required=True)
    args = parser.parse_args()
    if not NAMESPACE.match(args.namespace):
        fail("invalid_namespace")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.export_date):
        fail("invalid_export_date")

    digest = hashlib.sha256()
    with open(args.pst, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    export_sha256 = digest.hexdigest()

    stores = [d for d in os.listdir(args.readpst_dir) if os.path.isdir(os.path.join(args.readpst_dir, d))]
    if len(stores) != 1:
        fail("readpst_dir_not_one_store", str(len(stores)))
    store_dir = os.path.join(args.readpst_dir, stores[0])

    prefix = f"{args.namespace}/{args.export_date}"
    items_dir = os.path.join(args.dest, prefix, "items")
    os.makedirs(items_dir, exist_ok=False)

    pst = pypff.file()
    pst.open(args.pst)
    root = pst.get_root_folder()
    tops = [root.get_sub_folder(i) for i in range(root.number_of_sub_folders)]
    tops = [t for t in tops if (t.name or "").lower() == "top of outlook data file"]
    if len(tops) != 1:
        fail("pst_top_folder_not_found")

    lines = []
    used_files = set()
    for folder, path in folders(tops[0], []):
        mail = []
        for i in range(folder.number_of_sub_messages):
            message = folder.get_sub_message(i)
            kind = item_kind(message_class(message))
            if kind:
                mail.append((message, kind))
        folder_dir = os.path.join(store_dir, *path)
        emls = sorted(
            (f for f in os.listdir(folder_dir) if f.endswith(".eml")) if os.path.isdir(folder_dir) else [],
            key=lambda f: int(f[:-4]),
        )
        if len(emls) != len(mail) or emls != [f"{n}.eml" for n in range(1, len(mail) + 1)]:
            fail("folder_count_mismatch", f"{'/'.join(path)}: pst={len(mail)} readpst={len(emls)}")
        for position, (message, kind) in enumerate(mail):
            eml_path = os.path.join(folder_dir, emls[position])
            raw = open(eml_path, "rb").read()
            transport = message.transport_headers or ""
            if transport.strip():
                expected = header_message_id(transport)
                if expected is None or expected != header_message_id("Message-ID: " + (eml_header(raw, "Message-ID") or "")):
                    fail("pair_mismatch", f"{'/'.join(path)} #{position + 1} message-id")
                headers = "transport"
            else:
                subject = (message.subject or "").strip()
                eml_subject = eml_header(raw, "Subject") or ""
                if subject and subject not in eml_subject and "=?" not in eml_subject:
                    fail("pair_mismatch", f"{'/'.join(path)} #{position + 1} subject")
                headers = "synthesized"
            delivered = message.delivery_time if headers == "transport" else None
            delivered = delivered or message.client_submit_time or message.delivery_time
            if delivered is None:
                fail("item_without_time", f"{'/'.join(path)} #{position + 1}")
            line = len(lines) + 1
            key = f"{prefix}/items/{line:06d}.eml"
            shutil.copyfile(eml_path, os.path.join(args.dest, key))
            used_files.add(eml_path)
            lines.append({
                "line": line,
                "key": key,
                "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "pstNodeId": message.identifier,
                "folder": path,
                "itemKind": kind,
                "deliveredAt": iso(delivered),
                "headers": headers,
                "exportSha256": export_sha256,
                "converter": "readpst 0.6.76 -j 0 -r -e -D; pypff 20180714",
            })

    node_ids = [entry["pstNodeId"] for entry in lines]
    if len(set(node_ids)) != len(node_ids):
        fail("duplicate_node_id")
    with open(os.path.join(args.dest, prefix, "manifest.jsonl"), "w", encoding="utf-8", newline="\n") as out:
        for entry in lines:
            out.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    summary = {}
    for entry in lines:
        name = "/".join(entry["folder"])
        summary.setdefault(name, {"items": 0, "synthesized": 0})
        summary[name]["items"] += 1
        summary[name]["synthesized"] += entry["headers"] == "synthesized"
    print(json.dumps({"exportSha256": export_sha256, "items": len(lines), "folders": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
