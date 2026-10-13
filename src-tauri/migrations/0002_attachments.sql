-- Phase 2: minimal attachment core (content-addressed files on disk, metadata here).
-- The blob lives at attachments/<hash[0..2]>/<hash>; the path is derived, never stored.

CREATE TABLE attachment (
    id            TEXT PRIMARY KEY NOT NULL,
    workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    hash          TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size          INTEGER NOT NULL,
    revision      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (workspace_id, hash)
);

CREATE INDEX idx_attachment_hash ON attachment(hash);
