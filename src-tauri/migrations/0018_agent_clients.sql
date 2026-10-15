-- Agent apps (Claude Code, Codex, Cursor, …) that Suivelle connected by adding itself to the
-- app's MCP configuration. One agent per app. `fingerprint` is a hash of the entry Suivelle wrote,
-- so an entry changed by hand afterwards can be recognized. Nothing secret is stored here.
CREATE TABLE IF NOT EXISTS agent_client (
    client_id         TEXT PRIMARY KEY NOT NULL,
    agent_id          TEXT NOT NULL UNIQUE REFERENCES agent(id) ON DELETE CASCADE,
    -- "file" (Suivelle edited the config), "cli" (the app's own command did) or "manual"
    -- (the user pasted the entry).
    method            TEXT NOT NULL,
    config_paths_json TEXT NOT NULL DEFAULT '[]',
    fingerprint       TEXT,
    -- Whether Suivelle added the servers section itself, so disconnecting can remove it again.
    created_container INTEGER NOT NULL DEFAULT 0,
    -- Whether the token lives in the system credential store instead of the config file.
    credential        INTEGER NOT NULL DEFAULT 0,
    bridge_path       TEXT NOT NULL DEFAULT '',
    connected_at      TEXT NOT NULL
);
