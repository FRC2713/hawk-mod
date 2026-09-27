-- foreign_keys: off
-- Step 3 of the lifecycle sync: the roster is built from the lifecycle sheet
-- (docs/lifecycle-sync.md, "Step 3 design").
--
--   person_id                 the sheet's Person ID (P####), stamped once a row
--                             is matched and its key from then on
--   slack_consent_expires_on  Student_Details.Slack Consent Expiry, which
--                             replaces the consents table as what is read
--   email                     no longer required. It is the person's identity
--                             email — RHR Email or School Email — and an Active
--                             mentor waiting for an account, or a student with
--                             no School Email, has none yet. They are still
--                             monitored, by Person ID and Slack User ID. A
--                             personal email is never put here instead.
--
-- Dropping NOT NULL means rebuilding the table, which 0005 declined to do,
-- because `people` is the parent of ON DELETE CASCADE foreign keys (consents,
-- role_changes, screening_changes): dropping it with foreign keys on runs
-- those cascades and deletes every consent on record. The first line above
-- makes the runner (src/db/client.ts) turn foreign keys off around this file,
-- which is SQLite's documented procedure for altering a table, and roll it
-- back unless `foreign_key_check` comes back clean afterwards.
-- test/migration0009.test.ts checks that the children all survive.
--
-- The CHECK still lists the retired lead_coach and admin roles, as 0005
-- explains; a rebuild is not the moment to find out a row still holds one.

CREATE TABLE people_new (
  id                         INTEGER PRIMARY KEY,
  person_id                  TEXT UNIQUE,
  slack_user_id              TEXT UNIQUE,
  email                      TEXT UNIQUE COLLATE NOCASE,
  full_name                  TEXT NOT NULL,
  role                       TEXT NOT NULL CHECK (role IN (
                               'student','adult','lead_coach','admin','district_observer'
                             )),
  active                     INTEGER NOT NULL DEFAULT 1,
  screening_expires_on       TEXT,
  training_expires_on        TEXT,
  cori_expires_on            TEXT,
  consent_release_expires_on TEXT,
  data_privacy_expires_on    TEXT,
  mentor_ready_completed_on  TEXT,
  slack_consent_expires_on   TEXT,
  notes                      TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

INSERT INTO people_new (id, slack_user_id, email, full_name, role, active,
                    screening_expires_on, training_expires_on, cori_expires_on,
                    consent_release_expires_on, data_privacy_expires_on,
                    mentor_ready_completed_on, notes, created_at, updated_at)
SELECT id, slack_user_id, email, full_name, role, active,
       screening_expires_on, training_expires_on, cori_expires_on,
       consent_release_expires_on, data_privacy_expires_on,
       mentor_ready_completed_on, notes, created_at, updated_at
  FROM people;

DROP TABLE people;

ALTER TABLE people_new RENAME TO people;
