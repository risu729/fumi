#!/usr/bin/env python3
"""Convert one Outlook PST export into the objects and manifest of an `outlook-pst-v1` run.

ADR 0006 (docs/adr/0006-outlook-pst-import.md) and docs/outlook-pst-import.md describe
the format. Runs on the owner's computer, never in the Worker:

    python3 -s pst-manifest.py --pst export.pst --readpst-dir out/ \
        --namespace outlook-<24 hex> --export-date 2026-11-28 --dest upload/

`out/` must be the output of `readpst -j 0 -r -e -D -o out/ export.pst` for the same
file. In each folder, the mail items of the PST and readpst's `.eml` files (in numeric
order) are paired by rank: readpst numbers every item of a folder, mail or not, so the
mail files can have gaps. Each pair is checked, and any mismatch stops the script with
a fixed code before anything is written. Mail content is never printed.
"""
import argparse
import datetime
import email.utils
import hashlib
import json
import os
import re
import shutil
import sys

import pypff  # libpff Python bindings (python3-pypff)

CONVERTER = "readpst 0.6.76 -j 0 -r -e -D; pypff 20180714"
MAIL_CLASSES = (("REPORT.IPM.NOTE", "report"), ("IPM.SCHEDULE.MEETING", "schedule"), ("IPM.NOTE", "note"))
NAMESPACE = re.compile(r"^outlook-[0-9a-f]{24}$")
PR_MESSAGE_CLASS = 0x001A
PR_INTERNET_MESSAGE_ID = 0x1035
PR_IPM_SUBTREE_ENTRYID = 0x35E0
# readpst uses PR_TRANSPORT_MESSAGE_HEADERS only when the block starts with one of
# these (readpst.c valid_headers); otherwise it builds headers from item properties.
VALID_HEADER_STARTS = (
    "Content-Type:", "Date:", "From:", "MIME-Version:", "Microsoft Mail Internet Headers",
    "Received:", "Return-Path:", "Subject:", "To:", "X-ASG-Debug-ID:", "X-Barracuda-URL:", "X-x:",
)


class Stop(Exception):
    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code, self.detail = code, detail


def entry(item, entry_type):
    for r in range(item.number_of_record_sets):
        record_set = item.get_record_set(r)
        for e in range(record_set.number_of_entries):
            value = record_set.get_entry(e)
            if value.entry_type == entry_type:
                return value
    return None


def string_entry(item, entry_type):
    value = entry(item, entry_type)
    try:
        return value.data_as_string if value is not None else None
    except Exception:
        return None


def item_kind(message_class):
    upper = (message_class or "").upper()
    if upper == "IPM":
        return "note"
    for prefix, kind in MAIL_CLASSES:
        if upper.startswith(prefix):
            return kind
    return None


def normalize_message_id(value):
    """fumi's normalization (src/mail-identity.ts): first <id>, else one bare token."""
    if value is None:
        return None
    text = re.sub(r"\s+", " ", value).strip()
    bracket = re.search(r"<([^<>\s]+)>", text)
    if bracket:
        return bracket.group(1)
    return text if re.fullmatch(r"[^\s<>()]+", text) else None


def header_block(raw):
    end = raw.find(b"\r\n\r\n")
    if end < 0:
        end = raw.find(b"\n\n")
    return raw[: end if end >= 0 else len(raw)].decode("utf-8", "replace")


def header_value(block, name):
    unfolded = re.sub(r"\r?\n[ \t]+", " ", block)
    match = re.search(r"(?im)^" + re.escape(name) + r":[ \t]*(.*)$", unfolded)
    return match.group(1).strip() if match else None


def first_received(block):
    match = re.search(r"(?im)^received:.*$", block)
    return match.group(0).rstrip("\r") if match else None


def uses_transport_headers(text):
    if not text:
        return False
    for start in VALID_HEADER_STARTS:
        if text[: len(start)].lower() == start.lower():
            return True
    return False


def utc(value):
    if value is None:
        return None
    if value.tzinfo is None:  # libpff returns FILETIME values as naive UTC
        value = value.replace(tzinfo=datetime.timezone.utc)
    return value.astimezone(datetime.timezone.utc)


