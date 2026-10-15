-- Canvas views: a freeform 2D board per view. Items are database records (real rows, so deleting a
-- record removes its card), free notes, or images; edges are arrows between two items.
CREATE TABLE IF NOT EXISTS db_canvas_item (
    id              TEXT PRIMARY KEY NOT NULL,
    view_id         TEXT NOT NULL REFERENCES db_view(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('record', 'note', 'image')),
    record_id       TEXT REFERENCES db_record(id) ON DELETE CASCADE,
    text            TEXT NOT NULL DEFAULT '',
    attachment_hash TEXT,
    x               REAL NOT NULL,
    y               REAL NOT NULL,
    w               REAL NOT NULL,
    h               REAL NOT NULL,
    z               INTEGER NOT NULL DEFAULT 0,
    color           TEXT
);
CREATE INDEX IF NOT EXISTS idx_db_canvas_item_view ON db_canvas_item(view_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_db_canvas_item_record
    ON db_canvas_item(view_id, record_id) WHERE record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS db_canvas_edge (
    id        TEXT PRIMARY KEY NOT NULL,
    view_id   TEXT NOT NULL REFERENCES db_view(id) ON DELETE CASCADE,
    from_item TEXT NOT NULL REFERENCES db_canvas_item(id) ON DELETE CASCADE,
    to_item   TEXT NOT NULL REFERENCES db_canvas_item(id) ON DELETE CASCADE,
    label     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_db_canvas_edge_view ON db_canvas_edge(view_id);
