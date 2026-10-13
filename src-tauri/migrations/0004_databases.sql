-- Phase 4: databases. A database is a page (kind 'database'); each record is a page
-- (kind 'record') that lives under its database page, so trash, search, backlinks and the
-- block editor all work on records without special cases. The database's name is its page title,
-- and a record's title is its page title (the "title" property has no stored value).

ALTER TABLE page ADD COLUMN kind TEXT NOT NULL DEFAULT 'page';
CREATE INDEX idx_page_kind ON page(kind);

CREATE TABLE db_database (
    id             TEXT PRIMARY KEY NOT NULL,
    page_id        TEXT NOT NULL UNIQUE REFERENCES page(id) ON DELETE CASCADE,
    workspace_id   TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    next_unique_id INTEGER NOT NULL DEFAULT 1,
    revision       INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE db_property (
    id          TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES db_database(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    config_json TEXT NOT NULL DEFAULT '{}',
    position    REAL NOT NULL,
    revision    INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_db_property_database ON db_property(database_id);

CREATE TABLE db_record (
    id          TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES db_database(id) ON DELETE CASCADE,
    page_id     TEXT NOT NULL UNIQUE REFERENCES page(id) ON DELETE CASCADE,
    unique_id   INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX idx_db_record_database ON db_record(database_id, unique_id);

-- One row per non-empty cell. Empty cells have no row.
CREATE TABLE db_value (
    record_id   TEXT NOT NULL REFERENCES db_record(id) ON DELETE CASCADE,
    property_id TEXT NOT NULL REFERENCES db_property(id) ON DELETE CASCADE,
    value_json  TEXT NOT NULL,
    PRIMARY KEY (record_id, property_id)
);

CREATE INDEX idx_db_value_property ON db_value(property_id, record_id);

CREATE TABLE db_view (
    id          TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES db_database(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'table',
    config_json TEXT NOT NULL DEFAULT '{}',
    position    REAL NOT NULL DEFAULT 0,
    revision    INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_db_view_database ON db_view(database_id);
