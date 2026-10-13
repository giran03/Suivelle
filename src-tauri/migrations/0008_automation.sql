-- Phase 9: local automation. An automation belongs to one database: a trigger, optional
-- conditions (a filter tree evaluated on the triggering record) and an ordered list of actions.
-- Buttons are automations whose trigger is a Button property, so there is one engine.

CREATE TABLE automation (
    id            TEXT PRIMARY KEY NOT NULL,
    database_id   TEXT NOT NULL REFERENCES db_database(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    trigger_json  TEXT NOT NULL,
    conditions_json TEXT,
    actions_json  TEXT NOT NULL,
    position      REAL NOT NULL DEFAULT 0,
    -- Local time (naive ISO) from which schedules and date triggers count; set whenever the
    -- automation is saved or switched on, so nothing runs retroactively.
    armed_at      TEXT NOT NULL,
    -- Schedules: the last slot that was handled.
    fired_at      TEXT NOT NULL,
    last_run_at   TEXT,
    last_status   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX idx_automation_database ON automation(database_id, position);

-- Date triggers fire once per record and date: the key is the moment it was due.
CREATE TABLE automation_fired (
    automation_id TEXT NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
    record_id     TEXT NOT NULL,
    fire_key      TEXT NOT NULL,
    PRIMARY KEY (automation_id, record_id, fire_key)
);

CREATE TABLE automation_run (
    id            TEXT PRIMARY KEY NOT NULL,
    automation_id TEXT NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
    database_id   TEXT NOT NULL,
    execution_id  TEXT NOT NULL,
    depth         INTEGER NOT NULL,
    status        TEXT NOT NULL,
    message       TEXT NOT NULL DEFAULT '',
    record_title  TEXT,
    started_at    TEXT NOT NULL
);

CREATE INDEX idx_automation_run_database ON automation_run(database_id, started_at DESC);
