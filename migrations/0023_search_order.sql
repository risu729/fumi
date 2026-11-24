-- search_emails and search_email_ids walk the archive newest first from the page token
-- instead of collapsing every matching original on every page
-- (docs/copy-grouping.md#page-cost). The walk names these indexes with INDEXED BY, and
-- the expressions must stay identical to its ORDER BY in src/mail-read.ts. Indexes only:
-- the running Worker does not read them, and its writes maintain them.
CREATE INDEX archive_sources_search_order ON archive_sources (COALESCE(received_at,''), external_id);
-- An archive_source search walks the same order within its source kind.
CREATE INDEX archive_sources_search_kind_order ON archive_sources (
  source_kind, COALESCE(received_at,''), external_id
);
