-- Idempotency compares the caller's own request, not the composed message.
-- Composition (reply quote, forward block) reads the archived parent and can change
-- with fumi releases; a same-key retry must still find its existing operation.
-- Rows created before this column keep comparing input_hash.
ALTER TABLE outbound_operations ADD COLUMN request_hash TEXT;
