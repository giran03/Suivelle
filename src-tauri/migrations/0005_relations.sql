-- Phase 5: relations. One row per direction: a two-way relation stores the link under both the
-- forward property and its reverse property, so either side reads, filters and counts the same way.
-- Rows vanish with their property or record; a trashed record's links stay and are hidden on read.

CREATE TABLE db_relation (
    property_id    TEXT NOT NULL REFERENCES db_property(id) ON DELETE CASCADE,
    from_record_id TEXT NOT NULL REFERENCES db_record(id) ON DELETE CASCADE,
    to_record_id   TEXT NOT NULL REFERENCES db_record(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (property_id, from_record_id, to_record_id)
);

CREATE INDEX idx_db_relation_from ON db_relation(from_record_id, property_id, position);
CREATE INDEX idx_db_relation_to ON db_relation(to_record_id, property_id);
