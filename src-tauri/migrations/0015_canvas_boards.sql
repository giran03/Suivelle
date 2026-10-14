-- Canvas boards: freeform whiteboards that belong to the workspace rather than to a database. Cards
-- are pages, so trashing a page hides its card and deleting it removes it for good.
CREATE TABLE IF NOT EXISTS canvas_board (
    id           TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canvas_board_workspace ON canvas_board(workspace_id);

CREATE TABLE IF NOT EXISTS canvas_board_item (
    id              TEXT PRIMARY KEY NOT NULL,
    board_id        TEXT NOT NULL REFERENCES canvas_board(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('page', 'note', 'image')),
    page_id         TEXT REFERENCES page(id) ON DELETE CASCADE,
    text            TEXT NOT NULL DEFAULT '',
    attachment_hash TEXT,
    x               REAL NOT NULL,
    y               REAL NOT NULL,
    w               REAL NOT NULL,
    h               REAL NOT NULL,
    z               INTEGER NOT NULL DEFAULT 0,
    color           TEXT
);
CREATE INDEX IF NOT EXISTS idx_canvas_board_item_board ON canvas_board_item(board_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_board_item_page
    ON canvas_board_item(board_id, page_id) WHERE page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS canvas_board_edge (
    id        TEXT PRIMARY KEY NOT NULL,
    board_id  TEXT NOT NULL REFERENCES canvas_board(id) ON DELETE CASCADE,
    from_item TEXT NOT NULL REFERENCES canvas_board_item(id) ON DELETE CASCADE,
    to_item   TEXT NOT NULL REFERENCES canvas_board_item(id) ON DELETE CASCADE,
    label     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_canvas_board_edge_board ON canvas_board_edge(board_id);
