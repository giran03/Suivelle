-- Phase 7: page history. A snapshot is the page's title and every block, deflate-compressed JSON.
-- Snapshots belong to the page and disappear with it; pruning keeps recent and one-per-day ones.

CREATE TABLE page_revision (
    id            TEXT PRIMARY KEY NOT NULL,
    page_id       TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    seq           INTEGER NOT NULL,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    block_count   INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    snapshot      BLOB NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (page_id, seq)
);

CREATE INDEX idx_page_revision_page ON page_revision(page_id, seq DESC);
