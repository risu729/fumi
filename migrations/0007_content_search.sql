-- Rebuildable private text projection. Originals and MIME derivatives remain authoritative.
CREATE TABLE mail_search_documents (
  raw_key TEXT PRIMARY KEY,
  manifest_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'retry')),
  coverage_json TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mail_search_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_key TEXT NOT NULL,
  part TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  UNIQUE(raw_key, part, ordinal)
);
CREATE INDEX mail_search_chunks_source ON mail_search_chunks(raw_key);
CREATE VIRTUAL TABLE mail_search_fts USING fts5(text, content='mail_search_chunks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER mail_search_chunk_insert AFTER INSERT ON mail_search_chunks BEGIN
  INSERT INTO mail_search_fts(rowid,text) VALUES(new.id,new.text);
END;
CREATE TRIGGER mail_search_chunk_delete AFTER DELETE ON mail_search_chunks BEGIN
  INSERT INTO mail_search_fts(mail_search_fts,rowid,text) VALUES('delete',old.id,old.text);
END;
CREATE TRIGGER mail_search_extraction_delete AFTER DELETE ON mail_extractions BEGIN
  DELETE FROM mail_search_chunks WHERE raw_key=old.raw_key;
  DELETE FROM mail_search_documents WHERE raw_key=old.raw_key;
END;
CREATE TRIGGER mail_search_extraction_update AFTER UPDATE ON mail_extractions
WHEN new.status != 'complete' OR new.manifest_key IS NOT old.manifest_key BEGIN
  DELETE FROM mail_search_chunks WHERE raw_key=old.raw_key;
  DELETE FROM mail_search_documents WHERE raw_key=old.raw_key;
END;
