-- Reminders on pages, and #tags found in block text.

-- A reminder fires once, as a desktop notification, at a local wall-clock time
-- ("2026-10-13T09:00:00"). Fired reminders stay listed for a while, then age out of the list.
CREATE TABLE IF NOT EXISTS reminder (
    id           TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    page_id      TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    remind_at    TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    fired_at     TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_due ON reminder(remind_at) WHERE fired_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reminder_workspace ON reminder(workspace_id, remind_at);

-- Which #tags a block's text contains, kept with the search index (same transaction).
CREATE TABLE IF NOT EXISTS block_tag (
    block_id     TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
    page_id      TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    tag          TEXT NOT NULL,
    PRIMARY KEY (block_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_block_tag_workspace ON block_tag(workspace_id, tag);
CREATE INDEX IF NOT EXISTS idx_block_tag_page ON block_tag(page_id);
