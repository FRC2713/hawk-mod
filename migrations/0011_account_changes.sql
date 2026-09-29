-- Step 7 of the lifecycle sync: Google accounts suspended and restored
-- (docs/lifecycle-sync.md, "Leaving the team").
--
--   account_changes  every account hawk-mod@ suspended or restored, and who
--                    clicked for it, with their reason. Google's own Admin
--                    log shows hawk-mod@ as the actor; this is the only record
--                    of the person behind the click. Nothing is ever deleted,
--                    so there is no 'delete'.

CREATE TABLE account_changes (
  id          INTEGER PRIMARY KEY,
  person_id   TEXT,            -- the lifecycle sheet's Person ID, if known
  account     TEXT NOT NULL,   -- the Google account's primary address
  action      TEXT NOT NULL CHECK (action IN ('suspend', 'restore')),
  actor       TEXT NOT NULL,   -- Slack id of the administrator who clicked
  actor_name  TEXT NOT NULL,
  reason      TEXT,
  changed_at  TEXT NOT NULL
);
CREATE INDEX account_changes_account_idx ON account_changes (account, changed_at);
