-- Since the 2026-11-28 amendment to ADR 0006 an unsigned Gmail copy groups with a signed
-- copy of the same Message-ID, From and Date (docs/copy-grouping.md#mailbox-copies).
-- Rows are never rewritten, so unsigned Gmail rows indexed under the earlier rule stay
-- in a group of their own. This deletes those rows, and only those: an unsigned Gmail
-- row alone in its group while a signed row with the same Message-ID, From and Date
-- exists. Nothing else refers to their group IDs, and the scheduled backfill indexes
-- each original again under the rule the running Worker applies. Applied after the
-- Worker with that rule is live, so it does not re-index them under the earlier one.
DELETE FROM mail_identity WHERE raw_key IN (
  SELECT u.raw_key FROM mail_identity u JOIN archive_sources s ON s.raw_key = u.raw_key
  WHERE u.identity_version = 'identity-v2' AND u.status = 'complete'
    AND u.group_rule = 'message_id_from_date' AND s.source_kind = 'gmail'
    AND NOT EXISTS (
      SELECT 1 FROM mail_identity o WHERE o.group_id = u.group_id AND o.raw_key != u.raw_key
    )
    AND EXISTS (
      SELECT 1 FROM mail_identity g
      WHERE g.identity_version = 'identity-v2' AND g.status = 'complete'
        AND g.group_rule = 'message_id_dkim' AND g.message_id = u.message_id
        AND g.from_address = u.from_address AND g.header_date = u.header_date
    )
);
