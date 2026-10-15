---
name: import-people
description: Safe procedure for putting people onto the lifecycle sheet ("RHR User Lifecycle Management DB") from intake form responses, CSVs, directory exports or pasted lists. Use whenever new people, or new rows for existing people, are to be added to that sheet.
---

# Importing people onto the lifecycle sheet

The sheet is live. Within the hour, hawk-mod's hourly job acts on what it says:
it creates monitored roster rows, adds students, mentors and parents to Google
Groups, and posts Slack-invite and account requests. That automation only ever
adds, so it cannot undo a bad import. Every wrong addition is a held-member
alert a person clears by hand. Work through the gates below in order. Each one
ends on a check that passes or fails.

Read `docs/lifecycle-sheet.md` first, all of it. Its §2 (data model), §5
(ground rules) and §6 (notes for an agent) apply throughout, and its §4 says
which rows each kind of person gets. This skill is the safety wrapper around
§4. It does not replace it.

## The rules that hold at every step

- **The operator writes, by pasting. The agent prepares and checks.** The agent
  reads the sheet through the Google Drive connector and has no write access to
  it.
- **Every date is copied from a record.** Expiry and completion dates come from
  FIRST's or the state's own system, typed in by a person. A "yes", a TRUE, or
  "done as of [date]" on a form becomes a **blank** cell plus a line on the
  _dates to get_ list. The earlier manual conversion turned "yes" answers into
  forward-dated expiries. That is the mistake this rule exists for: hawk-mod
  trusts a mentor's CORI date to grant access, and all three screening dates
  to count them as a screened adult.
- **Students are reached by School Email only.** A student's personal address
  goes in `People: Personal Email`, which hawk-mod uses for matching only. An
  address that belongs to a guardian goes on the guardian's
  `Emergency_Contacts` row and nowhere on the student's. A student with no
  School Email is still imported, with that cell blank. hawk-mod then lists
  "Student with no School Email" as a sheet problem, which is the prompt for
  the operator to find the address and add it by hand. Until then the student
  joins no group and gets no Slack invite.
- **Personal data stays in chat.** Everything read from the sheet or from a
  source (names, addresses, phone numbers, answers) appears only in this
  conversation. Files, commits, issues, PRs and memory get structure only. The
  repo is public.
- **Anything uncertain is set aside and listed, not guessed.** That covers a
  possible duplicate, an unclear role, a dropdown value missing from
  `Reference_Lists`, a misaligned source row, and a person outside the grade
  range the sheet covers. The operator decides each one.
- **Hand-set fields stay at their defaults.** `Mentor Lead`, `RA` and
  `Student Lead` are `N`. `Mentor_Admin_Roles` gets no rows. `Slack User ID`
  stays blank, because `/hawkmod lifecycle slack-ids apply` fills it in. Only
  the operator changes these, outside an import.

## Gate 1: before touching the sheet

1. Ask the operator to name a version: in the sheet, File → Version history →
   Name current version, `before import YYYY-MM-DD`. Restoring it later undoes
   the import in one step, but it also discards anyone else's edits made since
   then. Say so if a restore ever comes up.
2. Ask the operator to run `/hawkmod lifecycle plan` in Slack and paste the
   output. Record the people count, the role counts, and **every** sheet
   problem line. That list is the baseline.
3. Read the sheet with the Drive connector. Compare its tab names and headers
   with `docs/lifecycle-sheet.md` §3 and with `SHEET_TABS` in
   `src/domain/lifecycle/schema.ts`. If anything differs, stop and ask.
4. Ask the operator for two things the Drive read cannot be trusted to give
   (it may come back incomplete for a large sheet):
   - **The highest Person ID in `People`.** If it doesn't match the highest one
     in your read, your read is incomplete. Stop and say so.
   - **Row 1 and the first empty row of each tab the import will touch.** To
     find the first empty row: click a cell in column A, press Cmd+↓ to jump to
     the last filled row, and add one. Row 1 gives the **live** column order,
     which can differ from the docs.

Done when: a named version exists, the baseline is recorded, the headers
match, the read is complete, and you have the first empty row and the live
header order for every tab you will touch.

## Gate 2: map, match, and get the table approved

1. **Identify the source format** from [`mapping.md`](mapping.md). Each format
   there says how to recognise it. If none matches, stop: write the mapping
   for the new format with the operator first, as structure only.
2. **Bound the batch.** At most 25 people per import. A bigger source goes in
   several imports, each through every gate.
3. **Match every incoming person** against the read. Search `People` by every
   name form (legal, preferred, last name alone) and by every email the source
   gives. Compare each one against Personal Email, School Email, RHR Email
   **and** `Emergency_Contacts.Email`: a parent who is now a mentor is already
   listed as a contact. Compare emails by `addressKey`
   (`src/domain/lifecycle/address.ts`): Gmail ignores dots and `+tags`.
   - An exact match on email, or on name and email, is **existing**: use that
     Person ID.
   - No match on anything is **new**: mint the next Person ID, counting up from
     the highest one the operator confirmed. IDs are never reused.
   - A partial match (same name with a different email, or a similar name with
     a shared address) is **set aside** for the operator to decide.
