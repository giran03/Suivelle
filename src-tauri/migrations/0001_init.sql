-- Phase 0: workspace, page, block.
-- Every row carries workspace_id / revision / updated_at for future sync readiness.

CREATE TABLE workspace (
    id             TEXT PRIMARY KEY NOT NULL,
    name           TEXT NOT NULL,
    icon           TEXT,
    settings_json  TEXT NOT NULL DEFAULT '{}',
    schema_version INTEGER NOT NULL DEFAULT 1,
    revision       INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE page (
    id             TEXT PRIMARY KEY NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    parent_page_id TEXT REFERENCES page(id) ON DELETE CASCADE,
    title          TEXT NOT NULL DEFAULT '',
    icon           TEXT,
    cover          TEXT,
    position       REAL NOT NULL DEFAULT 0,
    favorite       INTEGER NOT NULL DEFAULT 0,
    archived       INTEGER NOT NULL DEFAULT 0,
    deleted_at     TEXT,
    revision       INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE INDEX idx_page_parent ON page(parent_page_id);
CREATE INDEX idx_page_workspace ON page(workspace_id);
CREATE INDEX idx_page_updated ON page(updated_at);

CREATE TABLE block (
    id              TEXT PRIMARY KEY NOT NULL,
    page_id         TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    parent_block_id TEXT REFERENCES block(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    position        REAL NOT NULL DEFAULT 0,
    data_json       TEXT NOT NULL DEFAULT '{}',
    schema_version  INTEGER NOT NULL DEFAULT 1,
    revision        INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_block_page ON block(page_id);
CREATE INDEX idx_block_parent ON block(parent_block_id);
CREATE INDEX idx_block_updated ON block(updated_at);
