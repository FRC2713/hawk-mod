# Source formats and how each maps onto the sheet

Structure only. This file is public, so it holds column wording and rules,
never a value anyone entered. It was recovered from the first manual
conversion and corrected against the sheet's rules where that conversion broke
one. The corrections are marked **(corrected)**.

Tab and column names are as in `docs/lifecycle-sheet.md` §3. Where a source
field is "set aside", list it in the approved table instead of writing it.

## Rules every format shares

- **Phone numbers:** keep the digits only, drop a leading country-code `1`
  from an 11-digit number, and write `xxx-xxx-xxxx`. Any other 11-digit value,
  or a number that isn't 10 digits, is set aside.
- **Names:** trim spaces. Capitalise a name entered all in lowercase.
  Otherwise keep it as written.
- **The same person in two sources or two submissions:** the latest
  person-submitted source wins, field by field. When the newer value looks
  like a relative's (a parent's phone number repeated as the student's, for
  example), keep the older value and list the choice. Never overwrite a value
  already on the sheet. That is a _difference_ for the operator (gate 2).
- **Dropdown values** (Pronouns, Shirt Size, Skill / Interest, Relationship,
  Media Release Scope) go in verbatim from `Reference_Lists`. A plain spelling
  variant maps to the listed value: `XXL` is `2XL`, and `He/Him` is `he/him`.
  Anything else goes on _values to add_, with the cell left blank.
  **(corrected:** pronouns that didn't match were once kept as typed, and an
  oversized range was mapped to the "nearest" size.)
- **Misaligned rows**, a row that looks shifted against its header, are set
  aside. Ask for a clean export or the original response.
  **(corrected:** these were once rebuilt by a positional guess.)
- **Rookie Year** stays blank. No source asks "first season on _this_ team",
  and prior robotics experience elsewhere doesn't answer it.

## A — Google Workspace directory export

**Recognise by:** `First Name [Required]`, `Last Name [Required]`,
`Email Address [Required]`, `Mobile Phone` / `Work Phone` / `Home Phone`, a
recovery phone in E.164 format, `Recovery Email`, `Home Secondary Email` /
`Work Secondary Email`, `Home Address` / `Work Address`. One row per account.

An account is not a role. Being in the directory doesn't make someone a
mentor. The role comes from the operator, or from another source.

| Source field                                                         | Goes to                           | Notes                                                              |
| -------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| First / Last Name                                                    | `People`: Legal First / Last Name |                                                                    |
| Email Address (`@redhawkrobotics.org`)                               | `Mentor_Details`: RHR Email       | Mentors only.                                                      |
| Mobile, then Work, then Home, then Recovery Phone                    | `People`: Cell Phone              | The first one present.                                             |
| Recovery Email, then Home / Work Secondary Email                     | `People`: Personal Email          | The first one that isn't a team or school address.                 |
| Home Address, else Work Address                                      | `People`: Mailing Address         | One taken from Work Address is listed for the operator to confirm. |
| A shared or service account (`calendar@`, for example), not a person | set aside                         |                                                                    |

## B — Mentor interest form

**Recognise by:** `Timestamp`, `Email Address`, `First Name`, `Last Name`,
`Phone Number`, an age-group question, an areas-of-interest question,
`T-Shirt Size`, a food-allergy question, a free-text `Notes`, and a
certification column worded like "\_\_ed? as of [date]".

| Source field             | Goes to                                           | Notes                                                                                                                                                      |
| ------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First / Last Name, Email | match; `People`: Personal Email if not a team one |                                                                                                                                                            |
| Phone Number             | `People`: Cell Phone                              | Only if the sheet or Format A has none.                                                                                                                    |
| Areas of interest        | `People_Skills`, one row per interest             | Reference_Lists G values only.                                                                                                                             |
| T-Shirt Size             | `People`: Shirt Size                              |                                                                                                                                                            |
| Food allergies           | `People`: Food Allergies / Requirements           | Every "none"-type answer becomes one standard value.                                                                                                       |
| Certification column     | **blank**, plus a line on _dates to get_          | **(corrected:** a "yes" was once turned into an invented future expiry date. The real date comes from FIRST's or the state's record, entered by a person.) |
| Age-group interest       | set aside                                         | No column for it.                                                                                                                                          |
| Notes                    | set aside                                         | If it describes a certification-timing exception, mention that in the table. Never copy it.                                                                |

## C — Form-completion list

**Recognise by:** four columns: first name, last name, email, and one
TRUE/FALSE column saying whether a particular annual form was completed.

| Source field             | Goes to                                  | Notes                                                                                                                                                  |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First / Last Name, Email | match only                               | By email first, then by name.                                                                                                                          |
| TRUE                     | **blank**, plus a line on _dates to get_ | **(corrected:** TRUE was once written as an invented future expiry. The list says the form was done, not when it expires. Ask for the date on record.) |
| FALSE or blank           | nothing                                  | Blank already means "not on file".                                                                                                                     |

## D — Slack member export

**Recognise by:** full name, a member ID (letters and digits, starting with a
fixed letter), display name, email, account type, billing status,
authentication method, an expiration date and a join date. It may arrive as
two blocks: every name first, then every other field. Pair the blocks
position by position before matching, and set the whole export aside if the
two blocks have different lengths.

