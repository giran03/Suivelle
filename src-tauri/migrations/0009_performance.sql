-- Append positions use the live sibling maximum without scanning every sibling.
CREATE INDEX idx_page_live_position ON page(workspace_id, parent_page_id, position DESC)
    WHERE deleted_at IS NULL;

-- Database children are records and must not be scanned to compute sidebar child counts.
CREATE INDEX idx_page_live_children ON page(parent_page_id)
    WHERE deleted_at IS NULL AND kind <> 'record';
