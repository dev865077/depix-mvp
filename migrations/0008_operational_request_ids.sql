-- Persiste os requestIds operacionais que ligam logs do Worker aos registros
-- financeiros usados no coletor de evidencia da release 0.1.

ALTER TABLE deposits ADD COLUMN created_request_id TEXT;
ALTER TABLE deposit_events ADD COLUMN request_id TEXT;

CREATE INDEX IF NOT EXISTS deposits_created_request_id_idx ON deposits (created_request_id);
CREATE INDEX IF NOT EXISTS deposit_events_request_id_idx ON deposit_events (request_id);
