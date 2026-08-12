# CLAUDE.md

Guidance for Claude Code working in this repository.

## Commands

```bash
npm run dev            # tsx watch src/index.ts
npm run build          # tsc -> dist/
npm run start          # node dist/src/index.js
npm run typecheck      # tsc --noEmit
npm test               # node:test over src/domain/rules
npm run cli -- <cmd>   # roster/consent import, sweep, backfill, export
npm run format         # prettier
```

`npm run typecheck && npm test && npm run format:check` is the full verification
loop. There is no linter.

## What this is

A Slack app that records adult–student direct messages for youth-protection
audit, because Slack cannot block them below Enterprise Grid. The requirements
come from `obsidian/Areas/FRC/Moving Team Communication to Slack.md`; §4 and §6
are the parts this implements. `docs/policy-mapping.md` maps each control to the
code that carries it.

## Architecture

**Two token planes.** The bot token posts alerts and reads channel membership.
Each adult's _user_ token is what makes DMs visible at all — Slack exposes no
other way below Enterprise Grid. `src/slack/installStore.ts` keeps one `bot` row
per workspace and one `user` row per enrolled adult, and `fetchInstallation`
merges them so an event carries both. Tokens are encrypted at rest
(`src/crypto.ts`); the DB file alone is not enough to read anyone's DMs.

**Everything durable lives under DATA_DIR** — one SQLite file, one volume.
`src/db/client.ts` opens it, sets WAL and `foreign_keys = ON` (SQLite needs the
latter per-connection or the cascades silently do nothing), and applies
`migrations/NNNN_*.sql` in filename order on boot. Never hand-edit a migration
that has shipped.

**The rules are pure and content-blind.** `src/domain/rules/` decides everything
from _who is in a conversation_, never from what was said — `dmPolicy` for DMs,
`twoAdults` for channels, `consent` and `screening` for people. This is why the
tests are cheap and why the policy is enforceable without reading students'
messages. Keep new policy logic here rather than inside Slack handlers.

**Roles can come from Slack user groups.** `syncRolesFromUserGroups` runs first
in the sweep, because everything after it reads roles. The reconciliation in
`domain/rules/rosterSync.ts` is pure and **add-only by design**: a person
dropped from the students group stays a student, since the alternative is
silently ending someone's monitoring. Only an explicit move into the adults
group leaves `student`, and that raises `roster_drift`. Every change lands in
`role_changes` — Slack's audit log API is Grid-only, so that table is the only
trail. Do not make this bidirectional.

**Findings are the output.** `src/raise.ts` is the only path: persist, then
alert, and only alert when the finding is new or has recurred. `dedupe_key` is
the identity of a problem across sweeps — get it wrong and the alert channel
becomes noise nobody reads, which is the exact failure the source document warns
about. The nightly sweep auto-closes findings it no longer detects, except
`adult_student_dm`, which only a human may close.

**Two paths reach the same log.** Events (`src/slack/events.ts`) give real-time
capture; the hourly backfill (`src/monitor/backfill.ts`) re-walks each adult's
DM list to catch history predating enrollment and anything missed while the
process was down. `UNIQUE (conversation_id, ts)` is what keeps the two from
double-counting — both adults in a group DM also deliver the same event twice.

## Container

Single self-hosted container, built the same way as hawk-shop: multi-stage,
Debian (not Alpine) so better-sqlite3's glibc prebuilds work as shipped, and
`npm ci --ignore-scripts` so npm does not run `node-gyp rebuild` and compile
from source what is already in the tarball. Unlike hawk-shop there is no
bundler, so the runtime stage copies a production `node_modules` alongside
`dist/`. `migrations/` must ship too — `src/db/client.ts` walks up from the
module to find it, which is why it works from both `src/` and `dist/src/`.

Deployment is a single Linode host behind a reverse proxy on the shared
external `edge` network; the app publishes no ports. It must be reachable from
the public internet, because Slack posts events to it. `docs/deploy.md` has the
details.

`/health` (a Bolt `customRoutes` entry, `src/health.ts`) touches SQLite so an
unwritable or unmigrated volume surfaces as unhealthy rather than as DMs nobody
recorded. `installed: false` is healthy — a fresh container is legitimately
waiting to be installed.

Building locally on macOS can trip the "access data from other apps" prompt;
`docs/deploy.md` has the `DOCKER_CONFIG` workaround.

## Rules that are load-bearing

- **Never log message text to stdout.** `src/logger.ts` says so; keep it true.
  Content belongs in the database, which is access-controlled; logs are not.
- **Alerts name people and conversations, never content.** The alert channel is
  a place to be told something needs a look.
- **Coverage gaps are findings, not silence.** A adult who has not enrolled, or
  who revoked, produces a violation. Anything that would make hawk-mod quieter
  by making it blinder is a bug.
- **`LOG_MODE=metadata` must stay a working mode.** Every policy violation is
  detectable without message text; only investigation needs the text.
- Non-students with no screening on file do not count toward the two-adult rule,
  whatever their role. Do not loosen `isScreenedAdult`.
