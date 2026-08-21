-- Group membership management: hawk-mod can now edit the Slack user groups it
-- reads, and needs somewhere to record who asked for each edit.
--
-- Two changes, for two reasons.

-- 1. A third kind of installation row.
--
-- Slack refuses a *bot* token for usergroups.users.update unless the workspace
-- lets everyone edit user groups — which §6 forbids. So group edits ride on an
-- administrator's own user token, granted at a separate authorization that asks
-- for `usergroups:write` and nothing else.
--
-- That token cannot share a row with an enrolled adult's DM token. Slack issues
-- one token per authorization carrying only the scopes granted at that moment,
-- and `installations` is keyed on (team, kind, slack_user_id) with an upsert —
-- so an administrator who is also an enrolled mentor would have their DM token
-- overwritten by their group-editing token, silently ending their monitoring
-- while /hawkmod status still reported them enrolled. A separate `kind` keeps
-- the two grants in separate rows with independent lifetimes.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. This is safe
-- here in a way it was not in 0005: nothing references `installations`, so
-- there are no cascades to fire and no rows anywhere else to lose.

CREATE TABLE installations_new (
  id            INTEGER PRIMARY KEY,
  team_id       TEXT NOT NULL,
  enterprise_id TEXT,
  slack_user_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('bot','user','admin')),
  payload_enc   TEXT NOT NULL,   -- encrypted JSON Installation
  scopes        TEXT,
  installed_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  revoked_at    TEXT,
  UNIQUE (team_id, kind, slack_user_id)
);

INSERT INTO installations_new
  (id, team_id, enterprise_id, slack_user_id, kind, payload_enc, scopes,
   installed_at, updated_at, revoked_at)
SELECT id, team_id, enterprise_id, slack_user_id, kind, payload_enc, scopes,
       installed_at, updated_at, revoked_at
FROM installations;

DROP TABLE installations;
ALTER TABLE installations_new RENAME TO installations;

-- 2. The trail of who asked.
--
-- A group edit and its effect on monitoring are different facts, and they need
-- different records. `role_changes` says what happened to someone's monitoring;
-- it is written by the user-group sync, which runs from a Slack event and has
-- no idea a human was involved. This table says who asked for what.
--
-- It is also the only record of edits that change no role at all — which will
-- be most of them once subteams (@programming, @drive-team) are managed here.
CREATE TABLE group_changes (
  id            INTEGER PRIMARY KEY,
  usergroup_id  TEXT NOT NULL,
  handle        TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('add','remove')),
  subject       TEXT NOT NULL,   -- Slack id of the person added or removed
  person_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
  actor         TEXT NOT NULL,   -- Slack id of the administrator who asked
  actor_name    TEXT NOT NULL,
  reason        TEXT,            -- required when the edit reduces monitoring
  source        TEXT NOT NULL,   -- 'command' | 'sheet_sync'
  changed_at    TEXT NOT NULL
);
CREATE INDEX group_changes_group_idx ON group_changes (usergroup_id, changed_at);
CREATE INDEX group_changes_subject_idx ON group_changes (subject, changed_at);
