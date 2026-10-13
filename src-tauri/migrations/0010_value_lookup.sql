-- Read filter/sort cells directly from the index, avoiding repeated table-row lookups.
-- This mirrors value_json once and trades disk space/write cost for measured query latency.
CREATE INDEX idx_db_value_cover ON db_value(record_id, property_id, value_json);
