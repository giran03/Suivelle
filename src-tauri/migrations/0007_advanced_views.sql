-- Phase 8: record templates and dashboards.
--
-- A record template is a reusable starting point for new records in one database: a default
-- title, property values and body blocks. A dashboard is a page (kind 'dashboard') whose body
-- is a grid of widgets; the layout is one JSON document validated on every save.

CREATE TABLE db_record_template (
    id          TEXT PRIMARY KEY NOT NULL,
    database_id TEXT NOT NULL REFERENCES db_database(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    values_json TEXT NOT NULL DEFAULT '{}',
    body_json   TEXT NOT NULL DEFAULT '[]',
    is_default  INTEGER NOT NULL DEFAULT 0,
    position    REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX idx_db_record_template_database ON db_record_template(database_id, position);

CREATE TABLE dashboard (
    page_id      TEXT PRIMARY KEY NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    layout_json  TEXT NOT NULL DEFAULT '{}',
    revision     INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
