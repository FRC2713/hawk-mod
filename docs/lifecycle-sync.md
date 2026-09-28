# Lifecycle sync

Status: **steps 0–3 deployed.** The roster has come from the sheet since the
first apply on 2026-09-28 (#25–#28); it runs hourly and on `lifecycle sync`.
Step 4 is next. The scope was
settled with Rachel Moore on 2026-09-25 and 26. The big picture below was
rewritten on 2026-09-27, after a first step 3 design showed it had never been
written down; it replaces the earlier "direction of truth" section.

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

| Fact                                                               | Source of truth         | Who changes it                                       | What hawk-mod does                                                                                   |
| ------------------------------------------------------------------ | ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Who a person is: role, Active/Inactive, requirement dates, consent | **The sheet**           | `grp-ra`, and the Super Admins (Dan, Ty, Rachel)     | Reads it. Writes back only a Slack User ID                                                           |
| Whether someone has a Slack account                                | **Slack**               | A human invites or deactivates (no API on Slack Pro) | Compares with the sheet; prompts a human                                                             |
| Whether someone has a Google account                               | **Google**              | A human creates it                                   | Suspends or un-suspends, only after a click                                                          |
| Delegated admin roles                                              | **Google**              | A Super Admin only                                   | Reports what differs from the sheet                                                                  |
| Google Group and Slack user group membership                       | **Copies of the sheet** | hawk-mod                                             | Google: adds automatically, removes someone leaving after a click. Slack: every change after a click |
| Who is monitored, and as what                                      | **hawk-mod's database** | hawk-mod adds; a person ends                         | Adds on its own; ends only after a click                                                             |
| Messages, findings, history                                        | **hawk-mod's database** | hawk-mod                                             | Records                                                                                              |

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
| G   | Delegated admin roles report          | **report only**           | Super Admin makes each change; hawk-mod lists what differs from `Mentor_Admin_Roles`                                                            |
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
`grp-ra`→`@ra-adults`. The mapping is a DB setting (handles validated against
Slack), and every mapped handle is necessarily in `MANAGED_USERGROUPS`. Each
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
- A hand edit to a copied group shows up as a difference and is undone by the
  next Apply, which names who was added or removed so the editor learns it did
  not stick. It changes nobody's monitoring.

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

**Google accounts (H).** When a mentor's row is Active and has no RHR Email,
hawk-mod asks for an account: _Create a Google account for P0042 Jordan Lee,
then type the address into their RHR Email on the lifecycle sheet._ It names
the person and Person ID and no address. It does not wait for CORI: the
account may exist before CORI is done, it just joins no group. The request is done
when the RHR Email cell is filled in. A Super Admin creates the account —
Google's Help Desk Admin role cannot create users. hawk-mod also checks each
RHR Email on the sheet against Google's directory (the read-only users scope
it already has) and flags one that is not a real account, since a typo there
silently leaves the mentor out of every group.

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
in Slack (manual on Pro), and a Super Admin revokes any delegated admin role
(G reports it). The buttons are independent — ending monitoring and removing
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
- Directory: role management, read-only (G)

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

5. **Slack user groups (E).** Same computed membership, copied to Slack by an
   administrator's **Apply** click on one `slack_groups_differ` finding, with
   the clicker's own grant; `/hawkmod group` refuses copied groups. _Verify:_
   nothing changes without the click; Apply applies the difference as re-read
   at click time; a non-admin click and a clicker without a grant are refused;
   a hand edit is undone by the next Apply, reported, and changes no role.
6. **Onboarding requests and safety net (H).** Google account requests,
   RHR Email directory check, Slack invites, all in the `onboarding-channel`
   setting's channel.
   _Verify:_ readiness rule tests per role; a request is posted once and
   closes when the sheet is filled in; a mentor in Slack without CORI is a
   finding.
7. **Offboarding / reactivation (I).** Suspend / un-suspend on the leaving
   finding, and "Remove from groups" extended to every live group. _Verify:_
   nothing changes without the click; a non-admin click is refused; the
   removal covers groups the sheet does not compute.
8. **Delegated admin roles (G).** **Report only** (decided 2026-09-26). Only a
   Super Admin can grant Groups Admin or Help Desk Admin, and the access plan
   keeps Super Admin to three named people — so `hawk-mod@` is never one.
   hawk-mod posts the differences from `Mentor_Admin_Roles` as actions
   ("grant Help Desk Admin to P0012") for a Super Admin to do by hand.
   _Verify:_ the diff is pure and tested; nothing is ever granted.
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
  only the "create users" privilege, added to the access plan and to
  `ADMIN_ROLES` so step 8 reports it.

- The account hawk-mod acts as in Google is `hawk-mod@redhawkrobotics.org`
  (created 2026-09-26, no admin roles). **Decided 2026-09-28:** a custom admin
  role that can read groups and change their members, and nothing else — not
  the prebuilt Groups Admin, which can also create and delete groups and
  change their settings. Domain-wide delegation grants only the groups scope
  now; the users scopes are added at steps 6 and 7, when they are first used.
- Whether training completed in May–July expires on the _coming_ 1 August only
  tunes the sanity check, which accepts either answer (an annual expiry on 1
  August, at most two rollovers ahead).
