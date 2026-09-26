# Lifecycle sync — scope

Status: **scoped, not started.** Decisions below were settled with Rachel Moore
on 2026-09-25. One question is parked (see [Open](#open)).

## What it is

hawk-mod reads the **RHR User Lifecycle Management DB** Google Sheet — the
team's single record of every person — and keeps Google Groups, Workspace admin
roles, Slack user groups, and hawk-mod's own roster in line with it. It runs on
a schedule and on demand, and every run can show what it _would_ change before
it changes anything.

The burden this removes is group management. Account creation stays manual: an
administrator creates each mentor's Google account by hand and types the address
into the sheet. Mentors are added rarely; groups change constantly.

## Direction of truth

**The sheet declares, the Slack user groups mirror it, and hawk-mod's table
monitors.**

- The sheet is the only place anyone edits a person. hawk-mod never edits the
  sheet except to write back a Slack User ID.
- hawk-mod's `people` table stays, as a sync-only copy keyed by the sheet's
  Person ID (`P####`). It is not replaced by live reads of the sheet, because:
  - the DM rules run on every message; if the sheet is unreadable, a live-read
    roster is empty and every conversation classifies as student-free — hawk-mod
    goes quiet by going blind;
  - the sheet can lose a row with no author and no reason, and a lost row must
    never end someone's monitoring;
  - `role_changes` / `screening_changes` are the only dated history (Slack's
    audit API is Grid-only);
  - findings, consents and verdicts reference `people.id`.
- The existing add-only rule carries over to the new source: the sync may add
  or raise monitoring, never end it. A row that disappears, or turns Inactive,
  becomes a finding. Ending monitoring is still `/hawkmod deactivate`.
- `@students` / `@mentors` stop being an _input_ to roles and become _outputs_
  mirrored from the sheet. A hand edit to a mirrored Slack group is drift: the
  next run restores it and raises a finding so the editor learns it did not
  stick. `/hawkmod group add|remove` refuses mirrored groups ("edit the sheet")
  and keeps working for unmanaged ones.

## Who is where

| Role               | Identity key (sheet)           | Google account          | In Slack?                 | hawk-mod roster   |
| ------------------ | ------------------------------ | ----------------------- | ------------------------- | ----------------- |
| Mentor             | `Mentor_Details.RHR Email`     | Yes, created by a human | Yes, once screened        | `adult`           |
| Student            | `Student_Details.School Email` | No                      | Yes, once consent current | `student`         |
| Volunteer / Alumni | `People.Personal Email`        | No                      | **No**                    | not on the roster |

Google Group membership uses one address per person: a mentor's RHR Email, a
student's School Email, and a volunteer's or alumnus's Personal Email. **A
mentor is only ever added by RHR Email** — the mentor groups are domain
accounts only in the RHR Systems Access & Security Plan, because adults reach
students from official accounts — and a mentor without one is left out and
reported.
**A student's Personal Email is never used to add them to a group or to
Slack** — it may only help match records. A student with no School Email is
left out and reported. Groups containing students and volunteers hold
external addresses, which the groups must be set to allow (one-time Google
setup).

## Screening requirements

Expiry dates come from the sheet **as written**. hawk-mod never computes one:
FIRST expires annual items on **1 August** (the season rollover), not a year
after completion — two mentors' YPT and Data Privacy, taken 13 Aug and 25 Sep
2026, both expire 1 Aug 2027. The windows below survive in code only as a
sanity check that flags a probable typo.

| Requirement                 | Clock            | Effect                    | Sheet column (`Mentor_Details`)                             |
| --------------------------- | ---------------- | ------------------------- | ----------------------------------------------------------- |
| Youth Protection Training   | annual, to 1 Aug | **blocks** screened-adult | `YPP Expiry` → rename **`YPT Expiry`**                      |
| Background Screening        | 3 years          | **blocks**                | add **`Background Screening Expiry`**                       |
| CORI + fingerprints (Mass.) | 3 years          | **blocks**                | `CORI Expiry`                                               |
| Consent & Release           | annual, to 1 Aug | reported only             | `Consent & Release Expiry`                                  |
| Data Privacy for Mentors    | annual, to 1 Aug | reported only             | add **`Data Privacy Expiry`**                               |
| Mentor Ready badge          | one-time         | reported only             | `Mentor Ready Expiry` → rename **`Mentor Ready Completed`** |

"YPP" names the program, never a column — the old sheet header meant training
while hawk-mod's `ypp_completed_on` meant screening, the exact mix-up CLAUDE.md
warns about. hawk-mod's columns get unambiguous names in a new migration
(`training_expires_on`, `screening_expires_on`, `cori_expires_on`, …).

Students: `Student_Details.Slack Consent Expiry` feeds hawk-mod's consents.

The 4→3 year screening window
([FRC2713/hawk-mod#17](https://github.com/FRC2713/hawk-mod/issues/17)) is
folded into step 2 rather than fixed first: hawk-mod is not live, and once
expiry dates come from the sheet the window only feeds the sanity check.

## Capabilities

| #   | Capability                            | Applies           | Target                                                                                                                           |
| --- | ------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A   | Read and validate the sheet           | —                 | column allowlist; refuses to run if headers drift                                                                                |
| B   | Write Slack User ID back to the sheet | automatically     | `Mentor_Details` / `Student_Details` `Slack User ID`                                                                             |
| C   | Keep hawk-mod's roster in step        | add-only, auto    | `people`, requirement dates, consents                                                                                            |
| D   | Keep computed Google Groups right     | **automatically** | `grp-mentors`, `grp-students`, `grp-volunteers`, `grp-alumni`, `grp-mentor-leads`, `grp-student-leads`, `grp-all-team`, `grp-ra` |
| E   | Mirror chosen Google Groups to Slack  | **automatically** | Slack user groups, via `slack/groupAdmin.ts`                                                                                     |
| F   | ~~Create Workspace accounts~~         | **out of scope**  | done by hand                                                                                                                     |
| G   | Delegated admin roles report          | **report only**   | Super Admin makes each change; hawk-mod lists what differs from `Mentor_Admin_Roles`                                             |
| H   | "Ready to invite to Slack" list       | report            | `#bot-slack-invite-requests`, plus a count in the morning report                                                                 |
| I   | Offboarding / reactivation prompts    | approval          | Google suspension, Slack deactivation reminder                                                                                   |

**Groups follow the sheet automatically**, including removals — with the
refusals `domain/rules/groupMembership.ts` already carries. A plan that would
empty a group or remove more than the threshold is held and raised as a finding
rather than applied, because a sheet mistake (a deleted block of role rows)
must not empty `grp-students`.

Groups are kept **flat**, as the access plan specifies: each Google Group
holds its people directly and never contains another group, because nested
groups behave inconsistently across Drive, Calendar and Slack. The subset
relationships — leads inside their role group, both role groups inside
`grp-all-team` — are enforced by the sync (`SUBSETS` in
`domain/lifecycle/groups.ts`, with a test), not by Google.

`grp-all-team` is every Active student and every Active mentor — not
volunteers or alumni — **whether or not the mentor is screened**. Screening
gates Slack, not email: an uncleared mentor is left off the Slack invite list
and flagged if already in Slack, but is on the mailing list from the day their
row is Active. Decided 2026-09-26, reversing an earlier gate. The group does
reach students, but it meets the team's standard that all contact be
**observable and interruptible**: a message to a group is seen by the whole
group. And "Active" is itself a gate — a mentor is not set Active until they
have started the screening process and are within a trusted group.

**Mirrored to Slack (E):** `grp-students`, `grp-mentors`, `grp-student-leads`,
`grp-mentor-leads` and `grp-ra`, each to a Slack user group. The Google →
Slack mapping is a DB setting (handles validated against Slack, as
`MANAGED_USERGROUPS` handles are today), and every mirrored handle is
necessarily in `MANAGED_USERGROUPS`. A Slack group holds only the members who
are in Slack — a mentor not yet invited is in the Google group and absent from
the Slack one, which is not drift.

**Slack invites (H).** Slack Pro has no invite API, and open domain sign-up
would let a mentor join before screening. So no domain sign-up: hawk-mod posts
to `#bot-slack-invite-requests` when a person becomes ready — a mentor whose
YPT + screening + CORI are all current, or a student whose Slack Consent is
current, with no Slack account yet — once per person, with the address to
invite (RHR Email or School Email; never a personal one). The morning report
carries only a count of who is still waiting. An admin pastes the address into
Slack's invite dialog. The channel is chosen over the morning report because an
invite is a task: one message per person can be acted on and marked done,
where a daily list repeats itself until nobody reads it. The channel is in the
Adult-only Restricted tier of the access plan, which is where students' school
addresses may appear. The person leaves the list when
they appear in Slack and their ID is written back. Safety net: a Slack member
who is not a sheet mentor or student is a finding (extends `unknown_account`),
as is a mentor who joined while unscreened.

**Inactive (I).** Active → Inactive raises one approval alert: suspend the
Google account, plus reminders for what hawk-mod cannot do itself — a Super
Admin revokes any delegated admin role (step 8 reports it), and an admin
deactivates them in Slack (manual on Pro) — and whether to end hawk-mod
monitoring (always a separate `/hawkmod deactivate`). Group removal does not
wait — it follows the sheet. Inactive → Active raises the reverse: un-suspend,
with a reminder to restore roles.

**Nothing deletes an account.** Offboarding suspends.

## Invariants

1. **The sheet cannot make hawk-mod see less.** See above.
2. **Minimum-necessary PII.** The sheet holds minors' addresses, birthdays,
   medical notes and race/ethnicity. hawk-mod reads an explicit column
   allowlist and nothing else reaches SQLite, logs, or alerts.
3. **Google credentials are environment, never `SETTINGS`** — like
   `TOKEN_ENCRYPTION_KEY`. Sheet ID and group mapping are DB settings.
4. **Google is optional.** An install without Google credentials keeps doing
   everything it does today. Reading them must not go through `config()`, which
   would break the CLI and every existing host at import time.
5. **Every approval is a button gated on `administrator()`** and recorded.
6. **The plan is pure.** Sheet rows in, diff out, in `domain/rules/`, testable
   with plain objects like the rest.

## Group membership grants data access

`grp-ra` is an **organizer** of the lifecycle sheet itself. Once D manages it
from `RA (Y/N)`, setting that flag gives someone full access to every student's
personal data. The sync should treat `grp-ra` changes as notable (announce them
in the alert channel even when applied automatically), and whoever can edit the
sheet can grant this — which today is Rachel, Ty, Betsy and `grp-ra` itself.

## Google setup (one-time, manual)

A service account with domain-wide delegation impersonating an administrator,
scoped to:

- Sheets (read, plus write for B)
- Directory: groups and group members (D)
- Directory: users (read, plus suspend for I)
- Directory: role management (G)

The service account must be added to the shared drive holding the sheet, as a
writer. Groups that hold students or volunteers must allow external members.

## Steps

Each step lands on its own, is verified before the next, and leaves hawk-mod
working if Google is not configured.

0. **Foundation (read-only).** Google credentials reader (optional, not via
   `config()`); sheet client with column allowlist and header check; pure
   parser to a `SheetPerson` model; `npm run cli -- lifecycle plan` prints a
   plan and writes nothing. _Verify:_ parser tests on plain row arrays; header
   drift refuses; dry run against the real sheet.
1. **Slack ID write-back (B).** Look up by identity email, write the ID.
   _Verify:_ dry run lists matches; apply writes; second run is a no-op.
2. **Requirements migration.** _Done: migration 0008, `rules/screening.ts`._ Expiry-based columns with unambiguous names,
   `screening.ts` reads expiry dates, 1-August sanity check, report-only items.
   _Verify:_ tests for each row of the table, including a `YPT Expiry` → training
   mapping test; `SCREENING_VALID_YEARS = 3` with the sanity-check test from
   #17 (a screening expiry more than 3 years out is flagged). Closes #17, and
   updates the "4 years" wording in `CLAUDE.md` and `docs/policy-mapping.md`.
3. **Roster from the sheet (C).** Join existing rows by email once and stamp
   `person_id`; unmatched rows become findings; roles and dates sync add-only;
   role source moves from Slack groups to the sheet; retire `import-roster` and
   the screening modal's writes. _Verify:_ `rosterSync` tests with the sheet as
   source; disappearing and Inactive rows raise findings and change nothing.
4. **Google Groups (D).** Pure planner per group, apply with refusals, `grp-ra`
   announced. _Verify:_ planner tests; held plan raises a finding; dry run
   against real groups before first apply.
5. **Slack group mirror (E).** Reuse `groupAdmin.ts`; drift finding;
   `/hawkmod group` refuses mirrored groups. _Verify:_ hand edit is restored and
   reported.
6. **Invite list and safety net (H).** Morning report section; not-on-roster
   and joined-unscreened findings. _Verify:_ readiness rule tests per role.
7. **Offboarding / reactivation (I).** Approval alerts, suspend / un-suspend.
   _Verify:_ nothing changes without the click; a non-admin click is refused.
8. **Delegated admin roles (G).** **Report only** (decided 2026-09-26). Only a
   Super Admin can grant Groups Admin or Help Desk Admin, and the access plan
   keeps Super Admin to three named people — so `hawk-mod@` is never one.
   hawk-mod reads who holds each role and posts the differences from
   `Mentor_Admin_Roles` as actions ("grant Help Desk Admin to P0012", "revoke
   Groups Admin from P0007") for a Super Admin to do by hand. Needs only the
   read-only role-management scope. _Verify:_ the diff is pure and tested;
   nothing is ever granted.
9. **Running it.** Scheduled run and a run-now control on `/config`.
   `/hawkmod lifecycle plan` and `slack-ids [apply]` already exist — pulled
   forward because production is deployed by hawk_suite's workflow and has no
   shell, so Slack is the only place an administrator can run them. Each later
   step adds its own subcommand there as it lands.

The sheet edits in [Screening requirements](#screening-requirements) were made
on 2026-09-25 (headers verified; the `_Instructions` wording and date validation
are confirmed in step 0). Step 0's header check keeps the two aligned after.

## Later: quarantine instead of a wall

Not scoped yet (noted 2026-09-26). People go stale: forms lapse, a mentor gets
busy and steps away, an alum drifts off. Removing them outright is a bad
experience — someone who comes back finds themselves walled out with no way to
ask to return. The intent is a **quarantine**: a stale member is moved into an
isolation channel (probably split as `#z-youth-inactive` and
`#z-adult-inactive`, replacing today's `#z-inactive`) where they can still ask
to come back but cannot reach other members. Most common for alumni, whose
lifecycle is not fully scoped either. Whatever is built must keep the rules
above: it never ends monitoring by itself, and a quarantined student is still a
student.

## RA access and training

`grp-ra` follows the `RA (Y/N)` flag today. The intent (2026-09-26) is that RA
membership also requires being **cleared** — YPT, background screening and
CORI current — possibly with a **shorter grace period** than other mentors get.
Details are decided at step 4, not before: gating now would empty `grp-ra`,
since no mentor has requirement dates entered yet, and FIRST's 1 August
rollover lapses everyone's training on the same day, which is what a grace
period is for.

## Open

- Whether training completed in May–July expires on the _coming_ 1 August no
  longer affects correctness, since expiry dates come from the sheet. It only
  tunes the sanity check, which should accept either answer (an annual expiry
  on 1 August, at most two rollovers ahead).
- Slack mirror mapping (decided): `grp-students`→`@students`,
  `grp-mentors`→`@mentors`, `grp-student-leads`→`@student-leads`,
  `grp-mentor-leads`→`@mentor-leads`, `grp-ra`→`@ra-adults`.
- Consent (decided for step 3): only `Student_Details.Slack Consent Expiry`.
  No guardian name or form version is stored; the paper forms are the record.
  `/hawkmod consent` and `import-consents` are retired, and existing consent
  rows are kept as read-only history.
- The account hawk-mod acts as in Google is `hawk-mod@redhawkrobotics.org`
  (created 2026-09-26, no admin roles). Its privileges are set in step 4.
