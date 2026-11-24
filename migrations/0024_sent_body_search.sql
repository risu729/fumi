-- Rebuildable private index of the bodies of fumi-sent mail
-- (docs/sent-body-search.md). Each operation's input.json stays authoritative.
-- Searches always join outbound_operations on the caller's principal, so these tables
-- are never read without it, and archive statements never read them. The running
-- Worker does not know the column; its new operations get NULL and are indexed by the
-- scheduled stage of the next version. The triggers fire only on statements the running
-- Worker never issues.
ALTER TABLE outbound_operations ADD COLUMN body_search_json TEXT;
-- Operations the scheduled stage still has to index or mark.
CREATE INDEX outbound_operations_body_unindexed ON outbound_operations (created_at)
  WHERE body_search_json IS NULL;
CREATE TABLE sent_search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES outbound_operations(operation_id),
  part TEXT NOT NULL CHECK (part = 'body'),
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE (operation_id, part, ordinal)
);
CREATE VIRTUAL TABLE sent_search_fts USING fts5(
  text, content='sent_search_chunks', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER sent_search_chunk_insert AFTER INSERT ON sent_search_chunks BEGIN
  INSERT INTO sent_search_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER sent_search_chunk_delete AFTER DELETE ON sent_search_chunks BEGIN
  INSERT INTO sent_search_fts(sent_search_fts,rowid,text) VALUES('delete',old.id,old.text);
END;
-- Deleting a sent record removes its chunks, so its body stops being searchable.
CREATE TRIGGER sent_search_operation_delete AFTER DELETE ON outbound_operations BEGIN
  DELETE FROM sent_search_chunks WHERE operation_id=old.operation_id;
END;
