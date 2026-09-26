-- Requirements are stored as the date they EXPIRE, not the date they were done.
--
-- FIRST expires its annual items on 1 August, the season rollover, rather than
-- a year after completion: training taken on 13 Aug 2026 expires 1 Aug 2027.
-- "Completed + 1 year" was therefore wrong, and could be wrong by nearly a year
-- for someone trained in July. The lifecycle sheet records the expiry FIRST
-- shows, so hawk-mod now stores that and computes nothing. It also fixes the
-- background screening window, which was 4 years; FIRST renews it at 36 months
-- (FRC2713/hawk-mod#17).
--
-- The old names were also a hazard: `ypp_completed_on` held the SCREENING while
-- the sheet's old "YPP Expiry" held the TRAINING. Every column now says what it
-- is.
--
--   ypp_completed_on   -> screening_expires_on        (+3 years)
--   ypt_completed_on   -> training_expires_on         (next 1 August)
--   cori_completed_on  -> cori_expires_on             (+3 years)
--   mentor_ready_on    -> mentor_ready_completed_on   (one-time; unchanged)
--   (new)                 consent_release_expires_on  (reported only)
--   (new)                 data_privacy_expires_on     (reported only)

ALTER TABLE people ADD COLUMN screening_expires_on TEXT;
ALTER TABLE people ADD COLUMN training_expires_on TEXT;
ALTER TABLE people ADD COLUMN cori_expires_on TEXT;
ALTER TABLE people ADD COLUMN mentor_ready_completed_on TEXT;
ALTER TABLE people ADD COLUMN consent_release_expires_on TEXT;
ALTER TABLE people ADD COLUMN data_privacy_expires_on TEXT;

-- Converting an existing completion date. Every conversion errs early, never
-- late: an expiry a day too soon asks someone to re-check a date, an expiry a
-- day too late counts an unscreened adult toward the two-adult rule.
--
-- SQLite's date(d, '+3 years') turns 29 February into 1 March — a day late —
-- so a leap-day completion steps back to the 28th first.
UPDATE people SET screening_expires_on = CASE
    WHEN substr(ypp_completed_on, 6, 5) = '02-29'
      THEN date(ypp_completed_on, '-1 day', '+3 years')
    ELSE date(ypp_completed_on, '+3 years') END
  WHERE ypp_completed_on IS NOT NULL;

UPDATE people SET cori_expires_on = CASE
    WHEN substr(cori_completed_on, 6, 5) = '02-29'
      THEN date(cori_completed_on, '-1 day', '+3 years')
    ELSE date(cori_completed_on, '+3 years') END
  WHERE cori_completed_on IS NOT NULL;

-- The first 1 August strictly after completion. Training done on 1 August
-- itself counts for the season that starts that day.
UPDATE people SET training_expires_on =
    CASE WHEN substr(ypt_completed_on, 6, 5) < '08-01'
      THEN substr(ypt_completed_on, 1, 4) || '-08-01'
      ELSE (CAST(substr(ypt_completed_on, 1, 4) AS INTEGER) + 1) || '-08-01'
    END
  WHERE ypt_completed_on IS NOT NULL;

UPDATE people SET mentor_ready_completed_on = mentor_ready_on;

-- Provenance: these expiry dates were computed, not entered, and that should be
-- visible to anyone later asking where a date came from.
INSERT INTO screening_changes
  (person_id, field, from_value, to_value, source, recorded_by, changed_at)
SELECT id, 'screening_expires_on', NULL, screening_expires_on, 'migration',
       'migration 0008 (completed + 3 years)', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM people WHERE screening_expires_on IS NOT NULL
UNION ALL
SELECT id, 'training_expires_on', NULL, training_expires_on, 'migration',
       'migration 0008 (next 1 August after completion)',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM people WHERE training_expires_on IS NOT NULL
UNION ALL
SELECT id, 'cori_expires_on', NULL, cori_expires_on, 'migration',
       'migration 0008 (completed + 3 years)', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM people WHERE cori_expires_on IS NOT NULL;

-- Nothing may keep reading a completion date as if it were the old meaning.
ALTER TABLE people DROP COLUMN ypp_completed_on;
ALTER TABLE people DROP COLUMN ypt_completed_on;
ALTER TABLE people DROP COLUMN cori_completed_on;
ALTER TABLE people DROP COLUMN mentor_ready_on;
