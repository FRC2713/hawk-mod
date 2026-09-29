# The lifecycle sheet

**What this is:** the tab-by-tab schema of the team's "RHR User Lifecycle
Management DB" Google Sheet — the single record of every person that hawk-mod
reads. It is written so a person or an AI agent can understand and safely edit
the sheet without exploring it first, and so another team can build the same
sheet for their own copy of hawk-mod. It describes the sheet **as built**.

- **What hawk-mod does with it**, and every decision about groups, Slack and
  monitoring: [`lifecycle-sync.md`](lifecycle-sync.md). This document is the
  sheet's side only; where the two touch, `lifecycle-sync.md` decides.
- **Which columns hawk-mod reads:** `SHEET_TABS` in
  `src/domain/lifecycle/schema.ts`. Every other column stays in Google.
- **The sheet's ID** is deployment configuration (`LIFECYCLE_SHEET_ID`) and is
  deliberately not in this public repository.
- The live sheet's `_Instructions` tab restates Sections 2 and 5 for people
  editing it, and must agree with this document.

> This document is schema and rules only. It contains **no names, emails, phone numbers or other personal data** from the sheet, and must never gain any.

---

## 1. Purpose

The sheet is the **single source of truth** for every human involved with the robotics program: mentors, volunteers, students, and alumni. A sync script/app (hawk-mod) reads and writes this data to keep three systems aligned with it:

1. **Slack** membership and Slack User ID linkage
2. **Google Groups** membership (computed groups like `grp-all-team`, `grp-ra`, etc.)
3. **Google Workspace admin permissions** (delegated admin roles)

The `_Instructions` tab inside the sheet is a living quick-reference for anyone (human or AI) editing the sheet directly — this document is a fuller, more structured restatement of that tab plus the tab-by-tab schema.

---

## 2. Core data model

