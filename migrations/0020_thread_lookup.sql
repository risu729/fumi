-- Thread reads look up their messages by key instead of scanning the archive
-- (docs/agent-mail.md#thread-reads). Indexes only: a running Worker without them
-- reads the same rows, and its writes maintain them.
-- A later migration that rebuilds archive_sources or mail_extractions (as 0008 and
-- 0014 did) must recreate these indexes; the query-plan test in
-- test/mail-thread.test.ts fails if one is missing.
-- Message IDs carry only the external ID; every read resolves it through this index.
CREATE INDEX archive_sources_external_id ON archive_sources (external_id);
-- Live header links. The expressions must stay identical to readMailThread's in
-- src/mail-read.ts, or SQLite cannot use these indexes. json_valid keeps a malformed
-- metadata_json from failing this migration or a later extraction write.
CREATE INDEX mail_extractions_message_id ON mail_extractions (
  (CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.messageId') END)
);
CREATE INDEX mail_extractions_in_reply_to ON mail_extractions (
  (CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json,'$.inReplyTo') END)
);
