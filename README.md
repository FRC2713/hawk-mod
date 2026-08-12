# hawk-mod

Youth-protection monitoring for the Red Hawk Robotics Slack workspace.

Slack does not let us block direct messages between mentors and students below
Enterprise Grid, and Information Barriers — the only feature that would — is
Grid-only. So any mentor can DM any student from day one. We cannot prevent
this. **hawk-mod is the detection half of that tradeoff**, made continuous and
recorded instead of quarterly and manual.

It implements the controls in _Moving Team Communication to Slack_ §4 and §6.

## What it does

**Monitors DMs that include a student.** Each mentor authorizes hawk-mod on
their own account, granting `im:history` and `mpim:history`. hawk-mod then
receives that mentor's DM events, classifies each conversation by who is in it,
and records every message in the ones that include a student — including edits
and deletions. Conversations with no student in them are classified and then
discarded; hawk-mod is not a general archive of the mentors' Slack.

**Flags conversations the mentor agreement does not permit**, the moment they
appear:

| Situation                                                        | Verdict                                |
| ---------------------------------------------------------------- | -------------------------------------- |
| 1:1 DM between any adult and a student                           | violation — prohibited outright (§4.1) |
| Group DM with a student and fewer than two _screened_ adults     | violation (§4.2)                       |
| Any conversation with a student and an account not on the roster | violation                              |
| Group DM with a student and two screened adults                  | recorded, allowed                      |
| Student-only conversation                                        | recorded, not a mentor-conduct issue   |

**Tracks the things that make the above meaningful**, on a nightly sweep:

- students with Slack accounts and no current parental consent (§2)
- Slack accounts with no roster entry at all
- mentors whose YPP, Mentor Ready, or CORI/fingerprint checks have lapsed (§7)
- **mentors who have not authorized hawk-mod, or who revoked it** — see below
- channels containing students with fewer than two screened adults (§4.2)
- fewer than two workspace owners, or a student holding Owner/Admin (§6)

Findings are posted once to a private channel, deduplicated, auto-closed when
the underlying problem goes away, and closable by a Lead Coach with a required
written reason. A DM violation is never auto-closed — a prohibited DM that
happened is a historical fact, and only a person should be able to sign it off.

## What it cannot see

Stated plainly, because a control whose gaps are undocumented is worse than no
control:

- **Mentors who do not enroll.** hawk-mod sees DMs through mentors' own tokens.
  A mentor who never authorizes it, or who revokes it later, is invisible —
  which is why `mentor_not_enrolled` and `enrollment_revoked` are themselves
  treated as violations rather than as silence. Enrollment coverage is the first
  number in `/hawkmod status` for the same reason.
- **Huddles.** Unrecorded 1:1 voice, the same problem as DMs, with no API to
  observe it. Turn them off (§6).
- **Slack Connect DMs from outside the workspace.** Disable them (§6).
- **Private channels hawk-mod has not been invited to.** Public channels are
  checked whether or not it is a member; private ones require an invite.
- **File contents.** Attachment names, types, and sizes are recorded; the files
  themselves are left in Slack rather than copied onto this host.

The Corporate Export remains the backstop for the first gap, since it captures
non-enrolled mentors too. It is a manual download — Business+ has no API for it,
and the Discovery API is Enterprise Grid only — and ingesting one is **not built
yet**.

## Before you deploy this

hawk-mod records minors' private messages. That is defensible only if everyone
involved knows:

1. **Mentors** sign the conduct agreement and authorize hawk-mod knowingly. The
   authorization screen names the scopes, and the success page says what is
   recorded.
2. **Students and parents** are told in the consent form that DMs are recorded
   and subject to audit (§4.3) — not merely that they are "exportable."
3. **The alert channel is private** and limited to screened adults. Findings
   name students.
4. **Access to the database is limited.** It contains message text when
   `LOG_MODE=full`. Set `LOG_MODE=metadata` to record who/when/how-many and no
   text at all; the policy violations above are all detectable without content.

Do not deploy this quietly. Covert monitoring of minors is a different thing
from an audited, disclosed control, and only the second one is what the board
approved.

## Setup

1. Create the Slack app from `docs/slack-app-manifest.yaml`, replacing the
   example host with your `PUBLIC_URL`.
2. `cp .env.example .env` and fill it in. Generate the encryption key with
   `openssl rand -base64 32` — it encrypts mentor tokens at rest.
3. Create a private channel for findings and put its ID in `ALERT_CHANNEL_ID`.
   Invite hawk-mod to it.
4. `docker compose up -d` (or `npm install && npm run dev`). For the Linode
   host — Caddy, DNS, backups, and the public-reachability requirement — see
   [docs/deploy-linode.md](docs/deploy-linode.md).
5. A Lead Coach installs the app: visit `$PUBLIC_URL/slack/install`.
6. Import the roster and the consents you have already collected:

```bash
npm run cli -- import-roster roster.csv
```

```bash
npm run cli -- import-consents consents.csv
```

7. Send every mentor to `$PUBLIC_URL/slack/install` to enroll. `/hawkmod status`
   shows coverage; do not consider launch complete until it reads N/N.
8. `npm run cli -- backfill` to walk DM history that predates enrollment.

### Roster CSV

```
email,full_name,role,ypp_completed_on,mentor_ready_on,cori_completed_on,active,notes
```

`role` is one of `student`, `mentor`, `lead_coach`, `admin`,
`district_observer` — the last being the MPS administrator seat from §8. Dates
are `YYYY-MM-DD`. Email is the join key; Slack IDs are matched automatically
once people sign up.

### Consents CSV

```
email,signed_on,form_version,guardian_name,guardian_email,document_ref,recorded_by
```

`expires_on` is optional and defaults to one year after `signed_on`, matching
the annual re-collection requirement. `document_ref` should point at wherever
the signed copy is actually filed.

## Commands

In Slack, restricted to Lead Coaches and admins:

```
/hawkmod status | enroll | findings [kind] | whois @user
/hawkmod ack <id> <note> | resolve <id> <note> | sweep | backfill
```

On the host, or `docker compose exec hawk-mod node dist/src/cli/index.js …`:

```bash
npm run cli -- export-conversation D01ABCDEF thread.json
```

That last one is what §4.4 promises: one conversation, in full, with edits and
deletions, when a parent or the district asks for it.

## Development

```bash
npm run dev         # tsx watch
npm run typecheck   # tsc --noEmit
npm test            # node:test over the policy rules
npm run format
```

The rules in `src/domain/rules/` are pure functions and are the part with
tests. They decide whether a conversation is allowed to exist based only on who
is in it — never on what was said — so the policy is enforceable without anyone
reading a child's messages.
