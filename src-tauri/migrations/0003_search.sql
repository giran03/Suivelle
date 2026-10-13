-- Phase 3: full-text search, page references (backlinks) and recent pages.

-- Recents live in the database so they survive restarts. Opening a page never changes its
-- revision or updated_at.
ALTER TABLE page ADD COLUMN last_opened_at TEXT;
CREATE INDEX idx_page_opened ON page(last_opened_at);

-- One row per indexed document: a page title ("p:<id>") or a text block ("b:<id>").
-- `id` doubles as the rowid of the FTS table so documents can be updated and removed by key.
CREATE TABLE search_doc (
    id           INTEGER PRIMARY KEY,
    key          TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    page_id      TEXT NOT NULL,
    block_id     TEXT
);

CREATE INDEX idx_search_doc_page ON search_doc(page_id);
CREATE INDEX idx_search_doc_workspace ON search_doc(workspace_id);

-- `title` holds page titles and headings (ranked higher); `body` holds all other text.
CREATE VIRTUAL TABLE search_fts USING fts5(
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '2 3'
);

-- Which pages a block mentions or links to. The target has no foreign key on purpose: a
-- reference to a permanently deleted page is removed explicitly and shows as "unknown".
CREATE TABLE page_reference (
    source_page_id  TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    source_block_id TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
    target_page_id  TEXT NOT NULL,
    PRIMARY KEY (source_block_id, target_page_id)
);

CREATE INDEX idx_page_reference_target ON page_reference(target_page_id);
CREATE INDEX idx_page_reference_source ON page_reference(source_page_id);