def iso(value):
    return utc(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def readpst_name(name):
    """readpst check_filename: `/`, `\\` and `:` become `_`."""
    return re.sub(r"[/\\:]", "_", name)


def folders(folder, path, dirs):
    """Yield (folder, PST path, readpst directory path) in readpst's order."""
    taken = set()
    for i in range(folder.number_of_sub_folders):
        sub = folder.get_sub_folder(i)
        name = sub.name or ""
        base = readpst_name(name)
        candidate, n = base, 0
        while candidate in taken:  # readpst mk_separate_dir appends 1, 2, ... to a taken name
            n += 1
            candidate = readpst_name(f"{name}{n}")
        if candidate in ("", ".", ".."):
            raise Stop("unsafe_folder_name")
        taken.add(candidate)
        yield sub, path + [name], dirs + [candidate]
        yield from folders(sub, path + [name], dirs + [candidate])


def ipm_subtree(pst):
    value = entry(pst.get_message_store(), PR_IPM_SUBTREE_ENTRYID)
    if value is None or not value.data or len(value.data) < 24:
        raise Stop("pst_ipm_subtree_missing")
    node_id = int.from_bytes(value.data[20:24], "little")
    root = pst.get_root_folder()
    matches = [root.get_sub_folder(i) for i in range(root.number_of_sub_folders)]
    matches = [f for f in matches if f.identifier == node_id]
    if len(matches) != 1:
        raise Stop("pst_ipm_subtree_not_found")
    return matches[0]


def plan(args):
    if not NAMESPACE.match(args.namespace):
        raise Stop("invalid_namespace")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.export_date):
        raise Stop("invalid_export_date")
    stores = [d for d in os.listdir(args.readpst_dir) if os.path.isdir(os.path.join(args.readpst_dir, d))]
    if len(stores) != 1:
        raise Stop("readpst_dir_not_one_store", str(len(stores)))
    store_dir = os.path.join(args.readpst_dir, stores[0])

    digest = hashlib.sha256()
    with open(args.pst, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)

    pst = pypff.file()
    pst.open(args.pst)
    items, skipped = [], {}
    for folder, path, dirs in folders(ipm_subtree(pst), [], []):
        where = "/".join(path)
        mail = []
        for i in range(folder.number_of_sub_messages):
            message = folder.get_sub_message(i)
            message_class = string_entry(message, PR_MESSAGE_CLASS)
            kind = item_kind(message_class)
            if kind:
                mail.append((message, kind))
            else:
                skipped[message_class or "unknown"] = skipped.get(message_class or "unknown", 0) + 1
        folder_dir = os.path.join(store_dir, *dirs)
        names = os.listdir(folder_dir) if os.path.isdir(folder_dir) else []
        emls = sorted((f for f in names if re.fullmatch(r"[1-9][0-9]*\.eml", f)), key=lambda f: int(f[:-4]))
        if len(emls) != len(mail):
            raise Stop("folder_count_mismatch", f"{where}: pst={len(mail)} readpst={len(emls)}")
        for rank, (message, kind) in enumerate(mail):
            eml_path = os.path.join(folder_dir, emls[rank])
            raw = open(eml_path, "rb").read()
            block = header_block(raw)
            label = f"{where} #{rank + 1}"
            expected_id = normalize_message_id(string_entry(message, PR_INTERNET_MESSAGE_ID))
            if expected_id != normalize_message_id(header_value(block, "Message-ID")):
                raise Stop("pair_mismatch", f"{label} message-id")
            transport = message.transport_headers or ""
            if uses_transport_headers(transport):
                received = first_received(transport)
                if received is not None and received not in block:
                    raise Stop("pair_mismatch", f"{label} received")
                headers = "transport"
                when = message.delivery_time or message.client_submit_time
            else:
                headers = "synthesized"
                when = message.client_submit_time or message.delivery_time
                date = header_value(block, "Date")
                if message.client_submit_time is not None and date is not None:
                    try:
                        parsed = email.utils.parsedate_to_datetime(date)
                    except (TypeError, ValueError):
                        raise Stop("pair_mismatch", f"{label} date")
                    if abs((utc(parsed) - utc(message.client_submit_time)).total_seconds()) > 1:
                        raise Stop("pair_mismatch", f"{label} date")
            if when is None:
                raise Stop("item_without_time", label)
            items.append({
                "source": eml_path, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                "pstNodeId": message.identifier, "folder": path, "itemKind": kind,
                "deliveredAt": iso(when), "headers": headers,
            })
    node_ids = [item["pstNodeId"] for item in items]
    if len(set(node_ids)) != len(node_ids):
        raise Stop("duplicate_node_id")
    return digest.hexdigest(), items, skipped


def write(args, export_sha256, items):
    prefix = f"{args.namespace}/{args.export_date}"
    final = os.path.join(args.dest, prefix)
    partial = final + ".partial"
    if os.path.exists(final) or os.path.exists(partial):
        raise Stop("destination_exists")
    os.makedirs(os.path.join(partial, "items"))
    with open(os.path.join(partial, "manifest.jsonl"), "w", encoding="utf-8", newline="\n") as out:
        for line, item in enumerate(items, start=1):
            name = f"{line:06d}.eml"
            shutil.copyfile(item["source"], os.path.join(partial, "items", name))
            record = {"line": line, "key": f"{prefix}/items/{name}"}
            record.update({k: v for k, v in item.items() if k != "source"})
            record.update({"exportSha256": export_sha256, "converter": CONVERTER})
            out.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.rename(partial, final)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    for name in ("--pst", "--readpst-dir", "--namespace", "--export-date", "--dest"):
        parser.add_argument(name, required=True)
    args = parser.parse_args()
    try:
        export_sha256, items, skipped = plan(args)
        write(args, export_sha256, items)
    except Stop as stop:
        print(json.dumps({"error": stop.code, "detail": stop.detail}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    summary = {}
    for item in items:
        counts = summary.setdefault("/".join(item["folder"]), {"items": 0, "synthesized": 0})
        counts["items"] += 1
        counts["synthesized"] += item["headers"] == "synthesized"
    print(json.dumps({"exportSha256": export_sha256, "items": len(items), "folders": summary,
                      "skippedNonMail": skipped}, ensure_ascii=False))


if __name__ == "__main__":
    main()
