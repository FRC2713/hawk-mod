-- Settings a Slack admin can change without a shell on the host.
--
-- `authz.ts` already made this argument once, about who may administer
-- hawk-mod: "an app whose first-run instruction is 'SSH into the server' is
-- broken." The same was still true of which user group declares students — a
-- decision a Slack admin makes, that only a Linode login could change, and that
-- reads identically to "the group is empty" when it is wrong.
--
-- Credentials stay in the environment: you cannot configure from Slack the
-- things that let hawk-mod reach Slack, and TOKEN_ENCRYPTION_KEY changing would
-- make every stored token undecryptable. What moves here is policy, not
-- identity.
--
-- Lives in the same SQLite file as everything else, so it survives a redeploy
-- and is already covered by the backup step in docs/deploy.md.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Which user group declares who is monitored is a youth-protection fact, so
-- changing it leaves the same kind of trail as changing somebody's role does.
-- Slack's audit log API is Enterprise Grid only; this is the trail.
CREATE TABLE setting_changes (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL,
  from_value TEXT,           -- NULL when the setting was previously unset
  to_value   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX setting_changes_key_idx ON setting_changes (key, changed_at);