4. **For an existing person, only append rows they are missing**, such as a new
   role row or a contact row. Where the source disagrees with a cell already on
   the sheet, list the difference for the operator. The import never edits an
   existing cell.
5. **Check every dropdown value** against `Reference_Lists` in the read, and
   use it verbatim. A value that isn't listed goes on the _values to add_ list,
   and its cell stays blank.
6. **Show the approved-table draft in chat**, with:
   - **Per person:** new or existing, the Person ID, and every row on every
     tab, with every value, in live column order.
   - **Set aside:** each person or field left out, and why.
   - **Expected sheet problems:** each one the import will add, such as
     "Student with no School Email", by Person ID.
   - **Dates to get:** the person, the column, and what the source said.
   - **Values to add** to `Reference_Lists`.
   - **Differences** on existing people.
   - **Already in Slack or a group:** anyone the source suggests already has an
     account at their School or RHR address (Format D, for example). See
     gate 4.
   - **Derived values:** any value computed rather than copied (a graduation
     year from a grade), each shown with its working.

Done when the operator replies in chat approving the table. A partial approval
narrows the table. It does not stretch to rows that weren't approved.

## Gate 3: the operator pastes

New people go in as **`Active/Inactive = Inactive`**, with `Status Changed
Date` blank. While they are Inactive, the roster, the Google and Slack group
runs (`grp-parents` included) and onboarding all skip them. So the checks in
gate 4 have as long as they need.

**Rows for existing people can't be staged that way.** A guardian row added
under an Active student goes into `grp-parents` at the next :20 run. So put
existing people's rows in a separate, smaller pass, after the new people are
live. Paste it just after a :20 run, and finish gate 4's Active-stage checks
for it before the next one.

Prepare one paste block per tab, covering the whole batch, in this order:
`People`, `People_Roles`, then `Student_Details` or `Mentor_Details`, then
`Emergency_Contacts`, then `People_Skills`. For each block give:

- the **start cell**, as `Tab!A<first empty row>`;
- a fenced code block of **tab-separated** values, one line per row, columns in
  the live header order, with no header line. A blank cell is an empty field
  between tabs, and dates are `YYYY-MM-DD`.

The operator then, for each block:

1. clicks the Name Box (the cell-address box left of the formula bar), types
   the start cell, and presses Enter;
2. pastes with **Cmd+Shift+V** (paste values only, which keeps the column's
   formatting and dropdown validation);
3. tells you if Sheets showed a validation warning or rejected anything. If it
   did, stop that tab and work out why before going on.

**When `Emergency_Contacts` lists a contact who is already on the sheet**
(the same email under another Person ID, such as a sibling's parent), copy
that contact's existing `CORI Expiry` onto the new row. Rows that disagree
make the contact read as not current, and they show up as a sheet problem.

**If the import stops partway**, nothing has acted: the new people are
Inactive. Either paste the remaining blocks, or the operator deletes the rows
just pasted. Those are the bottom rows of each tab, starting at the start cells
you gave, and should be checked by Person ID before deleting. Or restore the
named version.

Done when every approved block is pasted, with no validation complaints.

## Gate 4: verify, then go live

**While the new people are Inactive:**

1. **Re-read the sheet** and compare every new row **by column name, never by
   position**, with the approved table. The earlier conversion's one real
   error was a few columns of dates shifted sideways, caught this way. Also
   check that the last pre-import row of each tab still holds the same Person
   ID it did in gate 1, so nothing was overwritten.
2. Ask the operator to run these and paste the output. Each of them is a dry
   run as typed. Never ask for `apply` or `sync` here: those act.
   - `/hawkmod lifecycle plan`: `People` and `Inactive` each rose by exactly
     the number of new people, `Active` is unchanged, and the sheet problems
     are the baseline plus the expected ones from the approved table. Any
     other new problem is a failure.
   - `/hawkmod lifecycle roster`, `groups`, `slack-groups` and `onboarding`:
     none of them mentions a new person.
   - `/hawkmod lifecycle offboarding`: none of them appears. A new person
     listed here already has a Slack account or a group membership at their
     address, and hawk-mod reads Inactive as someone leaving. Before the next
     :20 run, either finish verifying and flip them to Active, or have the
     operator delete their rows.

**Flip to Active.** For the new people only, the operator sets `Active/Inactive`
to `Active` and `Status Changed Date` to today. Then ask for the same dry runs
again:

- `plan`: `Active` rose by the number of new people, and `Inactive` is back
  to its baseline.
- `roster`: exactly one create per new Student or Mentor, no updates, nothing
  else.
- `groups` and `slack-groups`: only the joins the approved table implies.
  Students join by School Email, guardians join `grp-parents`, and mentors join
  only once their CORI is current, which a fresh import usually leaves blank.
  **This is the check on every guardian address.**
- `onboarding`: only the requests the approved table implies.

The hourly run at :20 then applies it.

**If anything is unexpected, at either stage:** the operator sets the new
people back to Inactive, or restores the named version, before the next :20
run. Then report what happened.

Done when every check above passes and the operator has confirmed the flip.

## After the import

Report in chat: how many people were new and how many existing, what was set
aside, the dates to get, and the values to add. If the mapping was wrong or a
format was new, update [`mapping.md`](mapping.md) with structure only, in a PR.
