# Lifecycle sync

Status: **steps 0–7 deployed.** The roster has come from the sheet since the
first apply on 2026-09-28 (#25–#28), the Google Groups since the same day
(#32–#37), and the Slack user groups since the first Apply on 2026-09-29
(#38–#42); all three are checked hourly. Onboarding requests, the welcome and
the safety net (step 6) have run hourly since 2026-09-29 (#45–#50), and
offboarding (step 7) since 2026-09-29 (#54–#57), tested end to end on
2026-09-30. Step 8, Help Desk Admin through a group, was re-scoped on
2026-10-02 and is next. The scope was settled with Rachel Moore on 2026-09-25 and 26. The big picture
below was rewritten on 2026-09-27, after a first step 3 design showed it had
never been written down; it replaces the earlier "direction of truth" section.

## What it is

hawk-mod reads the **RHR User Lifecycle Management DB** Google Sheet — the
team's single record of every person — and keeps its own roster, Google
Groups and Slack user groups in line with it. Where a change needs a human,
it asks one.

The sheet's tabs and columns are described in
[`lifecycle-sheet.md`](lifecycle-sheet.md); this document is what hawk-mod
does with them, and decides wherever the two touch.

The burden this removes is group management and keeping hawk-mod's roster by
hand. Account creation stays manual: hawk-mod asks, a Super Admin creates each
mentor's Google account and types the address into the sheet. Mentors are added
rarely; groups change constantly.

## The big picture

Decided 2026-09-27.

### Where each fact lives

| Fact                                                               | Source of truth                   | Who changes it                                                                        | What hawk-mod does                                                                                   |
| ------------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Who a person is: role, Active/Inactive, requirement dates, consent | **The sheet**                     | `grp-ra`, and the Super Admins (Dan, Ty, Rachel)                                      | Reads it. Writes back only a Slack User ID                                                           |
| Whether someone has a Slack account                                | **Slack**                         | A human invites or deactivates (no API on Slack Pro)                                  | Compares with the sheet; prompts a human                                                             |
| Whether someone has a Google account                               | **Google**                        | A human creates it                                                                    | Suspends or un-suspends, only after a click                                                          |
| Delegated admin roles                                              | **The sheet**, carried by a group | `grp-ra` and the Super Admins (the sheet); an RA's or Super Admin's click (the group) | Keeps the role's group in line with the sheet, every change on a click; reports any other admin      |
| Google Group and Slack user group membership                       | **Copies of the sheet**           | hawk-mod                                                                              | Google: adds automatically, removes someone leaving after a click. Slack: every change after a click |
| Who is monitored, and as what                                      | **hawk-mod's database**           | hawk-mod adds; a person ends                                                          | Adds on its own; ends only after a click                                                             |
| Messages, findings, history                                        | **hawk-mod's database**           | hawk-mod                                                                              | Records                                                                                              |

### How data flows

```
             humans edit
                  │
              THE SHEET  ◄───── hawk-mod writes back Slack User IDs only
                  │  read hourly, and on "sync now"
                  ▼
        hawk-mod's database  ◄── compared with Slack and Google accounts:
          │            │          anything unexpected is a finding
          │            └──► Google Groups, Slack user groups
          │                 (copies: Google joins automatically; Slack
          │                  changes and anyone leaving wait for a click)
          ▼
   prompts to a human, each answered with a button:
   invite to Slack · end monitoring · make adult · suspend Google account ·
   fix a sheet cell · change an admin role
```

Data flows one way. **hawk-mod never takes a copy as a source.** The Slack
user groups are for mentions and channel access; nothing reads them to decide
who is a student. A broken group sync leaves `@students` out of date, and
changes nobody's monitoring. (Before step 3, roles came from `@students` /
`@mentors`, as they had since before this work.)

### How updates are made

- **Automatic**, when a change adds safety or only updates a copy: adding a
  person to the roster, raising monitoring (a mentor row that turns out to be
  a student), requirement dates and consent, Slack User ID write-back, and
  adding people to Google Groups.
- **Prompted to a human**, when a change lowers monitoring, touches an
  account, or takes away someone's access: ending someone's monitoring,
  removing someone who is leaving from their groups, moving someone out of
  `student`,
  inviting to Slack, deactivating in Slack, suspending a Google account,
  changing an admin role, fixing a sheet cell hawk-mod could not read. The
  prompt is a finding or alert with a button, gated on `administrator()` and
  recorded. It does not need an answer immediately; nothing is less safe while
  it waits, because waiting always means the more cautious state.

### When it runs, and what happens when it cannot

hawk-mod reads the sheet **hourly**, and on demand: "sync now" in Slack
(`/hawkmod lifecycle sync`) and on `/config`, so whoever edited the sheet need
not wait. Every run can be a dry run first.

**When a run cannot finish, things stay as they were.** An unreadable sheet, a
renamed column, or a group change the planner refuses leaves the roster and
the groups exactly as the last good run left them, and raises a finding. It
never reads as an empty sheet.

### Why hawk-mod keeps its own copy

The DM rules decide "is this a student?" on every message, so they read
hawk-mod's `people` table, never the sheet:

- if the sheet is unreadable, a live-read roster is empty and every
  conversation classifies as student-free — hawk-mod goes quiet by going blind;
- the sheet can lose a row with no author and no reason, and a lost row must
  never end someone's monitoring;
- `role_changes` / `screening_changes` are the only dated history (Slack's
  audit API is Grid-only);
- with every Active person already on the roster, a student who joins Slack is
  recognized at `team_join`, without waiting for the next sheet read;
- findings, consents and verdicts reference `people.id`.

## Who is where

| Role               | Identity key (sheet)                                       | Google account          | In Slack?                 | hawk-mod roster   |
| ------------------ | ---------------------------------------------------------- | ----------------------- | ------------------------- | ----------------- |
| Mentor             | `Mentor_Details.RHR Email`                                 | Yes, created by a human | Yes, once screened        | `adult`           |
| Student            | `Student_Details.School Email`                             | No                      | Yes, once consent current | `student`         |
| Volunteer / Alumni | `People.Personal Email`                                    | No                      | **No**                    | not on the roster |
| Parent             | `Emergency_Contacts.Email` (a student's `Parent/Guardian`) | No                      | **No**                    | not on the roster |

Google Group membership uses one address per person: a mentor's RHR Email, a
student's School Email, and a volunteer's or alumnus's Personal Email. **A
mentor is only ever added by RHR Email** — the mentor groups are domain
accounts only in the RHR Systems Access & Security Plan, because adults reach
students from official accounts — and a mentor without one is left out and
reported. **Volunteers are in `grp-volunteers` and nothing else that reaches
students**: never the Red Hawk shared drive, never Slack (decided 2026-09-27).
With no youth access they need no CORI, and hawk-mod tracks none for them.
(The access plan's matrix still gives `grp-volunteers` edit rights on the Red
Hawk drive and public Slack; that is being corrected there.) **A student's
Personal Email is never used to add them to a group or
to Slack** — it may only help match records. A student with no School Email is
left out and reported. Groups containing students and volunteers hold external
addresses, which the groups must be set to allow (one-time Google setup).

## Screening requirements

Expiry dates come from the sheet **as written**. hawk-mod never computes one:
FIRST expires annual items on **1 August** (the season rollover), not a year
after completion — two mentors' YPT and Data Privacy, taken 13 Aug and 25 Sep
2026, both expire 1 Aug 2027. The windows below survive in code only as a
sanity check that flags a probable typo.

| Requirement                 | Clock            | Needed for access | Needed to count as a screened adult | Sheet column (`Mentor_Details`) |
| --------------------------- | ---------------- | ----------------- | ----------------------------------- | ------------------------------- |
| CORI + fingerprints (Mass.) | 3 years          | **yes**           | **yes**                             | `CORI Expiry`                   |
| Youth Protection Training   | annual, to 1 Aug | no — alerts       | **yes**                             | `YPT Expiry`                    |
| Background Screening        | 3 years          | no — alerts       | **yes**                             | `Background Screening Expiry`   |
| Consent & Release           | annual, to 1 Aug | no — reported     | no — reported                       | `Consent & Release Expiry`      |
| Data Privacy for Mentors    | annual, to 1 Aug | no — reported     | no — reported                       | `Data Privacy Expiry`           |
| Mentor Ready badge          | one-time         | no — reported     | no — reported                       | `Mentor Ready Completed`        |

### Two gates, named apart

Decided 2026-09-27.

| Gate                           | Requires                                  | What it decides                                                 |
| ------------------------------ | ----------------------------------------- | --------------------------------------------------------------- |
| **May have access**            | CORI current                              | Joins any mentor Google Group; is invited to Slack              |
| **Counts as a screened adult** | YPT + Background Screening + CORI current | Counts toward the two-adult rule (unchanged: `isScreenedAdult`) |

**CORI is the only hard blocker for access.** It is the school district's line:
no youth access until it is done. A Google Group is youth access —
`grp-mentors` gives edit rights on the Red Hawk drive, where students work — so
the same gate covers groups and Slack. Before it, a mentor may have their RHR
account, and nothing else.

**YPT and Background Screening continue to alerts.** A mentor with CORI current
but YPT lapsed is in Slack and in the groups, gets a `screening_lapsed`
finding, and does not count as one of the two screened adults — so a group DM
where they are one of the two adults with a student is flagged. This also
means FIRST's 1 August rollover, which lapses everyone's training on the same
day, removes nobody: it raises reminders.

The screened-adult definition is FIRST's Youth Protection Program, not the
district's, and it is not loosened (CLAUDE.md: do not loosen
`isScreenedAdult`). The two gates are separate functions with separate names in
code, so neither can be mistaken for the other: `mayHaveAccess` and
`isScreenedAdult` in `rules/screening.ts`, and on sheet rows `hasAccess` and
`isCleared` in `domain/lifecycle/groups.ts`.

**Joining waits for CORI; a lapse waits for a person** (decided 2026-09-27).
The gate works in one direction on its own: a mentor whose CORI becomes current
is added to their groups and to the Slack invite list automatically. A mentor
whose CORI _lapses_ is not removed from anything. hawk-mod raises a
`cori_lapsed` finding naming the mentor and the groups they are in, with a
**Remove from mentor groups** button, gated on `administrator()` and recorded,
and a reminder that an admin must remove them from Slack (hawk-mod cannot, on
Pro). Until someone clicks, the group sync keeps a lapsed mentor where they
are: it neither adds them anywhere new nor takes them out. After the click
they stay out until their CORI is renewed, then rejoin automatically. The
finding closes when the CORI is renewed, or when they are out of every mentor
group and out of Slack.

**Sixty days before a CORI expires, hawk-mod warns** (decided 2026-09-27): a
`cori_expiring` finding in the alert channel, and a direct message to the
mentor in Slack if they are there. Once per expiry date; entering the renewed
date on the sheet closes it. The lapse itself should never be a surprise.

**Before CORI, the account exists but joins nothing — and that is the whole
control.** A Google account in no group can still email a student's school
address directly, and can open anything shared with everyone at the domain.
Holding new accounts in a restricted organizational unit would close that, and
was considered and **declined** on 2026-09-27 as more setup than it is worth.
The remaining gap is covered by practice rather than by the system: nothing
student-related is shared domain-wide, and adults reach students through the
groups and Slack, where the whole group sees it.

"YPP" names the program, never a column: the old sheet header meant training
while hawk-mod's old `ypp_completed_on` meant screening. Migration 0008 gave
hawk-mod's columns unambiguous names and moved the screening window from 4
years to 3 ([FRC2713/hawk-mod#17](https://github.com/FRC2713/hawk-mod/issues/17)).

Students: `Student_Details.Slack Consent Expiry` is their consent. No guardian
name or form version is stored; the paper forms are the record.

## Capabilities

| #   | Capability                            | Applies                   | Target                                                                                                                                          |
| --- | ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | Read and validate the sheet           | —                         | column allowlist; refuses to run if headers drift                                                                                               |
| B   | Write Slack User ID back to the sheet | automatically             | `Mentor_Details` / `Student_Details` `Slack User ID`                                                                                            |
| C   | Keep hawk-mod's roster in step        | add auto, end on click    | `people`: roles, status, requirement dates, consent                                                                                             |
| D   | Keep computed Google Groups right     | join auto, leave on click | `grp-mentors`, `grp-students`, `grp-volunteers`, `grp-parents`, `grp-alumni`, `grp-mentor-leads`, `grp-student-leads`, `grp-all-team`, `grp-ra` |
| E   | Copy chosen groups to Slack           | every change on click     | Slack user groups, via `slack/groupAdmin.ts`                                                                                                    |
| F   | ~~Create Workspace accounts~~         | **out of scope**          | done by hand; H prompts for it                                                                                                                  |
| G   | Help Desk Admin through a group       | every change on click     | a security group carrying Help Desk Admin, computed from `Mentor_Admin_Roles`; any other admin reported                                         |
| H   | Onboarding prompts                    | prompt                    | `onboarding-channel` (`#bot-onboarding-requests`): Google accounts to create, Slack invites; a count in the morning report                      |
| I   | Offboarding / reactivation prompts    | on click                  | end monitoring, Google suspension, Slack deactivation reminder                                                                                  |

## Groups

**Joining is automatic; leaving waits for a click** (decided 2026-09-27).
When the sheet puts someone in a group, the next run adds them. When a person
is **leaving** — their row turns Inactive, loses the role the group is for (a
graduate becomes Alumni), disappears, or their CORI lapses — the sync takes
them out of nothing. It keeps them in the groups they are in and raises a
finding with a **Remove from groups** button, gated on `administrator()` and
recorded (see [Leaving the team](#leaving-the-team)). After the click they
stay out until the sheet declares them again.

The only removals that follow the sheet on their own are changes _within_ the
team that take away a lead or RA flag in a _Google_ group — someone who stops
being a Mentor Lead leaves `grp-mentor-leads` on the next run, announced like
every `grp-ra` change. Slack groups change only on a click; see below.

The refusals `domain/rules/groupMembership.ts` already carries stay as a net
under all of it: a plan that would empty a group or remove more than a quarter
of it is held and raised as a finding, because a sheet mistake must not empty
`grp-students`. The finding carries an **Apply anyway** button, gated and
recorded.

**Parents are part of a student's record**, not people of their own: they
have no Person ID and no role, and exist only as rows on the
`Emergency_Contacts` tab, keyed by their student's Person ID. `grp-parents`
is the `Email` of every `Emergency_Contacts` row where:

- the row's Person ID is an **Active Student** — `Emergency_Contacts` covers
  every person, so a mentor's own parent, also `Parent/Guardian`, must not
  land in `grp-parents`;
- `Relationship` is `Parent/Guardian` — not `Grandparent`, `Spouse`,
  `Sibling`, `Friend` or `Other`;
- `Rank` is not `99`, which the sheet defines as "on file but not to be
  contacted" — a mailing list is contact (decided 2026-09-27).

Emails are lower-cased and de-duplicated. Because every group is recomputed
from the sheet on each run rather than edited one removal at a time, siblings
need no special handling: when a student graduates or is deactivated, a
parent still listed for an Active younger sibling is still in the computed
set and stays; a parent no Active student lists drops out. A student with no
parent email is reported by Person ID, like any other missing address.

hawk-mod adds exactly four `Emergency_Contacts` columns to its allowlist —
`Person ID`, `Email`, `Relationship`, `Rank` — and never a contact's name or
phone. Parents have no Slack, are not on the roster, and are not in
`grp-all-team`. Their addresses are personal, which is right for adults (the
access plan has `grp-parents` allow external members); nothing here ever puts
a _student's_ personal address in a group.

Groups are kept **flat**, as the access plan specifies: each Google Group
holds its people directly and never contains another group, because nested
groups behave inconsistently across Drive, Calendar and Slack. The subset
relationships — leads inside their role group, both role groups inside
`grp-all-team` — are enforced by the sync (`SUBSETS` in
`domain/lifecycle/groups.ts`, with a test), not by Google.

**Mentors join groups only once they may have access — CORI current**
([Two gates](#two-gates-named-apart)). That applies to `grp-mentors`,
`grp-mentor-leads`, `grp-ra` and `grp-all-team`. `grp-all-team` is every
Active student and every Active mentor with CORI current — not volunteers,
parents or alumni. (This replaces the 2026-09-26 decision to include every
Active mentor, screened or not.) A mentor who is also a parent can be on
`grp-parents` under their personal address before their CORI is done: the
Parents drive is kept apart from students by design.

`grp-ra` may additionally require being a screened adult; see
[RA access and training](#ra-access-and-training).

**Copied to Slack (E):** `grp-students`→`@students`, `grp-mentors`→`@mentors`,
`grp-student-leads`→`@student-leads`, `grp-mentor-leads`→`@mentor-leads`,
`grp-ra`→`@ra-adults`. Each Slack group is found by its permanent ID in
`SLACK_GROUP_IDS` (`domain/lifecycle/slackGroups.ts`), in code like the Google
IDs, never by handle; an ID whose group has another handle is the wrong group
and nothing is applied to it (decided 2026-09-28, replacing a DB setting
keyed by handle). Each
Slack group is computed from the sheet by the same `intendedGroups` as the
Google group, restricted to people with a Slack account — a mentor not yet
invited is in the Google group and absent from the Slack one, which is not
drift.

**Every Slack group change is applied by a click, as the person who clicked**
(decided 2026-09-27). Slack accepts group edits only from an administrator's
own token — the bot cannot, since §6 keeps group editing admin-only — so rather
than hold a standing administrator's token for an automatic copy, hawk-mod
keeps no such token at all:

- Each run compares every copied Slack group with the sheet and keeps **one**
  `slack_groups_differ` finding up to date: _Slack groups differ from the
  lifecycle sheet: add 3 to @students, remove 1 from @mentor-leads.
  [Apply]_. No difference, no finding.
- **Apply** is gated on `administrator()`. It re-reads the groups and the
  sheet inside `groupAdmin.ts`'s lock, applies what differs _then_ — not what
  the finding said an hour ago — with the clicker's own group-editing grant,
  and records the clicker in `group_changes`. A clicker who has not granted
  group editing (`/slack/authorize-groups`) is sent there first, as
  `/hawkmod group` does today.
- Removals of someone **leaving** are the same thing reached from their own
  finding: **Remove from groups** and **Remove from mentor groups** edit the
  Slack copies with the clicker's grant too.
- A hand edit to a copied group shows up as a difference. Someone removed
  by hand who belongs is put back by the next Apply, which names them so the
  editor learns it did not stick; someone added by hand who does not belong
  is held and gets their own finding, like anyone leaving. It changes
  nobody's monitoring.

Nothing safety-relevant waits on this: roles come from the sheet, not from
these groups. The cost is that someone new appears in `@students` when an
administrator next clicks Apply, not the moment they join — one more step in
an onboarding flow that already has a human in it. `/hawkmod group
add|remove` refuses copied groups ("edit the lifecycle sheet") and keeps
working for the rest.

## What hawk-mod asks a human to do

Onboarding requests go to the channel in the `onboarding-channel` setting —
today `#bot-onboarding-requests`, renamed from `#bot-slack-invite-requests` on
2026-09-27. Like `alert-channel`, it is stored by channel ID, so a rename
breaks nothing, and it is shown as `#name (ID)`. One message per person per
task, because each is a task that can be acted on and marked done; a daily list
repeats itself until nobody reads it. The channel is in the Adult-only
Restricted tier of the access plan, which is where students' school addresses
may appear. The morning report carries only a count of what is still waiting.
It is separate from `#bot-onboarding-notifications`, which announces rather
than asks.

**Google accounts (H).** The address a mentor has agreed to goes on the sheet
first, as their RHR Email — not everyone wants `firstname@` — and the account
is created from it (corrected with Rachel, 2026-09-29, after the first dry run
called such an address a problem). So when an Active mentor has no Google
account, hawk-mod asks for one: _Create a Google account for P0073 Alexa …
at alexa@redhawkrobotics.org, the RHR Email on the lifecycle sheet. If that
address is a typo, fix the sheet instead._ With the RHR Email blank, it asks
for the account and for the address to be typed in. It does not wait for
CORI: the account may exist before CORI is done, it just joins no group. The
request is done when Google has the account. A Super Admin creates it —
Google's Help Desk Admin role cannot create users. An RHR Email that belongs
to a suspended account, or is an alias, is its own request: the groups run
compares addresses, so an alias would be re-added every hour.

**Slack invites (H).** Slack Pro has no invite API, and open domain sign-up
would let a mentor join before CORI. So no domain sign-up: hawk-mod posts
to the onboarding channel when a person becomes ready — a mentor whose CORI is
current, or a student whose Slack Consent is
current, with no Slack account yet — once per person, with the address to
invite (RHR Email or School Email; never a personal one). An admin pastes the
address into Slack's invite dialog. The person leaves the list when they
appear in Slack and their ID is written back. Safety net: a Slack member who
is not a sheet mentor or student is a finding (`unknown_account`), as is a
mentor in Slack whose CORI is not current.

### Leaving the team

When the sheet stops declaring someone — their row turns Inactive, loses its
Student or Mentor role (a graduate becomes Alumni), or disappears — nothing is
taken away on its own. hawk-mod keeps monitoring them, keeps them in their
groups, and raises **one finding per person** with a button for each thing
that could be taken away, each gated on `administrator()` and recorded:

- **End monitoring** (step 3). `/hawkmod deactivate` still works too.
- **Remove from groups** (step 4): their computed Google groups and the Slack
  copies, and — for a student — their parents from `grp-parents`, unless a
  sibling is still Active. From step 7 it also covers every other group
  Google's directory says they are in, including ones the sheet does not
  track (`grp-orders`, `grp-equipment`, `grp-contact`, `grp-grants`), all
  listed on the finding before the click.
- **Suspend Google account** (step 7).

Plus reminders for what hawk-mod cannot do itself: an admin deactivates them
in Slack (manual on Pro). From step 8, Help Desk Admin comes with a group,
so **Remove from groups** takes it away too; any other admin role is reported
for a Super Admin to remove. The buttons are independent — ending monitoring and removing
access are different decisions. Inactive → Active raises the reverse:
un-suspend, with a reminder to restore roles; monitoring and group membership
resume on their own, because they only add.

Graduation raises one finding per senior, each needing its clicks. That is the
cost of never removing anyone unasked; a bulk "remove these" for a named list
can follow if it proves heavy.

**Nothing deletes an account.** Offboarding suspends.

## Invariants

1. **The sheet cannot make hawk-mod see less.** Lowering monitoring is always
   a person's click.
2. **Minimum-necessary PII.** The sheet holds minors' addresses, birthdays,
   medical notes and race/ethnicity. hawk-mod reads an explicit column
   allowlist and nothing else reaches SQLite, logs, or alerts.
3. **Google credentials are environment, never `SETTINGS`** — like
   `TOKEN_ENCRYPTION_KEY`. Sheet ID and group mapping are DB settings. Reading
   them must not go through `config()`, which would break the CLI at import
   time.
4. **The sheet is required once step 3 is applied** (decided 2026-09-27).
   Red Hawk is the only install, and keeping Slack groups alive as a second
   source of roles is what made the design tangle. Before step 3 hawk-mod
   works without Google, as it always has; after it, missing credentials are
   a finding and the roster stays as it was.
5. **Every approval is a button gated on `administrator()`** and recorded.
6. **The plan is pure.** Sheet rows in, diff out, in `domain/`, testable with
   plain objects like the rest.

## Group membership grants data access

`grp-ra` is an **organizer** of the lifecycle sheet itself. Once D manages it
from `RA (Y/N)`, setting that flag gives someone full access to every student's
personal data. The sync announces `grp-ra` changes in the alert channel even
when applied automatically. The sheet's editors are `grp-ra` itself and the
three Super Admins (Dan, Ty and Rachel), so `grp-ra` grants its own
membership. A sheet mistake that clears RA flags cannot lock everyone out: the
sync will not empty `grp-ra` or remove more than a quarter of it in one run,
and the Super Admins' access does not depend on the group.

## Google setup (one-time, manual)

A service account with domain-wide delegation impersonating an administrator,
scoped to:

- Sheets (read, plus write for B)
- Directory: groups and group members (D)
- Directory: users (read, plus suspend for I)

The service account must be added to the shared drive holding the sheet, as a
writer. Groups that hold students or volunteers must allow external members.

## Steps

Each step lands on its own and is verified before the next. Each adds its
commands under `/hawkmod lifecycle`, because production has no shell and Slack
is where an administrator runs them.

0. **Foundation (read-only).** _Done._ Credentials reader, sheet client with
   column allowlist and header check, pure parser, `lifecycle plan`.
1. **Slack ID write-back (B).** _Done._ `lifecycle slack-ids [apply]`.
2. **Requirements migration.** _Done._ Migration 0008, expiry dates,
   `rules/screening.ts`, #17 closed.
3. **The roster from the sheet (C).** Hourly and "sync now". Adds apply on
   their own; ending monitoring and leaving `student` are buttons. Dates and
   consent from the sheet. Roles stop coming from Slack groups. See the
   [step 3 design](#step-3-design--the-roster-from-the-sheet).
   _Verify:_ planner tests for every row of its table; nothing lowers
   monitoring without a click; an unreadable sheet changes nothing; dry run
   against the real sheet before the first apply.
4. **Google Groups (D).** Pure planner per group: joining applies, leaving
   waits for **Remove from groups**; refusals held with **Apply anyway**;
   `grp-ra` announced; `grp-parents` from the emergency contacts; mentors only
   with CORI current, through a new access gate kept apart from the
   screened-adult one. **Before the first apply, every current mentor's CORI
   Expiry should be on the sheet** — otherwise every current mentor raises a
   finding asking whether to remove them; the dry run counts them. _Verify:_
   planner tests, including a parent kept for an Active sibling and dropped
   only when the last child's removal is clicked, a 60-day `cori_expiring`
   warning raised once per expiry date, a mentor with CORI but lapsed YPT
   kept in groups, and an Inactive person and a lapsed-CORI mentor
   kept where they are until the click; a non-admin click is refused; dry run
   against real groups before first apply.

   Google setup done 2026-09-28 (docs/google-setup.md, Part 2). Groups are
   found by permanent ID, never name or address (decided 2026-09-28; Red
   Hawk's are named `grp-…` but addressed `mentors@`, `students@` and so on). Built in four
   pull requests (planned 2026-09-28): (1) the pure planner —
   `mayHaveAccess`, `grp-parents` from `Emergency_Contacts`, and
   `domain/lifecycle/groupPlan.ts` sorting every difference into join,
   automatic (a lead or RA flag off) and held; (2) reading the real groups as
   `hawk-mod@` and a `/hawkmod lifecycle groups` dry run; (3) applying joins,
   hourly, with `grp-ra` announced and **Apply anyway** on a refused plan;
   (4) **Remove from groups**, `cori_lapsed` and `cori_expiring`. **An address
   in a group that the sheet does not account for is held**, like someone
   leaving, rather than removed (decided 2026-09-28).

   Built as planned, with two differences from the text above, both decided
   2026-09-28 while building part 4:

   - **Two alerts for someone leaving, not one.** The roster raises
     `sheet_undeclared` (End monitoring); the groups run raises
     `group_member_held` (Remove from groups) — one per person, listing every
     group they are held in and, for a student, their parents' grp-parents
     entry unless a sibling keeps it. Monitoring and access are separate
     decisions and separate hourly jobs, and a mentor whose CORI lapsed gets
     `cori_lapsed` (Remove from mentor groups, plus the Slack reminder)
     instead.
   - **An address the sheet does not account for** gets its own
     `group_member_held` alert, showing the address partly hidden
     (`k…@gmail.com`): enough to find in the Admin console, not the whole
     address in Slack.

   Every button re-reads the sheet and the groups at the click and removes
   only what is still held. `cori_expiring` runs hourly once the roster comes
   from the sheet, and messages the mentor in Slack once per expiry date.

5. **Slack user groups (E).** _Done (#38–#42, first Apply 2026-09-29)._ Same computed membership, copied to Slack by an
   administrator's **Apply** click on one `slack_groups_differ` finding, with
   the clicker's own grant; `/hawkmod group` refuses copied groups. _Verify:_
   nothing changes without the click; Apply applies the difference as re-read
   at click time; a non-admin click and a clicker without a grant are refused;
   a hand edit is undone by the next Apply, reported, and changes no role.

   Decided 2026-09-28, before building:

   - **The Google rule, not "every difference".** Apply adds whoever the
     sheet puts in a copy — someone removed by hand is put back — and removes
     only a lead or RA flag turned off. Someone leaving (Inactive, role gone,
     CORI lapsed) or an account the sheet does not account for, including
     someone added by hand to a group they have no role for, is **held**:
     kept, never added anywhere, and removed only from their own
     `group_member_held` or `cori_lapsed` finding, whose buttons reach the
     Slack copies too. A CORI lapse is a decision with a name on it, not one
     line in a list.
   - **Default channels are the point.** Adding someone to a copy adds them to
     its default channels, which is how a new member lands in the right
     channels; that is why joining `@mentors` waits for CORI. Removal from a
     group leaves channels alone, and that is accepted.
   - **One finding, redrawn in place.** `slack_groups_differ` is updated each
     run and does not ping again when what differs changes; it alerts anew
     only after closing and coming back.
   - A failed hourly Google Groups run is a finding (`google_group_held`,
     `run_failed`), closed by the next clean run — until now it was only a
     log line on a host nobody has a shell on.

   Built in four pull requests: (1) the pure planner
   (`planSlackCopies`, `decideSlackCopies`), with the stricter sheet email
   check and the failed-run finding; (2) `/hawkmod lifecycle slack-groups`,
   a read-only dry run that also lists each group's default channels; (3)
   the hourly finding with **Apply** and **Apply anyway**; (4) `/hawkmod
group` refusing copies, the leaving buttons reaching Slack, and the
   `student-group` / `mentor-group` settings retired.

   Built that way, with two details settled while building part 4
   (2026-09-28): `managed-groups` stays, as the list of other groups
   `/hawkmod group` may edit, and refuses a copy; and someone held in a Slack
   copy is gathered into the same one-per-person `group_member_held` /
   `cori_lapsed` alert as the Google Groups, so one **Remove from groups**
   takes them out of both — the Slack half as the clicker, with their grant.
   A Slack account the sheet does not know gets its own alert, named by its
   Slack name. The hourly Google Groups run owns these alerts and reads the
   Slack copies to raise them; if Slack cannot be read it raises what Google
   shows and closes nothing. "Sync now" (`/hawkmod lifecycle sync`) runs the Slack groups check
   after the roster, so a sheet edit's Slack difference and its **Apply**
   appear without waiting for the hour.

6. **Onboarding requests and safety net (H).** Google account requests,
   RHR Email directory check, Slack invites, all in the `onboarding-channel`
   setting's channel.
   _Verify:_ readiness rule tests per role; a request is posted once and
   closes when the sheet is filled in; a mentor in Slack without CORI is a
   finding.

   Planned and built 2026-09-29 in four pull requests: (1) the pure planner,
   `domain/lifecycle/onboarding.ts` (#46); (2) reading Google's user
   accounts as `hawk-mod@` (a third delegated scope, `user.readonly`, and
   Users → Read on its role: docs/google-setup.md, Part 3) and the
   `/hawkmod lifecycle onboarding` dry run (#48); (3) the requests, posted
   hourly, and the welcome (#49); (4) the safety net and these docs.
   Decided with Rachel along the way:

   - **Super Admins alone create Google accounts** for now; a custom
     create-only role can follow if that becomes a bottleneck.
   - **The RHR Email goes on the sheet before the account exists.** The
     first dry run called such an address a problem; it is the ordinary
     "create this account" request, and names the address. Only a
     suspended account or an alias is an RHR Email problem.
   - **Only Active mentors' RHR Emails are checked.**
   - **`onboarding-channel` unset means the alert channel**, and the dry run
     and `/hawkmod config` say so.
   - **A request's student address is never in its summary**, which
     `/hawkmod findings` and the morning report print; it is a separate line
     on the posted request alone. The morning report only counts requests.
   - **An alert remembers its channel** (`findings.alert_channel`), so a
     request is redrawn where it was posted.
   - **A mentor in Slack without CORI is one `cori_lapsed` alert**, not a
     second kind: the same alert as being held in a mentor group, with
     **Remove from mentor groups** only while they are in one. After that
     click it stays open, saying only that they are in Slack, until they are
     deactivated there or their CORI is on the sheet.
   - **Welcome and one reminder.** hawk-mod messages an adult the moment
     they join Slack (or are first linked), with the landing page, the
     workspace address and where to ask (`#admin-official`, by ID), and once
     more seven days later if they have not enrolled; then nothing — the
     administrators' `adult_not_enrolled` alert carries it from there.
     Adults already in Slack when this shipped were recorded and sent
     nothing. It replaces the Workflow Builder welcome, and "X enrolled"
     goes to `announcement-channel` when the enrollment actually happens.

7. **Offboarding / reactivation (I).** _Done (#54–#57, tested
   2026-09-30)._ Suspend / un-suspend on the leaving
   finding, and "Remove from groups" extended to every live group. _Verify:_
   nothing changes without the click; a non-admin click is refused; the
   removal covers groups the sheet does not compute.

   Planned 2026-09-29 in four pull requests, and five after the first dry
   run: (1) the pure planner, `domain/lifecycle/offboarding.ts` (#54); (2)
   reading every group in the Workspace, and whether an account holds an
   admin role, and a `/hawkmod lifecycle offboarding` dry run that posts
   nothing — no new Google setup (#55); (3) two more lists in that dry run,
   below (#56); (4) the alerts and buttons, which need `admin.directory.user`
   delegated and **Users → Update** on `hawk-mod@`'s role (#57);
   (5) docs, and whatever the first clicks show. The first clicks are a test,
   on a throwaway person and Google account Rachel adds to the sheet: Remove
   from groups has never been clicked in production. Decided with Rachel
   before building:

   - **One accounts alert per person leaving**, in the alert channel beside
     their other leaving alerts: **Suspend Google account** while their
     account is active, and a line asking an admin to deactivate their Slack
     account, which Slack Pro gives hawk-mod no way to do. It closes on its
     own when Google shows the account suspended and Slack shows the account
     deactivated.
   - **Suspend is offered when a mentor is Inactive, their row is gone, or
     they are no longer a Mentor** — a mentor turned volunteer should not
     keep an account that reaches the Red Hawk drive. A lapsed CORI is not
     leaving, and suspends nothing.
   - **Leaving is per address.** An RHR Email is theirs while they are an
     Active Mentor, a School Email while an Active Student, a Personal
     Email (volunteers and alumni) while Active. A mentor's or student's
     Personal Email is never looked for, and an address anyone Active still
     uses — including as an Active student's parent — is never left behind.
   - **Restore** is a button on the existing "suspended account" onboarding
     request (step 6), re-reading the sheet and Google at the click, with a
     reminder to give back any admin role. Monitoring and groups already
     come back on their own.
   - **Remove from groups reaches every group in the Workspace**, not just
     the nine the sheet computes, including where the person is an owner or
     manager; the alert lists each group and role before the click. Someone
     leaving who is only in untracked groups gets the alert too.
   - **An account holding any admin role is not offered Suspend.** Google
     lets only a Super Admin change another admin's account — Help Desk
     Admin and custom roles included — so the alert asks a Super Admin to
     remove the role first.

   Google setup Part 4 (the `admin.directory.user` scope, and a privilege
   to suspend on the role) was done 2026-09-29, before part 4 was
   deployed — and widened at the test; see below.

   Decided after the first dry run (2026-09-29), which found nobody
   leaving and eight groups the sheet does not compute — `bonfire`,
   `grp-contact`, `grp-equipment`, `grp-grants`, `grp-orders`, `Kitchens`,
   `MelroseKitchenTour` and `Test1`:

   - **All eight are team groups**, and Remove from groups covers them.
   - **Someone in them the sheet does not have is a warning, never a
     removal**: these groups may hold outside collaborators, and that may
     need revisiting if there come to be more of them. An address counts as
     on the sheet if it is anyone's RHR, School or Personal Email, or a
     parent address — except a current student's Personal Email, which is
     never a way into a group. The warning shows the address partly hidden.
   - **Google accounts no RHR Email reaches are listed** in the dry run, to
     read once before deciding whether they should become an alert — the
     Google counterpart of Slack's `unknown_account`. Every one is a team
     account, so it is named in full. The second dry run found two,
     `calendar@` and `hawk-mod@`, and six outsider entries from at most
     three Gmail addresses in `grp-contact`, `grp-grants`, `Kitchens` and
     `MelroseKitchenTour`.
   - **Each becomes a warning** (`google_account_unknown`, and
     `group_outsider` once per address, listing its groups), acknowledged
     once for a shared account or a known collaborator — no list of shared
     accounts kept in code. `hawk-mod@` itself is never warned about.
   - **Step 7 is finished only after a test** on a throwaway person and
     Google account: join, leave, Remove from groups (its first real use),
     Suspend, come back, Restore, then clean up by hand. The Slack half is
     a reminder and is not part of the test.

   Two fixes found reading the alerts during step 7, each its own pull
   request: an address in grp-parents that no student lists read "is in ."
   (#58); and **Gmail addresses are compared as Gmail compares them** —
   without dots, `+tags` or `googlemail` (`domain/lifecycle/address.ts`,
   #59). P0063's parent was on the sheet with a dot and in grp-parents
   without one, so every hourly run "added" them again (Google answered
   "already a member") and held the group's spelling as unknown. Other
   domains are compared lower-cased and otherwise as written. The key is
   only for comparing: Google is always sent the sheet's or the group's own
   spelling.

   **The test, 2026-09-30**, on P0074, a throwaway mentor row, and
   `offboarding-test@`, a throwaway account:

   - Joined grp-mentors and grp-all-team from the sheet, and grp-orders by
     hand.
   - Set Inactive: the three leaving alerts — End monitoring,
     `offboarding_accounts` with Suspend, and `group_member_held` listing
     grp-mentors, grp-all-team and grp-orders — read as intended.
   - **Remove from groups, its first use in production**, removed all
     three ("Google Groups: Applied: 0 added, 2 removed. Other groups:
     removed from grp-orders."), confirmed in the Admin console.
   - **Suspend was refused** with only Users → Update → Suspend users on
     the role, and still refused with Organizational Units → Read added.
     **Rachel decided to give `hawk-mod@` the full Users → Update**
     (without Create or Delete), accepting that it can also reset a
     non-admin's password; then Suspend worked, and the alert closed.
   - Set Active again: the "suspended account" onboarding request came with
     **Restore Google account**, and restored the account. P0074's Slack
     invite request stayed away while the account was suspended — an invite
     to an address that reaches nobody is held back until the RHR Email
     works (step 6's rule) — and came back after Restore. The groups run
     re-added them to grp-mentors and grp-all-team, and not to grp-orders,
     which hawk-mod never adds to.
   - The Slack half is untested: the test person was never put in Slack.

   Built as planned, with one difference: the privilege above.

8. **Help Desk Admin through a group (G).** Re-scoped with Rachel on
   2026-10-02; this replaces the 2026-09-26 "report only" plan, which turned
   out to need something Google does not offer. Google lets only a Super
   Admin see who holds which admin role, and its privilege list has nothing
   a custom role could hold to change that — so `hawk-mod@` could never
   have read the assignments it was to report on.

   **What it is for.** Three Super Admins (Dan, Ty, Rachel) run Google, and
   a few more people should be able to help with **password resets**. Three
   things must hold:

   - someone who is meant to have that power has it;
   - someone who should no longer have it, does not;
   - someone who leaves and comes back does not come back with a power
     nobody meant to give them again.

   Decided 2026-10-02:

   - **Help Desk Admin is the only delegated role.** It resets the passwords
     of non-admin accounts, which means it can sign in as any mentor, so it
     is treated like access to the mentor groups. **Groups Admin is not
     given out**: who is in which group is the sheet's job — hawk-mod edits
     the nine computed groups as `hawk-mod@`, and the person clicking needs
     no Google power at all — and the other groups are run by their own
     owners and managers. `Groups Admin` leaves `Mentor_Admin_Roles`'s
     dropdown and `ADMIN_ROLES`, and a row still naming it is a sheet
     problem, reported by Person ID.
   - **The role is carried by a group.** A Super Admin assigns Help Desk
     Admin once, to a new **security group** (Google does not allow Super
     Admin on a group, which is why the three stay as they are). Whoever is
     in the group holds the role; whoever leaves it loses it. hawk-mod then
     needs nothing it does not already have: it reads group membership
     today, and never has to read Google's role assignments.
   - **The group is computed from the sheet**: Active Mentors with a
     `Help Desk Admin` row on `Mentor_Admin_Roles` and **CORI current**
     (`mayHaveAccess`, the mentor groups' gate — not the full screening).
   - **The group is `grp-helpdesk`**, a new group found by its Directory
     ID like the other nine.
   - **Every change is a click**, like the Slack copies (step 5): one
     finding saying what differs, re-read at the click, so a person stands
     between a sheet edit and admin power. The click is accepted only from
     an RA — someone the sheet puts in `grp-ra` — or a Google Super Admin,
     each checked at the click, and only from a Slack admin, like every
     button. Not from every Slack admin: the group resets passwords. RAs
     already hold the whole sheet, which is more than this. No second
     person is required, even for adding oneself (decided 2026-10-02).
     Someone leaving is taken out by their own **Remove from groups**, as
     from every other group. Coming back, they rejoin only if their
     `Mentor_Admin_Roles` row is still there, and only on that click.
   - **Any other admin is reported.** An account Google flags as an admin
     (`isAdmin` / `isDelegatedAdmin`, which `hawk-mod@` already reads) that
     is not one of the Super Admins, not `hawk-mod@`, and not in the Help
     Desk group holds a role nobody wrote down — one a Super Admin gave a
     person directly. One warning per account. Each Super Admin is warned
     about once and acknowledged, so a fourth is news, with no list of
     names kept in code.
   - **Slack administrators are a separate step**, after this one, and the
     same three questions apply to them. Rachel expects Slack admins and
     RAs to end up the same people, though nothing says so yet; if that
     becomes the rule, that step needs no new sheet column — it reports any
     Slack admin who is not an RA, and any RA who is not a Slack admin.

   To prove before anything depends on it — a privilege is only proven by
   a real call (step 7's lesson):

   - **Can `hawk-mod@` change the members of a group that carries an admin
     role?** Google may keep that to Super Admins. If it does, the click
     cannot work as `hawk-mod@`, and the finding asks a Super Admin to make
     the change in the Admin console instead.
   - **Does Google flag a member of the group as `isDelegatedAdmin`?** If
     it does, step 7 already offers them no Suspend, and their leaving
     alert's Remove from groups is what clears the way.
   - **The security label cannot be taken off a group**, so the group is a
     new one, never an existing group relabelled.

   _Verify:_ the plan is pure and tested; nothing joins or leaves the group
   without a click; Remove from groups takes the role away; a returning
   person gets it back only by the click.

9. **`/config` controls.** "Sync now" and the last run's result on the web
   page, alongside the Slack command.

## Step 3 design — the roster from the sheet

Status: **approved** (FRC2713/hawk-mod#24, 2026-09-27); being built in four
pull requests: the planner and migration 0009, the dry run, apply with its
findings and buttons, then the cutover.

### The local copy

Every Student or Mentor on the sheet who is Active — or whose status is blank
or unknown — has a `people` row, whether or not they are in Slack yet.
Migration 0009 adds `people.person_id` (`P####`, unique) and
`people.slack_consent_expires_on`. The roster's `email` is the person's
identity email (RHR or School), so a Slack account is linked the moment it
appears, at `team_join` or on the next run, by exact match, and the ID is
written back to the sheet. Volunteers and Alumni get no row.

`email` may be blank (decided 2026-09-27): an Active mentor still waiting for
an account, or a student with no School Email, is monitored by Person ID and
Slack User ID, and the missing address is reported. It is never filled with a
personal address. Making the column optional rebuilds `people`, which is the
parent of the consent and history tables, so the migration runner turns
foreign keys off around a migration that starts `-- foreign_keys: off` —
otherwise dropping the old table runs every `ON DELETE CASCADE`.

Blank or unknown status counts as Active **for monitoring**, and as out **for
group access**. Both are the cautious reading of the same cell.

### Cutover: matching the rows that exist today

Today's rows were created from `@students` / `@mentors`. Each is matched to a
Person ID once, by the Slack User ID on the sheet (or the one step 1 would
fill in), then by identity email, and never by anything looser — a wrong match
puts one person's monitoring on someone else. A stamped Person ID is the row's
key from then on.

**Slack User IDs are normally filled in by hawk-mod** (`/hawkmod lifecycle
slack-ids apply` today, and every run from step 3). The sheet's rule allows
typing one in by hand when needed, typically when someone's Slack email is not
their RHR or School Email (decided 2026-09-27).

A Slack User ID a person typed into the sheet is trusted **even when that Slack
account's email differs from the identity email** — the typing is the
statement. It is refused only when it is not a live Slack account, or when two
rows carry it. (`lifecycle slack-ids` lists such a cell as "typed by hand,
trusted"; it is still a conflict when a _different_ live account holds the
identity email, since that is two accounts for one person.) That is the case for the mentors whose
Slack email is not their RHR address, whose IDs were typed in by hand on
2026-09-27.

`/hawkmod lifecycle roster` shows the match and every change, including every
date that would be cleared. **The first apply is refused while any active row
with a Slack account is unmatched**, because creating a fresh row for that
person would make them two rows: one holding their Slack account, one holding
their screening. Typing their Slack User ID into the sheet clears it. A
deactivated row does not refuse it; it is not monitored either way.

For the same reason, **nobody the sheet contradicts itself about gets a new
row**: two rows with one Slack User ID or identity email, a typed Slack User ID
that is not a live account, or someone both Student and Mentor. Each is a
`sheet_conflict`, and the person is created on the run after the cell is fixed.

The first apply is the switch. From then on the hourly run keeps the roster,
`syncRolesFromUserGroups` and the `subteam_*` role handling are removed, and
the `student-group` / `mentor-group` settings no longer mean anything (step 5
reuses the groups as copies).

### What applies, and what asks

| The sheet says                                  | The roster has      | Result                                       |
| ----------------------------------------------- | ------------------- | -------------------------------------------- |
| Student or Mentor, Active                       | no row              | **create** `student` / `adult`               |
| Student                                         | `adult`             | **change to `student`**                      |
| Mentor                                          | `student`           | no change; finding with **Make adult**       |
| Mentor                                          | `district_observer` | no change (agreement)                        |
| both Student and Mentor                         | anything            | no change; finding                           |
| Active                                          | deactivated         | **reactivate**                               |
| Inactive, no longer Student/Mentor, or row gone | active              | no change; finding with **End monitoring**   |
| name, identity email                            | different           | **update**                                   |
| Slack User ID                                   | a different ID      | no change; finding                           |
| requirement dates, Slack Consent Expiry         | different           | **update to match exactly, blanks included** |

Dates copy the sheet including a blank over a date on record: they only decide
who counts as screened, so a date that disappears makes hawk-mod stricter,
never blinder. A person with no `Mentor_Details` / `Student_Details` row at
all keeps their dates — the sheet said nothing, rather than said blank.
Changes are logged in `screening_changes` with source `sheet`.

`consentStatus` reads `slack_consent_expires_on`. The `consents` table stays,
unread, as history, and the `revoked` state goes: a withdrawn consent is a
cleared or past date on the sheet.

`district_observer` stays roster-only, since the sheet has no such role. It is
never flagged as missing from the sheet, and is set with `set-role`.

### Retired at cutover

`/hawkmod screening`, `/hawkmod consent`, `import-roster` and
`import-consents` refuse with "edit the lifecycle sheet"; the two modals are
gone. `set-role` stays for `district_observer`, and moves only between it and
`adult`, never to or from `student`. `/hawkmod whois` shows the Person ID and
the Slack Consent Expiry. `/hawkmod sync` is now "sync now" from the sheet.
CLAUDE.md's sections on roles from user groups and optional Google are
rewritten in the same change.

Also retired with the role sync, decided while building it (2026-09-28):

- **The reason `/hawkmod group add` demanded for putting a student in
  `@mentors`.** It existed because that edit used to end their monitoring as
  a student. It no longer changes anyone's role, so the reply now says the
  roster is unchanged instead.
- **Matching Slack accounts to rows by email alone.** After the cutover a
  row's email is the identity email, which many people did not sign up to
  Slack with, so the nightly check would have called them unknown — or moved a
  row onto another account sharing its address. `matchSlackAccount` matches
  by Slack ID first, then by email only to a row with no Slack account yet,
  and never re-points one. `team_join` uses the same match, so a newcomer
  whose row the sheet already created is linked the moment they join.

The hourly run is at :20 past, fixed rather than an environment variable (a
new variable means a change to hawk_suite's deploy). It does nothing until the
first `roster apply`. The local walkthrough in `scripts/setup-local.sh`
rosters people the same way: it has the developer build a two-person test
sheet (the tabs and headers generated from `SHEET_TABS`, the addresses their
own test accounts), share it with a service account of their own that can
read nothing else, then run the roster dry run and apply.

### New findings

Findings name the person and Person ID, never an address. All of them
describe something currently true, so the run closes them when the sheet is
fixed — the held role change included (decided while building it, 2026-09-27):
if the sheet stops saying Mentor, there is nothing left to approve, and a
button still offering Make adult would act on a request nobody is making. The
user-group sync's own `roster_drift` findings are untouched: the run closes
only keys starting `roster_drift:sheet:`.

- **sheet_undeclared** — _P0042 Jordan Lee is Inactive on the lifecycle sheet
  (or: is now Alumni / has no row any more). hawk-mod is still monitoring them
  as a student, and will until someone ends it. [End monitoring]_ From
  step 4 the groups run raises its own alert for the same person,
  `group_member_held`, with [Remove from groups] (see step 4).
- **roster_drift** — _The lifecycle sheet says P0042 Jordan Lee is a Mentor,
  but hawk-mod monitors them as a student. Nothing was changed: as an adult,
  their DMs with students would stop being treated as a student's.
  [Make adult]_
- **sheet_conflict** — _P0042's Slack User ID is Jordan Lee's account, but
  Student_Details row 17 has a different one. Neither was changed. Check the
  cell._ (Also used for a row that is both Student and Mentor.)
- **lifecycle_unreadable** — _hawk-mod could not read the lifecycle sheet (no
  column "YPT Expiry" on Mentor_Details). The roster was left as it was._

Both buttons are gated on `administrator()` at the click and again at the
submit, ask for a reason, and are recorded in `role_changes` with who clicked
and why. **Before acting, each re-reads the sheet** and acts only if the sheet
still says what the finding says; otherwise it changes nothing and closes the
finding. An hour-old finding is not enough to end someone's monitoring on. A graduating class raises one `sheet_undeclared` per student
each June; that is the intended friction, and a bulk "end monitoring for
these" can follow if it proves heavy.

### Where it lives

- `domain/lifecycle/roster.ts` — pure: roster rows, sheet people and Slack
  accounts in; decisions out. Every row of the table above is a test.
- `lifecycle/run.ts` — applies them; one implementation for the hourly run,
  the CLI and `/hawkmod lifecycle roster [apply]` / `sync`.
- `rules/rosterSync.ts` and `jobs/syncRoles.ts` — removed at cutover.

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

Decided 2026-09-28. **Joining `grp-ra` requires a screened adult** — the
`RA (Y/N)` flag, CORI current like every mentor group, and YPT and Background
Screening current too. **A lapse removes nobody**: an RA whose training lapses
stays in `grp-ra` and gets the ordinary `screening_lapsed` reminder, nothing
more. That is the grace period, without a date rule: FIRST's 1 August rollover
lapses every RA's training on the same day, and would otherwise raise a
removal question for each of them at once. Only the RA flag turned off, or
leaving (Inactive, not a Mentor, CORI lapsed), takes someone out.

## Open

- **Who may create Google accounts.** Only a Super Admin, today: the prebuilt
  Help Desk Admin role can reset passwords and view users but cannot create
  them. The prebuilt role that can, User Management Admin, can also _delete_
  accounts, which this plan never does. If someone other than the Super
  Admins should create accounts, the narrower option is a custom role with
  only the "create users" privilege, added to the access plan; step 8
  reports anyone holding it as an admin the sheet does not account for.

- The account hawk-mod acts as in Google is `hawk-mod@redhawkrobotics.org`
  (created 2026-09-26, no admin roles). **Decided 2026-09-28:** a custom admin
  role that can read groups and change their members, and nothing else — not
  the prebuilt Groups Admin, which can also create and delete groups and
  change their settings. Domain-wide delegation grants only the groups scope
  now; the users scopes are added at steps 6 and 7, when they are first used.
- Whether training completed in May–July expires on the _coming_ 1 August only
  tunes the sanity check, which accepts either answer (an annual expiry on 1
  August, at most two rollovers ahead).
