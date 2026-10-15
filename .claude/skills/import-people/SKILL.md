---
name: import-people
description: Safe procedure for writing people's data onto the lifecycle sheet ("RHR User Lifecycle Management DB") from intake form responses, CSVs, directory exports or pasted lists. Use whenever new people are to be added to that sheet, or existing people's missing information filled in (a backfill).
---

# Importing people onto the lifecycle sheet

The sheet is live. Within the hour, hawk-mod's hourly job acts on what it says:
it creates monitored roster rows, adds students, mentors and parents to Google
Groups, and posts Slack-invite and account requests. That automation only ever
adds, so it cannot undo a bad import. Every wrong addition is a held-member
alert a person clears by hand. Work through the gates below in order. Each one
ends on a check that passes or fails.

An import makes three kinds of write, and the gates treat each one
differently:

- **Add:** a new person, with new rows on every tab they need.
- **Append:** a new row for someone already on the sheet, such as a guardian
  under an existing student, or a skill.
- **Fill:** a blank cell on a row already on the sheet. This is the backfill
  for people who were first entered with only enough to get them into Slack.

Each append and fill is also **live** or **quiet**. A column listed in
`SHEET_TABS` (`src/domain/lifecycle/schema.ts`) is one hawk-mod reads, so a
write there is **live**: it can change groups, invites or screening at the
next :20 run. Any other column is **quiet**: no automation reads it. An
appended `Emergency_Contacts` row is live, and an appended `People_Skills` row
is quiet.

Read `docs/lifecycle-sheet.md` first, all of it. Its §2 (data model), §5
(ground rules) and §6 (notes for an agent) apply throughout, and its §4 says
which rows each kind of person gets. This skill is the safety wrapper around
§4. It does not replace it.

## The rules that hold at every step

- **The operator writes, by pasting. The agent prepares and checks.** The agent
  reads the sheet from a full `.xlsx` download (gate 1) and has no write access
  to it. The Google Drive connector's `read_file_content` returns only each
  tab's header and first 10 rows, so it can't stand in for a full read.
- **Every date is copied from a record.** Expiry and completion dates come from
  FIRST's or the state's own system, typed in by a person. A "yes", a TRUE, a
  "done as of [date]", or the date a check was done becomes a **blank** cell
  plus a line on the _dates to get_ list. The earlier manual conversion turned
  "yes" answers into forward-dated expiries. That is the mistake this rule
  exists for: hawk-mod trusts a mentor's CORI date to grant access, and all
  three screening dates to count them as a screened adult.
- **Students are reached by School Email only.** A student's personal address
  goes in `People: Personal Email`, which hawk-mod uses for matching only. An
  address that belongs to a guardian goes on the guardian's
  `Emergency_Contacts` row and nowhere on the student's. A student with no
  School Email is still imported, with that cell blank. hawk-mod then lists
  "Student with no School Email" as a sheet problem, which is the prompt for
  the operator to find the address and add it by hand. Until then the student
  joins no group and gets no Slack invite.
- **Personal data stays in chat and the scratchpad.** Everything read from the
  sheet or from a source (names, addresses, phone numbers, answers) appears
  only in this conversation and in temporary files in the session scratchpad,
  each download copied into its own new folder there. Delete them when the
  import is done. Files in the repo, commits, issues, PRs and memory get
  structure only. The repo is public.
- **A fill only ever writes into a blank cell.** A cell that already holds a
  value keeps it. Where the source disagrees with that value, list it as a
  _difference_. If the operator decides the existing value is a mistake, the
  correction becomes a write of its own. It goes in the pass its column
  belongs to, and its check confirms the old value before the paste.
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
2. **Check what is deployed.** If a merged change to hawk-mod hasn't been
   deployed yet (compare the last Deploy run with `main`), ask the operator to
   deploy first, so the baseline and the checks after it run on the same code.
3. Ask the operator to run two dry runs in Slack and paste the replies:
   - `/hawkmod lifecycle plan`: record the people count, the role counts, the
     group sizes, and **every** sheet problem line.
   - `/hawkmod lifecycle groups`: record every join and hold **already
     pending**, so that gate 4 can tell this import's joins from older ones.

   Together they are the baseline.

4. **Read the whole sheet.** Ask the operator to download it (File → Download
   → Microsoft Excel (.xlsx)) with no edits since step 3. Copy the file into a
   new, empty folder in the scratchpad, and read it with
   [`read_xlsx.py`](read_xlsx.py), which needs only the Python standard
   library. Check that:
   - **the read is complete:** `People` has exactly the plan's people count of
     data rows, with no Person ID twice;
   - **the tab names and headers** match `docs/lifecycle-sheet.md` §3 and
     `SHEET_TABS`. If anything differs, stop and ask.

   From the read, take each tab's **live** column order (row 1, which can
   differ from the docs), its first empty row, and the row number of every
   existing row a fill will touch. The row numbers are checked against
   column A again at paste time.

