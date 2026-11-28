-- Since the 2026-11-28 amendment to ADR 0006 an unsigned Gmail copy groups with a signed
-- copy of the same Message-ID, From and Date (docs/copy-grouping.md#mailbox-copies).
-- Rows are never rewritten, so unsigned Gmail rows indexed under the earlier rule stay
-- in a group of their own. This deletes those rows, and only those: a present unsigned
-- Gmail original's row that is alone in its group while a signed row with the same
-- Message-ID, From and Date exists and every signed row of that Message-ID is in one
-- group (the condition the rule itself applies). Nothing else refers to their group IDs.
-- The running Worker indexes each of them again on its next scheduled run: a full pass
-- is requested below, as requestFullScan does. Under the earlier rule that would write
-- the same row as before, so the migration is harmless either way, and it is applied
-- after the Worker with the new rule is live.
DELETE FROM mail_identity WHERE raw_key IN (
  SELECT u.raw_key FROM mail_identity u JOIN archive_sources s ON s.raw_key = u.raw_key
  WHERE u.identity_version = 'identity-v2' AND u.status = 'complete'
    AND u.group_rule = 'message_id_from_date' AND s.source_kind = 'gmail'
    AND s.raw_state = 'present' AND s.raw_sha256 IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM mail_identity o WHERE o.group_id = u.group_id AND o.raw_key != u.raw_key
    )
    AND EXISTS (
      SELECT 1 FROM mail_identity g
      WHERE g.identity_version = 'identity-v2' AND g.status = 'complete'
        AND g.group_rule = 'message_id_dkim' AND g.message_id = u.message_id
        AND g.from_address = u.from_address AND g.header_date = u.header_date
        AND NOT EXISTS (
          SELECT 1 FROM mail_identity d
          WHERE d.identity_version = 'identity-v2' AND d.status = 'complete'
            AND d.group_rule = 'message_id_dkim' AND d.message_id = u.message_id
            AND d.group_id != g.group_id
        )
    )
);
UPDATE catalog_scans SET next_full_at = MIN(next_full_at, 0) - 1 WHERE name = 'mail_identity';
