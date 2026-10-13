CREATE TABLE IF NOT EXISTS calendar_collection (
    page_id TEXT PRIMARY KEY REFERENCES page(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS calendar_collection_workspace ON calendar_collection(workspace_id);
INSERT OR IGNORE INTO calendar_collection(page_id, workspace_id)
SELECT p.id, p.workspace_id FROM page p JOIN block b ON b.page_id=p.id
WHERE b.type='calendar' AND json_extract(b.data_json,'$.isCollection')=1
AND json_extract(b.data_json,'$.calendarId')=p.id;
