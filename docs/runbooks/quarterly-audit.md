# Quarterly audit runbook

"An audit right we never exercise is worth nothing." hawk-mod records
continuously; this is the review that makes the record mean something. Budget
about an hour. Two screened adults do it together, and the second one is not
the person whose DMs are being reviewed.

## 1. Coverage first

```
/hawkmod status
```

Enrollment must read N/N. Anything less means those mentors' DMs were invisible
for the whole quarter, and **the rest of this audit does not cover them**. Note
the gap in the minutes rather than glossing it.

## 2. Work the findings

```
/hawkmod findings
```

Oldest first. Every one gets a written reason when closed — `/hawkmod resolve
<id> <note>` requires it. `mentor_student_dm` findings never close on their own,
so they are the real agenda.

For each DM violation:

- Read the conversation: `npm run cli -- export-conversation <id> out.json`
- Establish what happened, with the mentor, in person
- Record the outcome in the resolution note, including "nothing concerning" when
  that is the answer
- If the conversation should have been a channel, move it and say so in the note

## 3. Spot-check what was _not_ flagged

Pick two or three allowed group DMs at random and read them. The flagged set is
only as good as the roster: someone mis-roled as a mentor, or a student whose
account was never linked, produces silence rather than an alert.

## 4. Roster truth

- Anyone who left the team this quarter: `active = 0`, and deactivate their
  Slack account
- New students: consent on file _before_ the account, not after
- Screening dates: `/hawkmod whois @user` for anyone whose status is unclear

## 5. Things hawk-mod cannot check

Confirm by hand, in Workspace Settings, and write the date you checked:

- Retention still set to keep everything
- Slack Connect external DMs still disabled
- Huddles still off
- Invites still restricted to Owners/Admins
- Still at least two Owners, both screened adults, neither a student

## 6. Close it out

Post the summary in the alert channel: findings opened, closed, still open;
enrollment coverage; the manual checks above with dates. File it with the
consents. The board minutes should show the audit happened, not just that it was
scheduled.