Done when: a named version exists, the code is deployed, the baseline is
recorded, and the read is complete with matching headers.

## Gate 2: map, match, and get the table approved

1. **Identify the source format** from [`mapping.md`](mapping.md). Each format
   there says how to recognise it. If none matches, stop: write the mapping
   for the new format with the operator first, as structure only. Columns the
   mapping doesn't know (a team may add its own to a responses sheet) are set
   aside until the operator says what they hold.
2. **Follow the conventions already on the sheet.** When earlier rows came from
   the same format, compare them with their source responses (grade → year,
   skill synonyms, how notes were worded) and do the same. Report any place
   where the earlier rows disagree with `mapping.md`.
3. **Bound the batch.** At most 25 people per import. A bigger source goes in
   several imports, each through every gate.
4. **Match every incoming person** against the read. Search `People` by every
   name form (legal, preferred, last name alone) and by every email the source
   gives. Compare each one against Personal Email, School Email, RHR Email
   **and** `Emergency_Contacts.Email`: a parent who is now a mentor is already
   listed as a contact. Compare emails by `addressKey`
   (`src/domain/lifecycle/address.ts`): Gmail ignores dots and `+tags`.
   - An exact match on email, or on name and email, is **existing**: use that
     Person ID.
   - No match on anything is **new**: mint the next Person ID, counting up from
     the highest one in the read. IDs are never reused.
   - A partial match (same name with a different email, or a similar name with
     a shared address) is **set aside** for the operator to decide.
5. **For an existing person, append the rows they are missing and fill the
   blank cells the source answers.** Mark each one live or quiet. Where the
   source disagrees with a cell that already has a value, list the difference.
6. **Check every dropdown value** against the full `Reference_Lists` tab in
   the read, and use it verbatim. A value that isn't listed goes on the
   _values to add_ list, and its cell stays blank.
7. **Show the approved-table draft in chat**, with:
   - **Per new person:** the Person ID, and every row on every tab, with every
     value, in live column order.
   - **Per existing person:** the Person ID, each appended row, and each filled
     cell with its tab, row number and column. Mark every one live or quiet.
   - **Names to confirm:** every name of three or more words, with the split
     proposed. No rule splits every name correctly, so the operator confirms
     each one.
   - **Set aside:** each person or field left out, and why.
   - **Expected sheet problems:** each one the import will add, such as
     "Student with no School Email", by Person ID.
   - **Dates to get:** the person, the column, and what the source said.
   - **Values to add** to `Reference_Lists`.
   - **Differences** on existing people, numbered so the operator can answer
     each by its number.
   - **Already in Slack or a group:** anyone the source suggests already has an
     account at their School or RHR address (Format D, for example). See
     gate 4.
   - **Derived values:** any value computed rather than copied (a graduation
     year from a grade), each shown with its working.
   - **What gate 4 will show:** the expected changes in group sizes, roster
     updates and the "no parent email" list.

Done when the operator replies in chat approving the table. A partial approval
narrows the table. It does not stretch to rows that weren't approved.

## Gate 3: the operator pastes

Paste in up to three passes, in this order. Leave out any pass with nothing
in it.

1. **Adds.** These are staged, as below.
2. **Quiet appends and fills.** No automation reads them, so paste them any
   time.
3. **Live appends and fills, and approved corrections.** Paste these just
   after a :20 run, and finish gate 4's checks for them before the next one.

### Adds: staged as Inactive

New people go in as **`Active/Inactive = Inactive`**, with `Status Changed
Date` blank. While they are Inactive, the roster, the Google and Slack group
runs (`grp-parents` included) and onboarding all skip them. So the checks in
gate 4 have as long as they need.

Appends and fills for existing people can't be staged that way. They are
already Active, and setting them to Inactive would make offboarding treat them
as leaving. That is why the live ones get the :20 window instead.

### Every block goes on the clipboard

Write each approved block to a tab-separated file in the scratchpad. Hand it
over with `pbcopy < block.tsv`, then check `pbpaste | cmp - block.tsv`. Text
copied out of a chat code block can turn tabs into spaces, which puts a whole
row into one cell. Fall back to a fenced code block only where `pbcopy` isn't
available. One block at a time: the operator replies after each paste, and
only then does the next block go on the clipboard.

For each block, tell the operator:

1. the **check**: a cell to look at in the Name Box (the cell-address box left
   of the formula bar), and what it must show. If it shows anything else,
   stop. Your read is stale or wrong, so take a new download before going on;
2. the **start cell** to type into the Name Box;
3. to paste with **Cmd+Shift+V** (paste values only, which keeps the column's
   formatting and dropdown validation), and to report any validation warning.
   If one appears, stop that tab and work out why before going on.

### Adds and appends: one block per tab, at the bottom

