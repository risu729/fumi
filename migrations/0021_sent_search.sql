-- Search fields of fumi-sent mail (docs/agent-mail.md#searching-sent-mail). The subject
-- and attachment count were only in each operation's R2 input.json; search_emails needs
-- them in D1. Both stay NULL until projected: the Worker writes them with each new
-- operation, and a bounded scheduled step projects older rows, including rows a
-- running Worker without these columns inserts. attachment_count -1 marks an
-- operation whose input.json could not be verified; its subject stays NULL.
ALTER TABLE outbound_operations ADD COLUMN subject TEXT;
ALTER TABLE outbound_operations ADD COLUMN attachment_count INTEGER;
-- One principal's sends, newest first, for the merged search_emails order.
CREATE INDEX outbound_operations_sent ON outbound_operations (principal_id, created_at, operation_id);
-- Rows the scheduled projection still has to read.
CREATE INDEX outbound_operations_unprojected ON outbound_operations (created_at)
  WHERE attachment_count IS NULL;
