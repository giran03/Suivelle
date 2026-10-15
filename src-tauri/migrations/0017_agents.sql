-- Local AI agents: identities, provenance, proposals, aliases, unresolved links and the
-- plain-text mirror. Agents connect over the loopback agent API; nothing here talks to a network.

-- Installation-wide settings that are not tied to one workspace (the agent API switch).
CREATE TABLE IF NOT EXISTS app_setting (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

-- An agent that may connect. Permissions, scopes and tokens change only through the app's own
-- interface, never through the agent API. `mode` is "propose", "write" or "auto".
CREATE TABLE IF NOT EXISTS agent (
    id                   TEXT PRIMARY KEY NOT NULL,
    name                 TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'active',
    mode                 TEXT NOT NULL DEFAULT 'propose',
    workspace_ids_json   TEXT NOT NULL DEFAULT '[]',
    tools_json           TEXT NOT NULL DEFAULT '[]',
    model                TEXT NOT NULL DEFAULT '',
    instructions_page_id TEXT,
    token_hash           TEXT,
    token_hint           TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL,
    last_seen_at         TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_name ON agent(name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_token ON agent(token_hash) WHERE token_hash IS NOT NULL;

-- page.created_by (which agent created a page; NULL for people, imports and automations) is
-- added by the migration code, which checks for the column first so the step can be re-run.

-- One applied set of changes by one actor ("agent", "mirror"), with the pages it touched and the
-- snapshot each page had before, so the whole set can be reverted.
CREATE TABLE IF NOT EXISTS changeset (
    id          TEXT PRIMARY KEY NOT NULL,
    actor_kind  TEXT NOT NULL,
    actor_id    TEXT,
    proposal_id TEXT,
    summary     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    reverted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_changeset_actor ON changeset(actor_kind, actor_id, created_at);

CREATE TABLE IF NOT EXISTS changeset_page (
    changeset_id TEXT NOT NULL REFERENCES changeset(id) ON DELETE CASCADE,
    page_id      TEXT NOT NULL,
    op           TEXT NOT NULL,
    revision_id  TEXT,
    PRIMARY KEY (changeset_id, page_id, op)
);

CREATE INDEX IF NOT EXISTS idx_changeset_page_page ON changeset_page(page_id);

-- Changes an agent (or the mirror) asks to make, waiting for review.
CREATE TABLE IF NOT EXISTS proposal (
    id            TEXT PRIMARY KEY NOT NULL,
    actor_kind    TEXT NOT NULL DEFAULT 'agent',
    agent_id      TEXT,
    workspace_id  TEXT NOT NULL,
    title         TEXT NOT NULL,
    rationale     TEXT NOT NULL DEFAULT '',
    ops_json      TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    error         TEXT,
    decision_note TEXT,
    changeset_id  TEXT,
    created_at    TEXT NOT NULL,
    decided_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal(status, created_at);
CREATE INDEX IF NOT EXISTS idx_proposal_agent ON proposal(agent_id, created_at);

-- Every agent API call, without arguments or content.
CREATE TABLE IF NOT EXISTS agent_audit (
    id          INTEGER PRIMARY KEY,
    agent_id    TEXT NOT NULL,
    tool        TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_audit_agent ON agent_audit(agent_id, id);

-- The page that holds a workspace's agent Memory and Agent tasks databases.
CREATE TABLE IF NOT EXISTS agent_hub (
    workspace_id       TEXT PRIMARY KEY NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    page_id            TEXT NOT NULL,
    memory_database_id TEXT NOT NULL,
    tasks_database_id  TEXT NOT NULL
);

-- Other names a page answers to in [[wikilinks]].
CREATE TABLE IF NOT EXISTS page_alias (
    page_id      TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    alias        TEXT NOT NULL,
    alias_norm   TEXT NOT NULL,
    PRIMARY KEY (page_id, alias_norm)
);

CREATE INDEX IF NOT EXISTS idx_page_alias_norm ON page_alias(workspace_id, alias_norm);

-- [[Wikilinks]] whose target does not exist yet; creating that page links them.
CREATE TABLE IF NOT EXISTS page_link_unresolved (
    source_block_id TEXT NOT NULL REFERENCES block(id) ON DELETE CASCADE,
    source_page_id  TEXT NOT NULL,
    workspace_id    TEXT NOT NULL,
    target_text     TEXT NOT NULL,
    target_norm     TEXT NOT NULL,
    PRIMARY KEY (source_block_id, target_norm)
);

CREATE INDEX IF NOT EXISTS idx_link_unresolved_norm ON page_link_unresolved(workspace_id, target_norm);
CREATE INDEX IF NOT EXISTS idx_link_unresolved_page ON page_link_unresolved(source_page_id);

-- The plain-text mirror: which file each page was last written to, and what it held.
CREATE TABLE IF NOT EXISTS mirror_file (
    workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    page_id      TEXT NOT NULL,
    path         TEXT NOT NULL,
    hash         TEXT NOT NULL,
    size         INTEGER NOT NULL DEFAULT 0,
    modified_ms  INTEGER NOT NULL DEFAULT 0,
    page_updated TEXT NOT NULL,
    PRIMARY KEY (workspace_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_mirror_file_path ON mirror_file(workspace_id, path);
