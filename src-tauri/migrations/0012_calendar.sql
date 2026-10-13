-- Calendar content lives in ordinary pages/blocks, so history, trash and archives own it.
CREATE INDEX IF NOT EXISTS idx_calendar_blocks ON block(type, page_id)
WHERE type IN ('calendar', 'calendar_event');
-- Delivery receipts are device state, intentionally outside portable workspace content.
CREATE TABLE IF NOT EXISTS calendar_delivery (
    page_id TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    occurrence TEXT NOT NULL,
    offset_minutes INTEGER NOT NULL,
    fired_at TEXT NOT NULL,
    PRIMARY KEY (page_id, occurrence, offset_minutes)
);
