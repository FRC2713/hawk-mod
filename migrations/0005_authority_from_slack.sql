-- Administrative authority moved out of the roster and onto Slack's own
-- Workspace Owner/Admin flags (see src/slack/authz.ts). The `lead_coach` and
-- `admin` roles existed only to answer "may this person run /hawkmod", which
-- Slack already answers, and answering it here meant a fresh install had no
-- administrator at all until someone ran the CLI on the host.
--
-- Both collapse to `adult`. No rule loses anything: enrollment, screening, and
-- the two-adult rule already treated all three identically.

INSERT INTO role_changes
  (person_id, slack_user_id, from_role, to_role, source, detail, changed_at)
SELECT id, slack_user_id, role, 'adult', 'migration',
       json_object('migration', '0005_authority_from_slack',
                   'reason', 'authority now read from Slack admin/owner'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM people
WHERE role IN ('lead_coach', 'admin');

UPDATE people
SET role = 'adult',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE role IN ('lead_coach', 'admin');

-- The CHECK constraint on people.role still lists the two retired names, and
-- stays that way on purpose. Dropping a CHECK in SQLite means rebuilding the
-- table, and `people` is the parent of four ON DELETE CASCADE foreign keys —
-- consents among them. A migration that can destroy consent records to tidy a
-- constraint is a bad trade. Nothing can write the old values now: ROLES no
-- longer contains them, the CLI validates against ROLES, and the user-group
-- sync only ever writes 'student' or 'adult'.
