-- search_emails and search_email_ids walk the archive newest first from the page token
-- instead of collapsing every matching original on every page
-- (docs/copy-grouping.md#reads). The expressions must stay identical to the page order
-- in src/mail-read.ts, or SQLite cannot use this index. An index only: a running Worker
-- without it reads the same rows, and its writes maintain it.
CREATE INDEX archive_sources_search_order ON archive_sources (COALESCE(received_at,''), external_id);
