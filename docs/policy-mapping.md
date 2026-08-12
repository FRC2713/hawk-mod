# Policy → mechanism

Each control from _Moving Team Communication to Slack_, and what carries it.
"Manual" means hawk-mod cannot do it and does not pretend to.

| §   | Control                                                                       | Carried by                                                                                                                                             |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2   | Parental consent on file before a student account exists                      | `consent.ts`; `team_join` event raises `unconsented_account` the moment an account appears; nightly sweep re-checks                                    |
| 2   | Consent re-collected annually                                                 | `CONSENT_VALID_YEARS = 1`; consents expire rather than linger                                                                                          |
| 2   | Consents kept on file and producible                                          | `consents` table records `document_ref`; the signed copies themselves live wherever the team files them — **manual**                                   |
| 3   | Two YPP-screened Lead Coaches                                                 | roster `role = lead_coach` + `screening_lapsed` findings                                                                                               |
| 3   | Written communications copied to a second adult                               | `dmPolicy` — two screened adults required in any student conversation                                                                                  |
| 4.1 | No 1:1 adult–student DMs, ever                                                | `dmPolicy` `one_to_one_adult_student`, raised on first message and on backfill                                                                         |
| 4.2 | Two screened adults in every channel students are in                          | `twoAdults.ts`; re-evaluated on every join/leave, plus nightly                                                                                         |
| 4.3 | Students and parents told DMs are subject to audit                            | consent form wording — **manual**, and a precondition of deploying this                                                                                |
| 4.4 | Quarterly export actually run and spot-checked                                | continuous instead: DMs are recorded as they happen. The quarterly reminder and runbook keep the human review honest                                   |
| 5   | Business+ / Corporate Export                                                  | procurement — **manual**. Note hawk-mod does not depend on Corporate Export; it is the backstop for adults who never enroll                            |
| 6   | Retention "keep everything"                                                   | this log is append-only: deletions are tombstoned, edits keep prior text                                                                               |
| 6   | Slack Connect external DMs disabled                                           | workspace setting, not API-readable — **manual**                                                                                                       |
| 6   | Invites restricted to Owners/Admins                                           | workspace setting — **manual**; `unknown_account` catches the consequence                                                                              |
| 6   | Two Workspace Owners minimum, never a student                                 | `workspace_config` findings                                                                                                                            |
| 6   | User group editing restricted to Owners/Admins                                | workspace setting — **manual**. Only matters when `STUDENT_USERGROUP`/`ADULT_USERGROUP` are set, since group membership then declares who is monitored |
| 6   | Real names enforced                                                           | workspace setting — **manual**                                                                                                                         |
| 6   | Huddles off                                                                   | no API to observe huddles — **manual**, and the reason it matters is in the README's gap list                                                          |
| 7   | Youth Protection Training annually (the part FIRST requires for clearance)    | `screening.ts`, `YPT_VALID_YEARS = 1`                                                                                                                  |
| 7   | CORI + national fingerprints every 3 years (M.G.L. c. 71 §38R, 603 CMR 51.00) | `screening.ts`, `CORI_VALID_YEARS = 3`                                                                                                                 |
| 8   | MPS administrator added to the workspace                                      | roster role `district_observer`; counts as an adult only with screening dates recorded                                                                 |
| 8   | Written approval from the principal before launch                             | **manual**, and blocking                                                                                                                               |

## Corrections worth keeping straight

**Mentor Ready is optional.** FIRST describes it as encouraged, not required
for YPP Clearance: it is a path of four components — Welcome to _FIRST_, Youth
Protection Training, Data Privacy for Mentors, Role of a Mentor — and only the
training inside it is required. hawk-mod tracks it and reports it as
outstanding, but it never blocks screened-adult status. Requiring it would
have excluded adults who had done everything actually asked of them.

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
