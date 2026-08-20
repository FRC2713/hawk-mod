# Policy → mechanism

Each control from
[_Moving Team Communication to Slack_](moving-team-communication-to-slack.md),
and what carries it.
"Manual" means hawk-mod cannot do it and does not pretend to.

| §   | Control                                                                       | Carried by                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | Parental consent on file before a student account exists                      | `consent.ts`; `team_join` event raises `unconsented_account` the moment an account appears; nightly sweep re-checks                                                                                             |
| 2   | Consent re-collected annually                                                 | `CONSENT_VALID_YEARS = 1`; consents expire rather than linger                                                                                                                                                   |
| 2   | Consents kept on file and producible                                          | `consents` table records `document_ref`; the signed copies themselves live wherever the team files them — **manual**                                                                                            |
| 2   | Parents notified of the PII collected and shared (Slack CSS §IV)              | [`consent-form.md`](consent-form.md) — **manual**. The form is the artifact; hawk-mod records only that a version of it was signed (`form_version`)                                                             |
| 2   | Consent withdrawable on request                                               | `revokeConsent()` exists in `repo.ts` but **has no caller** — no CLI, no modal. The form promises this; the tool cannot yet do it                                                                               |
| 3   | Two YPP-screened Lead Coaches                                                 | `workspace_config` `screened_admins`: two of the workspace's Owners/Admins must be screened adults on the roster, plus `screening_lapsed` findings                                                              |
| 3   | Written communications copied to a second adult                               | `dmPolicy` — two screened adults required in any student conversation                                                                                                                                           |
| 4.1 | No 1:1 adult–student DMs, ever                                                | `dmPolicy` `one_to_one_adult_student`, raised on each new message and on backfill; a message after a finding is closed raises it again (`recurrence.ts`)                                                        |
| 4.2 | Two screened adults in every channel students are in                          | `twoAdults.ts`; re-evaluated on every join/leave, plus nightly                                                                                                                                                  |
| 4.3 | Students and parents told DMs are subject to audit                            | [`consent-form.md`](consent-form.md) — **manual**, and a precondition of deploying this. Both halves: the guardian signature block and the student acknowledgment below it                                      |
| 4.4 | Quarterly export actually run and spot-checked                                | continuous instead: DMs are recorded as they happen. The quarterly reminder and runbook keep the human review honest                                                                                            |
| 5   | Business+ / Corporate Export                                                  | procurement — **manual**. Note hawk-mod does not depend on Corporate Export; it is the backstop for adults who never enroll                                                                                     |
| 6   | Retention                                                                     | append-only while retained: deletions are tombstoned, edits keep prior text. No longer "keep everything" — `consent-form.md` promises deletion two years after a student's last day, and **nothing purges yet** |
| 6   | Slack Connect external DMs disabled                                           | workspace setting, not API-readable — **manual**                                                                                                                                                                |
| 6   | Invites restricted to Owners/Admins                                           | workspace setting — **manual**; `unknown_account` catches the consequence                                                                                                                                       |
| 6   | Two Workspace Owners minimum, never a student                                 | `workspace_config` findings                                                                                                                                                                                     |
| 6   | User group editing restricted to Owners/Admins                                | workspace setting — **manual**. Only matters when `STUDENT_USERGROUP`/`ADULT_USERGROUP` are set, since group membership then declares who is monitored                                                          |
| 6   | Real names enforced                                                           | workspace setting — **manual**                                                                                                                                                                                  |
| 6   | Huddles off                                                                   | no API to observe huddles — **manual**, and the reason it matters is in the README's gap list                                                                                                                   |
| 7   | Youth Protection Training annually (the part FIRST requires for clearance)    | `screening.ts`, `YPT_VALID_YEARS = 1`                                                                                                                                                                           |
| 7   | CORI + national fingerprints every 3 years (M.G.L. c. 71 §38R, 603 CMR 51.00) | `screening.ts`, `CORI_VALID_YEARS = 3`                                                                                                                                                                          |
| 8   | MPS administrator added to the workspace                                      | roster role `district_observer`; counts as an adult only with screening dates recorded. Voluntary — IJNDD does not require it (see the correction below)                                                        |
| 8   | Employee-mentor keeps to channels, no student DMs (IJNDD clause k)            | **manual**, and deliberately so: the employee manual binds that one person more tightly than §4.1 does, and hawk-mod is not the enforcer of it                                                                  |
| 8   | Public-records retention for the employee-mentor (M.G.L. c. 66 §10)           | substantively covered — messages are retained and producible via `export-conversation`; IJNDD's forward-to-school-e-mail expectation is **manual**                                                              |
| 8   | Written approval from the principal before launch                             | **manual**, and blocking                                                                                                                                                                                        |

## Corrections worth keeping straight

**Mentor Ready is optional.** FIRST describes it as encouraged, not required
for YPP Clearance: it is a path of four components — Welcome to _FIRST_, Youth
Protection Training, Data Privacy for Mentors, Role of a Mentor — and only the
training inside it is required. hawk-mod tracks it and reports it as
outstanding, but it never blocks screened-adult status. Requiring it would
have excluded adults who had done everything actually asked of them.

**IJNDD says less than §8 assumed.** The source document quoted two clauses as
typical of the policy family, flagged as unconfirmed, and hung the
employee-mentor question on the first of them. Melrose's adopted text
(_Electronic Communication/Social Media_, June 12, 2018) contains neither, nor
the "improper fraternization" phrasing §8 attributed to it. Its individual-contact
clause is advisory ("should") and expressly contemplates non-district platforms
carrying school business once families are told. Two consequences for this table:
the `district_observer` seat is goodwill rather than a required control, and the
real constraint on that mentor is clause (k) — coach messages go to all team
members — which is stricter than §4.1 and belongs to the employee manual, not to
hawk-mod.

**"Lead Coach" is not a role hawk-mod stores.** It used to be: a roster role
that granted every administrative action in the app. That put a
youth-protection permission behind a label anyone with CLI access could type,
checked against nothing, and it meant a freshly installed app had no
administrator at all until someone opened a shell on the host. Authority is now
read live from Slack's Workspace Owner/Admin flags, which the workspace already
manages and audits. §3 is still checked — see the `screened_admins` row — but
it asks the question of the people who demonstrably hold the authority rather
than of a self-assigned label. A student holding Owner or Admin is refused
regardless (§6), and reported.

**The screening and the training run on different clocks.** The background
screening is valid for longer than a year; the training is annual. Treating
both as annual flags people who are current, and an alert channel that cries
wolf is one nobody reads. `SCREENING_VALID_YEARS` is set to 4 — confirm it
against FIRST before each season.

## Deliberate non-goals

- **No content analysis.** hawk-mod does not scan messages for keywords,
  sentiment, or "concerning" language. Every verdict above comes from who is in
  a conversation. Adding content heuristics would trade a rule the team can
  explain to a parent for a classifier it cannot.
- **No surveillance of youth-to-youth conversation.** Student-only DMs are not
  recorded, and students cannot enrol. YPP governs adult conduct toward youth;
  collecting minors' peer conversations would be a privacy harm with no control
  to justify it, and would need consent far beyond what §4.3 describes.
- **No blocking.** Slack does not offer it below Grid, and simulating it by
  deleting messages or deactivating accounts would be both unreliable and a
  worse posture than a complete record.
- **No archive of adult-only conversations.** Adult-to-adult DMs are outside
  the purpose the students' parents consented to.
