# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # tsx watch src/index.ts
npm run build          # tsc -> dist/
npm run start          # node dist/src/index.js
npm run typecheck      # tsc --noEmit
npm test               # tsx --test test/*.test.ts
npm run cli -- <cmd>   # roster/consent import, set-role, sweep, backfill, export
npm run format         # prettier
```

`npm run typecheck && npm test && npm run format:check` is the full verification
loop, and is what CI runs (plus `npm run build`). There is no linter.

One test file, or one test:

```bash
npx tsx --test test/rosterSync.test.ts
```

```bash
npx tsx --test --test-name-pattern "two adults" test/rules.test.ts
```

CLI subcommands: `import-roster`, `import-consents`, `set-role`, `sweep`,
`backfill`, `findings [status]`, `export-conversation <id> [out.json]`. None of
them is a bootstrap step: administrative access is Slack's Workspace
Owner/Admin flags, read live in `src/slack/authz.ts`, so a fresh install is
usable by whoever installed it without anyone touching the host. Don't
reintroduce a roster role that grants access — see the "Lead Coach" note in
`docs/policy-mapping.md`.

## What this is

A Slack app that records adult–student direct messages for youth-protection
audit, because Slack cannot block them below Enterprise Grid. The requirements
come from `docs/moving-team-communication-to-slack.md`; §4 and §6
are the parts this implements. `docs/policy-mapping.md` maps each control to the
code that carries it, and records which controls are deliberately manual.

## Architecture

**Two token planes.** The bot token posts alerts and reads channel membership.
Each adult's _user_ token is what makes DMs visible at all — Slack exposes no
other way below Enterprise Grid. `src/slack/installStore.ts` keeps one `bot` row
per workspace and one `user` row per enrolled adult, and `fetchInstallation`
merges them so an event carries both; a bot-only context has any user token
stripped so one adult's token never rides along to a request that did not ask
for it. Tokens are encrypted at rest (`src/crypto.ts`); the DB file alone is not
enough to read anyone's DMs.

**Students may not enroll.** `storeInstallation` throws on a student's user
token, and the sweep revokes and deletes one that appears later (a person can be
moved into the students group after enrolling). Their token would expose
student-to-student DMs, which this deliberately never records.

**Everything durable lives under DATA_DIR** — one SQLite file, one volume.
`src/db/client.ts` opens it, sets WAL and `foreign_keys = ON` (SQLite needs the
latter per-connection or the cascades silently do nothing), and applies
`migrations/NNNN_*.sql` in filename order on boot. Never hand-edit a migration
that has shipped. All SQL lives in `src/db/repo.ts` and nowhere else, and
better-sqlite3 is synchronous — repo functions are not `async`, so anything
`await`ed in this codebase is Slack, not the database.

**`config()` is all or nothing.** One zod parse of the whole environment, on
first use; a missing `SLACK_*` var throws for every caller. That is why
`dataDir()` and `logMode()` exist as separate readers — the CLI runs
`import-roster`, `findings`, and `export-conversation` with no Slack
credentials present. Reaching for `config()` inside a module the CLI can pull
in breaks those commands, and it breaks them at import time.

**The rules are pure and content-blind.** `src/domain/rules/` decides everything
from _who is in a conversation_, never from what was said — `dmPolicy` for DMs,
`twoAdults` for channels, `consent` and `screening` for people, `rosterSync` and
`remediation` for the reconciliations. This is why the tests are cheap and why
the policy is enforceable without reading students' messages. Keep new policy
logic here rather than inside Slack handlers — the three files in `test/` build
plain `Person` and `Member` objects and call the rules directly. There is no
database fixture, no Slack mock, and no test harness beyond `node:test`, so
policy that lands in a handler is policy nothing covers.

**Roles can come from Slack user groups.** `syncRolesFromUserGroups` runs first
in the sweep, because everything after it reads roles, and again on
`subteam_*` events so an edit applies immediately rather than at 3am (the sync
is idempotent, which is what makes the duplicate events harmless). The
reconciliation in `domain/rules/rosterSync.ts` is pure and **add-only by
design**: a person dropped from the students group stays a student, since the
alternative is silently ending someone's monitoring. Only an explicit move into
the adults group leaves `student`, and that raises `roster_drift`. Every change
lands in `role_changes` — Slack's audit log API is Grid-only, so that table is
the only trail. Do not make this bidirectional.

**Findings are the output, and have exactly one door each way.** `src/raise.ts`
persists then alerts, and only alerts when the finding is new or has recurred.
`src/close.ts` is the mirror: change the row, then redraw the alert, so a closed
finding never keeps offering buttons. Anything that closes a finding — slash
command, alert button, modal submit, auto-remediation, the sweep — goes through
`closeFinding`. `dedupe_key` is the identity of a problem across sweeps; get it
wrong and the alert channel becomes noise nobody reads, which is the exact
failure the source document warns about.

**Conditions and occurrences re-alert differently**
(`domain/rules/recurrence.ts`). A condition finding — lapsed screening, an
unenrolled adult — describes something currently true, so re-detection is not
news: acknowledging one keeps it sticky, and only a `resolved` one reopens. An
occurrence finding describes something that _happened_, and the only thing that
can repeat it is a new event. So `raise()` takes an optional `occurrence`, and a
closed finding reopens only when the event is newer than the closure.

The corollary is a rule about where the alarm is wired: **a DM finding is raised
by a message, never by an evaluation.** `ensureConversation` classifies and
caches and deliberately raises nothing — it runs on every message and on every
hourly backfill pass over every DM every enrolled adult has, so "we looked at it"
carries no information. `raiseDmViolation` is the reporting half, called from
`recordMessage` only when `insertMessage` reports the row was genuinely new, and
anchored to the message's own Slack `ts`. Move the raise back into the
evaluation and a resolved finding reopens itself hourly forever, because the DM
never stops existing.

**Guidance is advisory and rides on the alert.** When a DM finding alerts,
`slack/guidance.ts` DMs the adults in that conversation with the rule and the
concrete fix (`domain/guidance.ts` composes the text, purely, from the verdict).
Three rules hold it in place: it fires on `raise()`'s `alerted`, so one nudge per
occurrence rather than one per message; it never replaces the finding, which is
already durable and already in the alert channel; and **it never reaches the
student** — it goes to `verdict.adultIds`, which excludes students by
construction. It cannot be posted in the offending conversation at all: an app
cannot join two people's DM. That is a Slack limit, but it is also the better
shape, since a policy notice in front of a minor is the one message here
guaranteed to frighten somebody. Keep the tone a colleague's; an adult who feels
accused moves the conversation somewhere nobody can see it.

**But a verdict can change with nobody saying anything** — screening lapses, a
participant moves into the students group. That is what `reevaluateRecorded` in
the sweep is for: re-classify stored conversations from stored membership and
today's roles, anchored to the newest message on record. Without it, tying
alerts to messages would buy the recurrence fix at the price of a quiet
conversation going unreported, which is the same bug wearing a different hat.

**What the sweep may close on its own** is the `SWEEP_OWNED` list in
`jobs/sweep.ts`. Four kinds are deliberately absent: `adult_student_dm`,
`student_enrolled`, `roster_drift`, and `usergroup_conflict`. Each records
something that happened rather than a condition that is currently true —
removing a token does not un-expose the DMs it saw — so a person closes them.

**A 1:1 can be auto-acknowledged, never auto-resolved.** §4.1's own remedy is
moving to a channel or adding a second adult, so `monitor/remediation.ts` watches
for a compliant group conversation carrying the same people forward.

**Both sides of that comparison are message times, and both had to be.**
`domain/rules/remediation.ts` requires the group's **last message** to be newer
than the finding's **most recent** 1:1 message (`last_seen_at`, not
`first_seen_at`). Neither half is arbitrary:

- Anchoring the finding on its _first_ occurrence would let the group that
  answered January's 1:1 also answer March's.
- Anchoring the group on its _creation_ rejects the ordinary remedy outright —
  teams have standing group chats, and carrying the conversation into one
  creates nothing. This was a real bug, found in testing: an existing group used
  24 seconds after the 1:1 was refused because the group was three hours old.

Activity after the fact is the only thing that separates a genuine remedy from an
old thread being used to launder a fresh violation. Acknowledged, not resolved:
the 1:1 still happened.

**Two paths reach the same log.** Events (`src/slack/events.ts`) give real-time
capture; the hourly backfill (`src/monitor/backfill.ts`) re-walks each adult's
DM list to catch history predating enrollment and anything missed while the
process was down. `UNIQUE (conversation_id, ts)` is what keeps the two from
double-counting — both adults in a group DM also deliver the same event twice.

**Screening has three required items on different clocks** (`rules/screening.ts`):
Youth Protection Screening (4 years), Youth Protection Training (1 year), and
CORI + fingerprints (3 years, state law). Mentor Ready is reported as
outstanding but is **never blocking** — FIRST encourages it rather than
requiring it, and gating on it would flag adults who have done everything
actually asked of them. Mind the column names: `ypp_completed_on` holds the
_screening_, `ypt_completed_on` holds the _training_, and they run on different
clocks. Reading `ypp` as "the annual one" shortens a four-year window to one and
flags adults who are perfectly current.

## Container

Single self-hosted container, built the same way as hawk-shop: multi-stage,
Debian (not Alpine) so better-sqlite3's glibc prebuilds work as shipped, and
`npm ci --ignore-scripts` so npm does not run `node-gyp rebuild` and compile
from source what is already in the tarball. Unlike hawk-shop there is no
bundler, so the runtime stage copies a production `node_modules` alongside
`dist/`. `migrations/` must ship too — `src/db/client.ts` walks up from the
module to find it, which is why it works from both `src/` and `dist/src/`.

Deployment is a single host behind a reverse proxy on the shared external `edge`
network; the app publishes no ports. It must be reachable from the public
internet, because Slack posts events to it. `docs/deploy.md` has the details, and
`./scripts/setup-local.sh` walks a full local run end to end.

`/health` (a Bolt `customRoutes` entry, `src/health.ts`) touches SQLite so an
unwritable or unmigrated volume surfaces as unhealthy rather than as DMs nobody
recorded. `installed: false` is healthy — a fresh container is legitimately
waiting to be installed.

Building locally on macOS can trip the "access data from other apps" prompt;
`docs/deploy.md` has the `DOCKER_CONFIG` workaround.

## Rules that are load-bearing

- **Never log message text.** `src/logger.ts` says so; keep it true. Content
  belongs in the database, which is access-controlled; logs are not. Logs go to
  stderr at every level so the CLI can own stdout.
- **Alerts name people and conversations, never content.** The alert channel is
  a place to be told something needs a look.
- **Coverage gaps are findings, not silence.** An adult who has not enrolled, or
  who revoked, produces a violation. Anything that would make hawk-mod quieter
  by making it blinder is a bug.
- **`LOG_MODE=metadata` must stay a working mode.** Every policy violation is
  detectable without message text; only investigation needs the text.
- Non-students with no screening on file do not count toward the two-adult rule,
  whatever their role. Do not loosen `isScreenedAdult`.
- **Every Slack entry point is gated on `mayAdministerWorkspace`**, and each one
  checks for itself: the slash command (`commands.ts`), the alert buttons and
  their note modal (`actions.ts`), and the screening and consent submissions
  (`modals.ts`). There is no middleware doing this centrally — anyone who can
  see the alert channel can click a button, so a new handler that forgets the
  check is open to the workspace. Findings name students.
- **Files are recorded as metadata, never fetched.** `record.ts` stores
  `{id, name, mimetype, size}` and the bytes stay in Slack. That an image was
  shared is the policy-relevant fact; the image itself is a minor's photograph,
  and downloading it would put content in the team's custody that the
  content-blind rules never need. Slack retention is set to keep everything, so
  an investigation that genuinely needs the file gets it from Slack. Do not add
  file download.