One block per tab, covering the whole batch, in this order: `People`,
`People_Roles`, then `Student_Details` or `Mentor_Details`, then
`Emergency_Contacts`, then `People_Skills`. Columns go in the live header
order, with no header line, and dates as `YYYY-MM-DD`. The check is the last
filled row's Person ID, with the row below it empty. The start cell is
`Tab!A<first empty row>`.

### Fills: blank rectangles, checked at both ends

Writing into the middle of a tab is the riskiest paste there is: a wrong row
overwrites someone else's data. So a fill block is a **rectangle in which
every cell is blank in the gate 1 read**. A cell inside it that stays blank is
pasted as an empty field, which leaves it blank. Build the largest such
rectangles over consecutive rows, and keep each one within a single pass:
a quiet rectangle must not reach into a live column. The check is the Person
ID in column A on the rectangle's **first and last** rows. The start cell is
its top-left corner, with column letters taken from the live row 1.

A correction is a one-cell block. Its check is that cell's old value as well as
the row's Person ID.

**When `Emergency_Contacts` lists a contact who is already on the sheet**
(the same email under another Person ID, such as a sibling's parent), copy
that contact's existing `CORI Expiry` onto the new row. Rows that disagree
make the contact read as not current, and they show up as a sheet problem.

**If the import stops partway**, adds have done nothing yet, because the new
people are Inactive. Either paste the remaining blocks, or the operator deletes
the rows just pasted. Those are the bottom rows of each tab, starting at the
start cells you gave, and should be checked by Person ID before deleting. A
fill can be undone by clearing the cells pasted, since they were blank before.
Or restore the named version.

Done when every approved block in the pass is pasted, with no validation
complaints.

## Gate 4: verify each pass

**Every pass ends on a fresh download, compared with the previous read across
the whole workbook, cell by cell.** Each cell the pass was meant to write holds
exactly the approved value, and was blank before (or held the confirmed old
value, for a correction). **Every other cell in every tab is unchanged.** A
whole-workbook comparison also catches a paste that landed on the wrong tab or
the wrong row, and the earlier conversion's one real error, a few columns of
dates shifted sideways. Then ask for the dry runs below. Each of them is a dry
run as typed. Never ask for `apply` or `sync` here: those act.

### Adds, while the new people are Inactive

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

### Adds, after the flip

**Flip to Active.** For the new people only, the operator sets `Active/Inactive`
to `Active` and `Status Changed Date` to today. Then ask for the same dry runs
again:

- `plan`: `Active` rose by the number of new people, and `Inactive` is back
  to its baseline.
- `roster`: exactly one create per new Student or Mentor, no updates, nothing
  else.
- `groups` and `slack-groups`: only the joins the approved table implies, on
  top of the joins already pending in the baseline. Students join by School
  Email, guardians join `grp-parents`, and mentors join only once their CORI
  is current, which a fresh import usually leaves blank. **This is the check
  on every guardian address.**
- `onboarding`: only the requests the approved table implies.

The hourly run at :20 then applies it.

### Quiet pass

`/hawkmod lifecycle plan` is unchanged: the same counts and the same sheet
problems. Anything that moved means a write landed in a column hawk-mod
reads.

### Live pass, before the next :20 run

- `plan`: the same people and role counts. Group sizes move only as the
  approved table said they would (each appended guardian adds one to
  `grp-parents`). The sheet problems are the baseline, minus any the pass
  resolves ("Student with no School Email" once it's filled), plus the
  expected ones.
- `roster`: no creates. Only the updates the pass implies. The roster's name
  is the Preferred First Name (the Legal First Name when that's blank) plus
  the Legal Last Name, so filling a legal first name under an existing
  preferred one changes nothing there.
- `groups` and `slack-groups`: only the joins the approved table implies, on
  top of the joins already pending in the baseline. A filled School Email
  adds that student, and an appended guardian joins `grp-parents`. **This is
  the check on every guardian address.** A pending join that was in the
  baseline is not this import's, but put it on the follow-up list.
- `onboarding`: only the requests the approved table implies, such as a
  Slack invite for a student whose School Email was just filled.
- `offboarding`: none of them appears.

**If anything is unexpected, at any stage:** before the next :20 run, the
operator sets the new people back to Inactive, clears the filled cells, deletes
the appended rows, or restores the named version. Then report what happened.

Done when every check above passes and the operator has confirmed the flip.

## After the import

1. **Report in chat:** how many people were added, how many rows appended and
   cells filled, what was set aside, the dates to get, the values to add, and a
   numbered **follow-up list** of everything left for a person (a missing
   phone number, a pending join from the baseline).
2. **Delete the scratchpad copies** (the downloads, the JSON and the block
   files), and remind the operator to delete the downloads from their own
   Downloads folder.
3. If the mapping was wrong or a format was new, update
   [`mapping.md`](mapping.md) with structure only, in a PR.