| Source field                                                 | Goes to         | Notes                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Member ID                                                    | **not written** | **(corrected:** this was once written into `Slack User ID`.) `/hawkmod lifecycle slack-ids apply` fills it by exact email match. Use the export to put people on the _already in Slack_ list in gate 2, and to find people with two accounts, which are set aside. |
| Email, names                                                 | match only      |                                                                                                                                                                                                                                                                    |
| Account type, billing, authentication, expiration, join date | set aside       | Account metadata. The expiration is the Slack account's, not a form's.                                                                                                                                                                                             |

## E — Student sign-up form

**Recognise by:** `Student First Name` / `Student Last Name`, a free-text
pronouns field, a dietary question, "Have you been on any robotics team
before?", a grade question naming a school year, a long media/photo-release
question, `Parent/Guardian 1` and `Parent/Guardian 2` name, email and phone
columns, a sponsorship question, a program-selection question, school name
and interest-level pairs for several program tiers, a school-email column and
a student-phone column (both for high-schoolers), a block of
`Student Interests: [Category]` columns, a participation/availability
question, a shirt-size question, a parent-volunteer question, and a trailing
`Email Address` that is sometimes the student's and sometimes a parent's.

| Source field                   | Goes to                                                 | Notes                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Student First / Last Name      | `People`: Legal First / Last Name                       |                                                                                                                                                                                                                                                                                                                |
| Pronouns                       | `People`: Pronouns                                      | Dropdown rule above.                                                                                                                                                                                                                                                                                           |
| Dietary                        | `People`: Food Allergies / Requirements                 | What they can and can't eat. If the answer names a medical condition, the condition goes to `Student_Details`: Additional Notes (medical / special needs), so the dietary field stays a food-handling instruction.                                                                                             |
| Grade                          | `Student_Details`: Graduation Year                      | A **derived value**: the year that grade graduates, counted from the school year the question names. Show the working in the table. A grade below the range the sheet covers sets the whole person aside.                                                                                                      |
| Media/photo release            | `Student_Details`: Media Release Scope                  | Only if the chosen option matches a Reference_Lists F value. The release's expiry stays blank until the signed form comes back.                                                                                                                                                                                |
| School name                    | `Student_Details`: Melrose Media Release Expiry = `N/A` | Only when the school is named and is clearly not a Melrose school. Otherwise blank.                                                                                                                                                                                                                            |
| School email                   | `Student_Details`: School Email                         | Only a school-domain address. One of the student's own personal addresses goes to `People`: Personal Email instead. A guardian's address goes nowhere on the student's row. With no school address, School Email stays blank and the student is still imported. List it as an expected sheet problem (gate 2). |
| Student phone                  | `People`: Cell Phone                                    |                                                                                                                                                                                                                                                                                                                |
| Parent/Guardian 1, 2           | `Emergency_Contacts`, one row per guardian given        | See _Guardians_ below.                                                                                                                                                                                                                                                                                         |
| Sponsorship                    | `Student_Details`: Parent Employer (Potential Sponsor)  | The company as given. Vague non-answers dropped. An unrelated volunteering offer in the same answer becomes a short trailing note.                                                                                                                                                                             |
| Student Interests block        | `People_Skills`, one row per "interested"               | Map category labels onto Reference_Lists G only where they're clear synonyms. "Not interested" gives no row.                                                                                                                                                                                                   |
| Participation/availability     | `Student_Details`: Other Extracurriculars               | Only a named outside activity and its effect on the schedule. General attendance wording is set aside.                                                                                                                                                                                                         |
| Shirt size                     | `People`: Shirt Size                                    | Dropdown rule above.                                                                                                                                                                                                                                                                                           |
| Trailing Email Address         | match only                                              | Helps work out which address is the student's and which a parent's. Never stored as its own field.                                                                                                                                                                                                             |
| Prior experience, prior FRC    | set aside                                               | See Rookie Year above.                                                                                                                                                                                                                                                                                         |
| Program selection, other tiers | set aside                                               | A respondent who picked a tier the sheet doesn't cover, and left its fields blank, is set aside whole.                                                                                                                                                                                                         |
| Parent volunteer interest      | set aside                                               | Parents aren't People. That is a separate outreach list.                                                                                                                                                                                                                                                       |

### Guardians

- **One `Emergency_Contacts` row per guardian slot filled**, at most two. One
  guardian given means one row.
- **Relationship:** `Parent/Guardian` for both, because the form doesn't say
  which.
- **Rank:** by slot. Guardian 1 is `1`, guardian 2 is `2`.
- **Name:** with three or more words, split at the second space, so a
  compound first name stays together. With two words, split at the space. A
  single word goes in First Name, with Last Name blank. List every split of
  three or more words for the operator to check.
- **Siblings:** each sibling gets their own rows for a shared guardian. Each
  student needs their own contact chain. Give the new row the same
  `CORI Expiry` the guardian already has elsewhere on the sheet (gate 3).
  Where siblings answered the sponsorship question differently, keep each
  answer as that sibling gave it.
- **No relationship between students is ever inferred.** A shared surname is
  not a sibling link. **(corrected:** once inferred.)
