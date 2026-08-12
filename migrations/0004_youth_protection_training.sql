-- FIRST's requirements, corrected against the Youth Protection Program itself:
--
--   Youth Protection Screening (background check)  required, multi-year
--   Youth Protection Training                      required, ANNUAL
--   Mentor Ready                                   OPTIONAL, encouraged
--
-- Mentor Ready is a path containing four components — Welcome to FIRST, Youth
-- Protection Training, Data Privacy for Mentors, Role of a Mentor — and only
-- the training inside it is required for clearance. It was previously treated
-- as mandatory, which would have blocked adults who had done everything FIRST
-- actually asks for.
ALTER TABLE people ADD COLUMN ypt_completed_on TEXT;

-- Anyone recorded as having completed Mentor Ready completed the training
-- inside it, so carry the date across rather than asking for it twice.
UPDATE people
   SET ypt_completed_on = mentor_ready_on
 WHERE mentor_ready_on IS NOT NULL;
