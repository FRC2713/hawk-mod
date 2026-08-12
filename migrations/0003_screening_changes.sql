-- Who recorded which screening date, and when. Screening dates decide whether
-- someone counts as a screened adult, so a bare `people` column is not enough:
-- the value needs provenance the same way role changes do.
CREATE TABLE screening_changes (
  id          INTEGER PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,  -- ypp_completed_on | mentor_ready_on | cori_completed_on
  from_value  TEXT,
  to_value    TEXT,
  source      TEXT NOT NULL,  -- 'slack_modal' | 'csv'
  recorded_by TEXT NOT NULL,
  changed_at  TEXT NOT NULL
);
CREATE INDEX screening_changes_person_idx
  ON screening_changes (person_id, changed_at);
