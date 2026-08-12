-- Durable record of every role change, and of the roster rows Slack user
-- groups created. Slack's audit logs API is Enterprise Grid only, so on
-- Business+ this table is the only trail of who was monitored when.
CREATE TABLE role_changes (
  id            INTEGER PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  slack_user_id TEXT,
  from_role     TEXT,          -- NULL when the row was created by the sync
  to_role       TEXT NOT NULL,
  source        TEXT NOT NULL, -- 'usergroup_sync' | 'csv' | 'manual'
  detail        TEXT,
  changed_at    TEXT NOT NULL
);
CREATE INDEX role_changes_person_idx ON role_changes (person_id, changed_at);
