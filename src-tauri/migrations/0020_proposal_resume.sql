-- Resuming agents after review. Columns, added in database::migrate only when missing:
--   resume INTEGER NOT NULL DEFAULT 0: 1 when the agent asked to hear the decision
--     (proposal_wait), 2 once a follow-up task was queued for it.
--   waiting_until TEXT: while an agent's session is waiting for the decision, a moment a few
--     seconds ahead that the waiting session keeps pushing forward.
SELECT 1;