- **`Person ID` is the only key.** Every tab except `Reference_Lists` and `_Instructions` links back to a human via `Person ID`. Format: `P####` — a 4-digit, zero-padded integer (e.g. `P0001`, `P0042`).
- **One row per human, ever, in `People`.** Nobody gets a second `Person ID`. Before adding a new person, search `People` by name/email first.
- **Next Person ID** = `MAX(existing values in People!A2:A) + 1`. IDs are never reused or reassigned, even after someone is removed from the program.
- **Roles are rows, not columns.** A person's role(s) — `Mentor` / `Volunteer` / `Alumni` / `Student` — live in `People_Roles` as one row per role held. A person can hold more than one role at once (e.g. a former Student who becomes an Alumni and later a Mentor keeps all three role rows). There is no separate "Mentors" tab — mentor-specific fields live in `Mentor_Details`, keyed by `Person ID`.
- **Role-specific fields live in extension tabs**, keyed by `Person ID`: `Mentor_Details`, `Mentor_Admin_Roles`, `Student_Details`, `Student_Surveys`, `Student_Survey_Concepts`, `Alumni_Details`. Only add a row for someone who actually holds that role.
- **`Emergency_Contacts` is the one extension tab that is NOT role-specific** — it applies to every human, regardless of role (a mentor's spouse and a student's parent are recorded the same way).
- **One-to-many data gets its own tab**, one row per instance (emergency contacts, skills, survey responses) — never comma-separated values or numbered columns (`Contact #1`, `Contact #2`, etc.). A binary yes/no that only ever has **one** value per person (`Mentor Lead`, `RA`, `Student Lead`) is a plain `Y`/`N` column instead, not a linking tab.
- **Parents/caregivers are NOT "People."** They never get a `Person ID` or a role row. They exist only as rows in `Emergency_Contacts`, linked to their student via the student's `Person ID`.
- **Dropdown (validated) columns only ever draw from `Reference_Lists`.** Never type free text into a validated column — add the new option to `Reference_Lists` first, then select it.
- **Nothing a script can compute or look up live is stored.** Group memberships are **not** columns in this sheet. hawk-mod computes them at sync time — from `People_Roles`, `Active/Inactive`, the `Mentor Lead`/`RA`/`Student Lead` flags, requirement dates, and (for `grp-parents`) `Emergency_Contacts`. The rule for each group is in [`lifecycle-sync.md`](lifecycle-sync.md#groups).
  - `grp-orders`, `grp-equipment`, `grp-contact`, `grp-grants` are self-serve/manually-curated groups **not tracked in this sheet at all** — there is no `Group_Memberships` tab.
  - `grp-ra` membership grants **organizer access to this sheet itself** — setting `RA (Y/N) = Y` for a mentor gives that person full access to everyone's personal data in the sheet. This is a manual judgment call, never derived from anything else.
  - At offboarding, hawk-mod looks up the person's live Google group memberships and, when an administrator clicks, removes them from all of them — including groups this sheet does not track.
- **Sensitive demographic fields favor self-identification over forced categories.** `Race/Ethnicity` on `Student_Details` is free text, not a dropdown, so no one is forced into a box that doesn't fit; suggested categories are offered on the paper/digital intake form, not enforced in the sheet.
- **Form/certification date columns follow one naming convention:**
  - A column ending in **`Expiry`** holds the date the current form or certification _stops being valid_. When it's renewed, the existing value is overwritten with the new date (history is not kept in-sheet).
  - A column ending in **`Completed`** holds the date a _one-time_ item was done (it never expires/renews).
  - Blank = not on file / not started yet.
  - The one exception: `Melrose Media Release Expiry` on `Student_Details`, where the literal text `N/A` means the form does not apply to that student (they're not in the Melrose school district).
  - FIRST's annual items (Youth Protection Training, Consent & Release, Data Privacy for Mentors) all expire on **August 1**, the FIRST season rollover — not exactly one year after completion. The expiry date is always copied verbatim from what FIRST's system shows; it is never calculated in-sheet.
  - Background Screening and CORI expire every **3 years**; that date is likewise always copied from the state/vendor record, never calculated.
- **Dates are never invented or calculated by whoever/whatever is editing the sheet.** Every date comes from FIRST's or the state's records (or the relevant form), entered by a human. New/blank date cells are left blank, not backfilled with a guess.
- **Slack User ID columns** (on `Mentor_Details` and `Student_Details`) are normally filled in **by hawk-mod** once the person joins Slack — `/hawkmod lifecycle slack-ids apply` in Slack. hawk-mod only fills a blank cell, and only on an exact match between the Slack account's email and the RHR Email (mentors) or School Email (students). Typing one in by hand is allowed when needed, typically when someone's Slack email is not that address; hawk-mod trusts a typed ID unless it is not a live Slack account or appears on two rows.
- **hawk-mod reads this sheet by exact tab name and column header text.** Column _order_ does not matter, but renaming, adding, or removing a tab or header without first updating hawk-mod will break the sync with an error.

### Placeholder/sample data

`Person ID`s `P0001`, `P0002`, and `P0003` (and every row referencing them, across every tab) were originally seeded as placeholder example data, not real people, meant to be deleted before real records were entered. **As of this writing, real records have been entered into the sheet starting around `P0004`** — treat any remaining `P0001`–`P0003` rows you encounter as leftover sample data unless the sheet's owner says otherwise, and never reuse those three IDs.

---

## 3. Tab-by-tab schema

Legend: **PK** = uses `Person ID` as its linking key. **Dropdown** = validated against a `Reference_Lists` column. **Date** = custom `yyyy-mm-dd` number format, with "is valid date / reject invalid input" validation unless noted otherwise.

### `_Instructions`

Not data — a single column of plain-text paragraphs (one per row) explaining the rules above and giving step-by-step "how to add a new X" procedures. Meant to be read by both humans and AI agents editing the sheet directly. Kept in sync with this document's Section 2 and Section 5.

### `People` (PK: `Person ID`, one row per human, ever)

| Column                         | Notes                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Person ID                      | `P####`, primary key                                                          |
| Legal First Name               |                                                                               |
| Preferred First Name           |                                                                               |
| Legal Last Name                |                                                                               |
| Cell Phone                     |                                                                               |
| Personal Email                 |                                                                               |
| Mailing Address                |                                                                               |
| Pronouns                       | Dropdown (`Reference_Lists!I`)                                                |
| Food Allergies / Requirements  | Free text                                                                     |
| Employer                       | Free text                                                                     |
| Gender Identity                | Free text (self-identified, not a dropdown)                                   |
| Shirt Size                     | Dropdown (`Reference_Lists!H`)                                                |
| Birthday                       | Date                                                                          |
| Physical Accommodations Needed | Free text                                                                     |
| Rookie Year                    | The FIRST season year of the person's first season on the team, in _any_ role |
| Active/Inactive                | Dropdown (`Reference_Lists!D`)                                                |
| Status Changed Date            | Date — updated whenever Active/Inactive changes                               |

Emergency contact info is intentionally **not** on this tab — see `Emergency_Contacts`.

### `People_Roles` (PK: `Person ID`, one row per role held)

| Column    | Notes                                                                      |
| --------- | -------------------------------------------------------------------------- |
| Person ID |                                                                            |
| Role      | Dropdown (`Reference_Lists!A`): `Mentor`, `Volunteer`, `Alumni`, `Student` |

A person can have multiple rows (multiple roles). Roles are additive/historical — gaining a new role (e.g. Student → Alumni) does not remove the old role row.

### `People_Skills` (PK: `Person ID`, one row per skill/interest)

| Column           | Notes                          |
| ---------------- | ------------------------------ |
| Person ID        |                                |
| Skill / Interest | Dropdown (`Reference_Lists!G`) |

### `Emergency_Contacts` (PK: `Person ID`, one row per contact — applies to every human, any role)

| Column             | Notes                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Person ID          | Whose contact this is                                                                                    |
| Contact First Name |                                                                                                          |
| Contact Last Name  |                                                                                                          |
| Cell Phone         |                                                                                                          |
| Email              |                                                                                                          |
| Relationship       | Dropdown (`Reference_Lists!C`): `Parent/Guardian`, `Grandparent`, `Spouse`, `Sibling`, `Friend`, `Other` |
| Rank               | Integer; `1` = primary contact (called first). `99` = on file but not to be contacted.                   |

For a **student**, a `Parent/Guardian` contact whose `Rank` is not `99` is on `grp-parents` while the student is Active. hawk-mod reads only `Person ID`, `Email`, `Relationship` and `Rank` here — never a contact's name or phone.

### `Mentor_Details` (PK: `Person ID`, one row per mentor)

Current header order:

| Column                      | Type     | Notes                                                                                                                                                                                       |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Person ID                   |          |                                                                                                                                                                                             |
| RHR Email                   |          | The mentor's `@redhawkrobotics.org` Google account, created by an administrator in the Admin console before this row is added                                                               |
| Slack User ID               |          | Normally filled in by hawk-mod; may be typed in when needed (see Section 2)                                                                                                                 |
| Consent & Release Expiry    | Date     | Annual; expires Aug 1                                                                                                                                                                       |
| Mentor Ready Completed      | Date     | One-time badge/certification — completion date, not an expiry. Column was renamed from "Mentor Ready Expiry"; old expiry-style values were cleared when it became a completion-date column. |
| YPT Expiry                  | Date     | Youth Protection Training; annual, expires Aug 1. (Column was renamed from "YPP Expiry" — same underlying certification.)                                                                   |
| Background Screening Expiry | Date     | Every 3 years                                                                                                                                                                               |
| CORI Expiry                 | Date     | Every 3 years                                                                                                                                                                               |
| Data Privacy Expiry         | Date     | Annual (FIRST's Data Privacy for Mentors); expires Aug 1                                                                                                                                    |
| RHR Media Release Completed | Date     | One-time form — completion date                                                                                                                                                             |
| Media Release Scope         | Dropdown | `Reference_Lists!F`: `No recognizable image of me`, `Any image as long as I am not named`, `Any image containing me (unrestricted)`                                                         |
| Mentor Lead (Y/N)           | Dropdown | `Reference_Lists!E` (Y/N); default N                                                                                                                                                        |
| RA (Y/N)                    | Dropdown | `Reference_Lists!E` (Y/N); default N. **Manual judgment call only** — never derived from anything else. `Y` grants organizer access to this entire sheet via `grp-ra`.                      |

All 7 date columns (`Consent & Release Expiry`, `Mentor Ready Completed`, `YPT Expiry`, `Background Screening Expiry`, `CORI Expiry`, `Data Privacy Expiry`, `RHR Media Release Completed`) carry `yyyy-mm-dd` formatting and "is valid date, reject invalid input" data validation.

A mentor joins Google Groups and is invited to Slack only once their CORI is current — the district's line. YPT and Background Screening do not block access; they raise alerts, and are required to count as a screened adult under FIRST's rules. Which Google Groups they join, and when, is decided in [`lifecycle-sync.md`](lifecycle-sync.md#groups).

### `Mentor_Admin_Roles` (PK: `Person ID`, one row per delegated admin role held)

| Column     | Notes                                                             |
| ---------- | ----------------------------------------------------------------- |
| Person ID  |                                                                   |
| Admin Role | Dropdown (`Reference_Lists!B`): `Groups Admin`, `Help Desk Admin` |

Only add a row for someone who is actually granted a delegated admin role — most mentors don't get one. **Super Admin is intentionally not tracked here** — it's managed directly in Google Workspace, not via this sheet.

### `Student_Details` (PK: `Person ID`, one row per student)

Current header order (A→T):

| Column                                     | Type      | Notes                                                                                                           |
| ------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------- |
| Person ID                                  |           |                                                                                                                 |
| School Student ID (optional)               |           |                                                                                                                 |
| School Email                               |           |                                                                                                                 |
| Slack User ID                              |           | Normally filled in by hawk-mod; may be typed in when needed (see Section 2)                                     |
| Graduation Year                            |           |                                                                                                                 |
| Additional Notes (medical / special needs) | Free text |                                                                                                                 |
| Race/Ethnicity                             | Free text | Deliberately not a dropdown — self-identification, not forced categories                                        |
| Primary Language at Home                   | Free text |                                                                                                                 |
| Highest Education Level at Home            | Free text |                                                                                                                 |
| How Heard About RHR                        | Free text |                                                                                                                 |
| Other Extracurriculars                     | Free text |                                                                                                                 |
| Student Lead (Y/N)                         | Dropdown  | `Reference_Lists!E`; default N                                                                                  |
| Slack Consent Expiry                       | Date      | Annual form                                                                                                     |
| Annual Field Trip Form Expiry              | Date      | Annual form                                                                                                     |
| FIRST Account Completed                    | Date      | One-time — completion date, not an expiry                                                                       |
| FIRST Consent Form Expiry                  | Date      | Annual form                                                                                                     |
| Melrose Media Release Expiry               | Date      | Annual form; **exception:** literal `N/A` allowed if the student isn't in Melrose schools                       |
| RHR Media Release Expiry                   | Date      |                                                                                                                 |
| Media Release Scope                        | Dropdown  | `Reference_Lists!F` — same three options as `Mentor_Details`                                                    |
| Parent Employer (Potential Sponsor)        | Free text | Only filled in if the intake form names an employer a parent thinks might sponsor the team; blank if none given |

Date columns (`Slack Consent Expiry`, `Annual Field Trip Form Expiry`, `FIRST Account Completed`, `FIRST Consent Form Expiry`, `Melrose Media Release Expiry`, `RHR Media Release Expiry`) carry `yyyy-mm-dd` formatting; most carry "is valid date" validation (show-a-warning style, not reject).

### `Student_Surveys` (PK: `Person ID`, one row per survey administered)

| Column                                         | Notes         |
| ---------------------------------------------- | ------------- |
| Person ID                                      |               |
| Survey Date                                    | Date          |
| Willing to try something new/technical (1-5)   | Likert rating |
| Understands how engineers solve problems (1-5) | Likert rating |
| STEM concepts interest me (1-5)                | Likert rating |
| I belong in STEM activities (1-5)              | Likert rating |

Left blank at student intake — populated later, on each survey cycle.

### `Student_Survey_Concepts` (PK: `Person ID`, one row per concept a student selected)

| Column      | Notes                                                        |
| ----------- | ------------------------------------------------------------ |
| Person ID   |                                                              |
| Survey Date | Date                                                         |
| Concept     | Free text — one row per concept selected on that survey date |

Also left blank at intake, populated per survey cycle.

### `Alumni_Details` (PK: `Person ID`, one row per alum)

| Column                   | Notes |
| ------------------------ | ----- |
| Person ID                |       |
| College                  |       |
| Expected Graduation Date | Date  |

### `Reference_Lists` (controlled vocabularies — not person data)

One column per dropdown, values top-to-bottom. This is the **only** place free-text-turned-dropdown values are added; nothing else in the sheet should ever have a validated column populated with a value that isn't first listed here.

| Column                       | Backs                                                  | Values                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Roles                    | `People_Roles.Role`                                    | Mentor, Volunteer, Alumni, Student                                                                                                                                                                       |
| B — Admin Roles              | `Mentor_Admin_Roles.Admin Role`                        | Groups Admin, Help Desk Admin                                                                                                                                                                            |
| C — Relationship             | `Emergency_Contacts.Relationship`                      | Parent/Guardian, Grandparent, Spouse, Sibling, Friend, Other                                                                                                                                             |
| D — Active/Inactive          | `People.Active/Inactive`                               | Active, Inactive                                                                                                                                                                                         |
| E — Y/N                      | Mentor Lead, RA, Student Lead columns                  | Y, N                                                                                                                                                                                                     |
| F — Media Release Scope      | `Mentor_Details`/`Student_Details`.Media Release Scope | No recognizable image of me; Any image as long as I am not named; Any image containing me (unrestricted)                                                                                                 |
| G — Skills / Interests       | `People_Skills.Skill / Interest`                       | CAD; Machining & Fabrication; Electronics; Software; Game Strategy; Documentation; Mechanical Robot Design and Build; Finance & Treasurer; Fundraising & Grant Writing; Marketing & Outreach; Multimedia |
| H — Shirt Size               | `People.Shirt Size`                                    | XS, S, M, L, XL, 2XL, 3XL                                                                                                                                                                                |
| I — Pronouns (if a dropdown) | `People.Pronouns`                                      | he/him, she/her, they/them, she/they, he/they, any                                                                                                                                                       |

---

## 4. Workflows ("how to add a new...")

### New student (from an intake/roster form)

1. Check `People` for an existing match (name/email) first — this person may already exist under another role.
2. Generate the next `Person ID` per the ID rule in Section 2.
3. Add one row to `People` with contact/demographic info and `Rookie Year` (their first season on the team). Set `Active/Inactive = Active` and `Status Changed Date = today`.
4. Add one row to `People_Roles`: `Role = Student`.
5. Add one row to `Student_Details` with the school/demographic fields from the form. `Student Lead (Y/N)` defaults to `N` unless told otherwise. Leave form-status columns blank until each form is actually returned, then enter its expiry date (annual forms) or completion date (`FIRST Account Completed`). Enter `N/A` in `Melrose Media Release Expiry` if the student isn't in Melrose schools. Set `Media Release Scope` from what the family selected. If a parent's employer is named as a possible sponsor, record it in `Parent Employer (Potential Sponsor)`; otherwise leave blank.
6. Add one row to `Emergency_Contacts` per caregiver on the form (at least one), with `Relationship` and `Rank` (`Rank 1` = primary contact, called first).
7. Leave `Student_Surveys` / `Student_Survey_Concepts` blank at intake — populated later, per survey cycle.
8. Don't add rows to any `Mentor_*` tab, or to `Alumni_Details`, for a new student.

### New mentor

1. Check `People` first — a returning alum or former student becoming a mentor should get a new _role_ row, not a new `Person ID`.
2. If genuinely new, generate the next `Person ID` and add a `People` row, including `Rookie Year`. Emergency contact info for mentors goes in `Emergency_Contacts`, not on the `People` row.
3. Add a `People_Roles` row: `Role = Mentor`.
4. Agree the mentor's `@redhawkrobotics.org` address with them (not everyone wants `firstname@`), and add a `Mentor_Details` row with it as `RHR Email`. hawk-mod then asks, in the onboarding channel, for a Super Admin to create the Google account at that address; the request closes once the account exists. If the address is not agreed yet, leave `RHR Email` blank and hawk-mod asks for both. Fill in each requirement date as it's completed (blank = not started yet): `YPT Expiry`, `Background Screening Expiry`, `CORI Expiry`, `Consent & Release Expiry`, `Data Privacy Expiry` (each copied from FIRST or the state, never calculated), and `Mentor Ready Completed` (the date the badge was earned). `RHR Media Release Completed` is the date the one-time form was done; set `Media Release Scope` from what they selected on that form. Set `Mentor Lead (Y/N)` and `RA (Y/N)` — both default to `N` unless told otherwise; `RA` is a manual judgment call, not derived from anything else. Leave `Slack User ID` blank — hawk-mod fills it in. The mentor joins Google Groups and is invited to Slack only once their CORI is current; hawk-mod posts the invite request then.
5. Only add a `Mentor_Admin_Roles` row if they're granted a delegated admin role — most mentors don't get one.

### New volunteer

1. Check `People` first, as above.
2. If new, generate the next `Person ID` and add a `People` row, then a `People_Roles` row: `Role = Volunteer`.
3. There's no `Volunteer_Details` tab — volunteers only need `People` + `People_Roles`, unless they also hold another role (in which case add the relevant extension-tab rows for that role too).

### New alumnus

1. This is usually an existing Student whose role is changing, not a new person — check `People_Roles` for their Student row first.
2. Add a new `People_Roles` row: `Role = Alumni`. Keep their existing Student role row too — roles are additive/historical, not overwritten.
3. Add an `Alumni_Details` row: `College` + `Expected Graduation Date`.

If a situation isn't covered by these rules, ask the sheet's owner before guessing.

---

## 5. Ground rules for anyone (human or AI) editing this sheet directly

- Do not change, delete, reorder, or sort any existing data rows unless a specific rule/step calls for it.
- Do not invent or calculate dates. Every date comes from FIRST's or the state's records (or the relevant form), entered by a human. Leave new/uncertain date cells blank.
- Do not delete placeholder sample rows without the owner's sign-off (see Section 2, "Placeholder/sample data").
- Do not change any tab names, or any column headers, without first coordinating with whoever maintains hawk-mod — the sync reads by exact tab name and header text, and a rename/add/remove will stop the sync with an error. Column _order_ is safe to change.
- Do not change sharing or permissions on the sheet.
- The sheet holds minors' personal data (it covers a youth robotics program). Treat any actual data you read from it as sensitive — don't copy real names, emails, phone numbers, or other student/mentor PII into logs, chat messages, or other documents (including into another AI system) unless that's specifically what the task requires and appropriate care/authorization is in place.
- If something about the live sheet doesn't match what this document describes, stop and confirm with the sheet's owner rather than guessing — the schema evolves over time, and this document can fall behind it.

---

## 6. Notes for an integrating AI/agent

- Treat `Person ID` as the sheet's only stable foreign key. Never join on name or email — a person can change their name/email but keeps the same `Person ID` for life.
- Before writing a new row anywhere, always resolve to an existing `Person ID` first by searching `People`; only mint a new ID if no match exists.
- Any column you intend to write a value into that is backed by `Reference_Lists` must use one of the listed values verbatim — do not write free text into a dropdown column, and do not invent a new controlled value without first appending it to the appropriate `Reference_Lists` column.
- Never compute or write to any of the `grp-*` Google Groups directly from this sheet's data in your own logic — hawk-mod owns that computation. Treat group membership as a **result of** the sheet, not something it stores.
- This document can fall behind the live sheet. Schema changes (renamed/added columns, new validation) happen over time; re-verify against the live `_Instructions` tab and the tab headers themselves before relying on this document for anything write-critical.

---

_A structural description of the sheet. Contains no personal data. When the sheet's tabs or headers change, update this file and `SHEET_TABS` in the same change._
