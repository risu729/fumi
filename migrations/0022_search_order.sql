-- search_emails and search_email_ids walk the archive newest first from the page token
-- instead of collapsing every matching original on every page
-- (docs/copy-grouping.md#page-cost). The walk names this index with INDEXED BY, and the
-- expressions must stay identical to its ORDER BY in src/mail-read.ts. An index only:
-- the running Worker does not read it, and its writes maintain it.
CREATE INDEX archive_sources_search_order ON archive_sources (COALESCE(received_at,''), external_id);
