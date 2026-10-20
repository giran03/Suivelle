-- Token usage and Jev ("System One") telemetry per agent API call, without storing arguments or
-- page content. Columns are added in database::migrate only when missing so the step is idempotent.
CREATE INDEX IF NOT EXISTS idx_agent_audit_created ON agent_audit(created_at);
