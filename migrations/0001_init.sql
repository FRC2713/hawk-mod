-- Roster. One row per human, whether or not they have a Slack account yet.
CREATE TABLE people (
  id                INTEGER PRIMARY KEY,
  slack_user_id     TEXT UNIQUE,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name         TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN (
                      'student','adult','lead_coach','admin','district_observer'
                    )),
  active            INTEGER NOT NULL DEFAULT 1,
  ypp_completed_on  TEXT,  -- FIRST Youth Protection screening / Mentor Ready
  mentor_ready_on   TEXT,
  cori_completed_on TEXT,  -- CORI + national fingerprint check
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Parental consent, per Slack's Education Professional Customers supplement.
-- Re-collected annually; a student with no current row must not have an account.
CREATE TABLE consents (
  id            INTEGER PRIMARY KEY,
  person_id     INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  signed_on     TEXT NOT NULL,
  expires_on    TEXT NOT NULL,
  form_version  TEXT NOT NULL,
  guardian_name TEXT NOT NULL,
  guardian_email TEXT,
  document_ref  TEXT,       -- where the signed copy is filed
  recorded_by   TEXT NOT NULL,
  revoked_on    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX consents_person_idx ON consents (person_id, signed_on DESC);

-- OAuth installations. One 'bot' row per workspace (slack_user_id = '-') plus
-- one 'user' row per enrolled adult holding that adult's user token.
CREATE TABLE installations (
  id            INTEGER PRIMARY KEY,
  team_id       TEXT NOT NULL,
  enterprise_id TEXT,
  slack_user_id TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('bot','user')),
  payload_enc   TEXT NOT NULL,   -- encrypted JSON Installation
  scopes        TEXT,
  installed_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  revoked_at    TEXT,
  UNIQUE (team_id, kind, slack_user_id)
);

-- Every DM/group-DM an enrolled adult is party to that includes a student.
CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,   -- Slack conversation id (D…/G…)
  team_id           TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('im','mpim')),
  participants      TEXT NOT NULL,      -- JSON array of Slack user ids
  monitored         INTEGER NOT NULL DEFAULT 0,
  verdict           TEXT,               -- dmPolicy classification, JSON
  first_seen_at     TEXT NOT NULL,
  last_evaluated_at TEXT NOT NULL,
  last_backfill_ts  TEXT                -- Slack ts cursor for history sweeps
);

CREATE TABLE dm_messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ts              TEXT NOT NULL,
  thread_ts       TEXT,
  author_slack_id TEXT NOT NULL,
  author_person_id INTEGER REFERENCES people(id),
  text            TEXT,      -- NULL when LOG_MODE=metadata
  char_count      INTEGER NOT NULL DEFAULT 0,
  files           TEXT,      -- JSON [{id,name,mimetype,size}]
  subtype         TEXT,
  edited_at       TEXT,
  deleted_at      TEXT,      -- tombstone; the row itself is never removed
  source          TEXT NOT NULL CHECK (source IN ('event','backfill')),
  observed_via    TEXT NOT NULL,  -- Slack id of the adult whose token saw it
  recorded_at     TEXT NOT NULL,
  UNIQUE (conversation_id, ts)
);
CREATE INDEX dm_messages_conv_idx ON dm_messages (conversation_id, ts);
CREATE INDEX dm_messages_author_idx ON dm_messages (author_slack_id, ts);

-- Prior text of edited messages. Editing a DM must not erase what it said.
CREATE TABLE dm_message_revisions (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  previous_text TEXT,
  replaced_at   TEXT NOT NULL
);

CREATE TABLE findings (
  id                INTEGER PRIMARY KEY,
  kind              TEXT NOT NULL,
  dedupe_key        TEXT NOT NULL UNIQUE,
  severity          TEXT NOT NULL CHECK (severity IN ('info','warn','violation')),
  summary           TEXT NOT NULL,
  detail            TEXT,   -- JSON
  subject_person_id INTEGER REFERENCES people(id),
  subject_ref       TEXT,   -- channel or conversation id
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','acknowledged','resolved')),
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  resolved_at       TEXT,
  resolved_by       TEXT,
  resolution_note   TEXT,
  alert_ts          TEXT    -- ts of the Slack alert, for threading updates
);
CREATE INDEX findings_status_idx ON findings (status, severity, last_seen_at);

CREATE TABLE audit_runs (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,   -- 'sweep' | 'backfill' | 'quarterly'
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  stats          TEXT,            -- JSON
  signed_off_by  TEXT,
  signed_off_at  TEXT,
  note           TEXT
);
