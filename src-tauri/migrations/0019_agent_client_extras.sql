-- What Connect added to an agent app besides its MCP entry: the session-start lines in the app's
-- user-level instructions file, and the /suivelle_… command files. Disconnect removes both.
-- Columns, added in database::migrate only when missing (SQLite has no ADD COLUMN IF NOT EXISTS):
--   want_instructions INTEGER, want_commands INTEGER: the user's choices; NULL for apps connected
--     before these existed, and Repair then adds both.
--   instructions_path TEXT: the instructions file holding the block.
--   commands_json TEXT NOT NULL DEFAULT '[]': the command files written.
SELECT 1;
