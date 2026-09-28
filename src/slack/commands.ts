import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { APP_NAME } from "../brand.js";
import { closeFinding } from "../close.js";
import { config } from "../config.js";
import {
  countOpenByKind,
  setSetting,
  getFinding,
  getInstallation,
  listFindings,
  listPeople,
  personByEmail,
  personById,
  personBySlackId,
  setPersonActive,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import { severityEmoji } from "../domain/findings.js";
import { requiresEnrollment, type Person } from "../domain/people.js";
import { consentStatus } from "../domain/rules/consent.js";
import {
  describeScreening,
  screeningStatus,
} from "../domain/rules/screening.js";
import { log } from "../logger.js";
import {
  isSettingKey,
  SETTING_KEYS,
  SETTINGS,
  setting,
  settingValue,
} from "../settings.js";
import { describeValue, validateSetting } from "./settingsAdmin.js";
import { backfillAll } from "../monitor/backfill.js";
import { administrator, type Actor, NOT_PERMITTED } from "./authz.js";
import { applyGroupEdit } from "./groupAdmin.js";
import { runSweep } from "../jobs/sweep.js";
import { rescheduleReports } from "../jobs/schedule.js";
import {
  groupsReport,
  lifecyclePlanReport,
  rosterReport,
  rosterSync,
  slackIdsReport,
} from "../lifecycle/run.js";

const HELP = [
  `*${APP_NAME}*`,
  "`/hawkmod status` — enrollment coverage and open findings",
  "`/hawkmod enroll` — link for a adult to authorize monitoring",
  "`/hawkmod findings [kind]` — open findings",
  "`/hawkmod whois @user` — role, consent, screening, enrollment",
  "`/hawkmod group add @user @group` — put someone in a user group",
  "`/hawkmod group remove @user @group` — take someone out of a user group",
  "`/hawkmod deactivate @user <reason>` — stop monitoring someone",
  "`/hawkmod config` — show settings; `config set <key> <value>` to change one",
  "`/hawkmod ack <id> <note>` — acknowledge without closing",
  "`/hawkmod resolve <id> <note>` — close a finding, with a reason",
  "`/hawkmod sweep` — run the compliance sweep now",
  "`/hawkmod backfill` — walk enrolled adults' DM history now",
  "`/hawkmod lifecycle plan` — read the lifecycle sheet; changes nothing",
  "`/hawkmod lifecycle slack-ids` — which Slack User IDs the sheet is missing; add `apply` to fill them in",
  "`/hawkmod lifecycle roster` — what building the roster from the sheet would change; add `apply` to make the changes",
  "`/hawkmod lifecycle sync` — read the sheet now and update the roster (it also runs hourly)",
  "`/hawkmod lifecycle groups` — the Google Groups against the sheet; add `apply` to add everyone the sheet puts in them (then hourly)",
  "",
  "_Who is a student or a mentor, their screening dates and their consent all",
  "come from the lifecycle sheet. To change them, edit the sheet, then",
  "`/hawkmod lifecycle sync` — or wait for the hourly run._",
].join("\n");

export function registerCommands(app: App): void {
  app.command("/hawkmod", async ({ command, ack, respond, client }) => {
    await ack();

    // Findings name students and describe conduct concerns. Only the people
    // Slack already trusts to run the workspace get to read them.
    const caller = await administrator(client, command.user_id);
    if (!caller) {
      await respond({ response_type: "ephemeral", text: NOT_PERMITTED });
      return;
    }

    const [sub = "help", ...rest] = command.text.trim().split(/\s+/);
    const teamId = command.team_id;

    try {
      switch (sub) {
        case "status":
          await respond({
            response_type: "ephemeral",
            text: statusText(teamId),
          });
          return;

        case "enroll":
          await respond({
            response_type: "ephemeral",
            text:
              `Send this to each adult: ${config().PUBLIC_URL}/slack/install\n` +
              "They must be signed in to this workspace, and the authorization " +
              `screen will name the DM scopes ${APP_NAME} is asking for.`,
          });
          return;

        case "findings":
          await respond({
            response_type: "ephemeral",
            text: findingsText(rest[0]),
          });
          return;

        case "screening":
        case "consent":
          // Retired at the cutover: a date typed here would be overwritten by
          // the next hourly run, which copies the sheet exactly.
          await respond({
            response_type: "ephemeral",
            text:
              `${sub === "screening" ? "Screening dates" : "Consent"} now ` +
              "come from the lifecycle sheet: edit the sheet, then " +
              "`/hawkmod lifecycle sync`.",
          });
          return;

        case "whois":
          await respond({
            response_type: "ephemeral",
            text: await whoisText(client, teamId, rest.join(" ")),
          });
          return;

        case "ack":
        case "resolve": {
          const id = Number(rest[0]);
          const note = rest.slice(1).join(" ").trim();
          if (!Number.isInteger(id) || !note) {
            await respond({
              response_type: "ephemeral",
              text: `Usage: \`/hawkmod ${sub} <id> <note>\` — the note is required.`,
            });
            return;
          }
          if (!getFinding(id)) {
            await respond({
              response_type: "ephemeral",
              text: `No finding #${id}.`,
            });
            return;
          }
          await closeFinding(
            id,
            caller.name,
            note,
            sub === "ack" ? "acknowledged" : "resolved"
          );
          await respond({
            response_type: "ephemeral",
            text: `Finding #${id} ${sub === "ack" ? "acknowledged" : "resolved"}.`,
          });
          return;
        }

        case "config": {
          await respond({
            response_type: "ephemeral",
            text: await configText(client, caller, rest),
          });
          return;
        }

        case "group": {
          await respond({
            response_type: "ephemeral",
            text: await groupText(client, teamId, caller, rest),
          });
          return;
        }

        case "deactivate": {
          await respond({
            response_type: "ephemeral",
            text: await deactivateText(client, caller, rest),
          });
          return;
        }

        case "sync": {
          // The old spelling of "re-read who is who", kept so the habit works.
          await respond({
            response_type: "ephemeral",
            text: "Reading the lifecycle sheet…",
          });
          await respond({
            response_type: "ephemeral",
            text:
              "```" +
              (await rosterSync({ slack: client, by: caller.name })) +
              "```",
          });
          return;
        }

        case "sweep": {
          await respond({ response_type: "ephemeral", text: "Sweeping…" });
          const stats = await runSweep();
          await respond({
            response_type: "ephemeral",
            text: "```" + JSON.stringify(stats, null, 2) + "```",
          });
          return;
        }

        case "backfill": {
          await respond({
            response_type: "ephemeral",
            text: "Backfilling DM history; this can take a while.",
          });
          const stats = await backfillAll();
          await respond({
            response_type: "ephemeral",
            text: "```" + JSON.stringify(stats, null, 2) + "```",
          });
          return;
        }

        case "lifecycle": {
          const [what, flag] = rest;
          if (
            what !== "plan" &&
            what !== "slack-ids" &&
            what !== "roster" &&
            what !== "sync" &&
            what !== "groups"
          ) {
            await respond({
              response_type: "ephemeral",
              text:
                "Usage: `/hawkmod lifecycle plan`, " +
                "`/hawkmod lifecycle slack-ids [apply]` or " +
                "`/hawkmod lifecycle roster [apply]`, " +
                "`/hawkmod lifecycle sync` or `/hawkmod lifecycle groups [apply]`",
            });
            return;
          }
          await respond({
            response_type: "ephemeral",
            text: "Reading the lifecycle sheet…",
          });
          const report =
            what === "plan"
              ? await lifecyclePlanReport()
              : what === "groups"
                ? await groupsReport({
                    apply: flag === "apply",
                    applyHint: "/hawkmod lifecycle groups apply",
                    actor: {
                      slackUserId: caller.slackUserId,
                      name: caller.name,
                    },
                  })
                : what === "sync"
                  ? await rosterSync({ slack: client, by: caller.name })
                  : what === "roster"
                    ? await rosterReport({
                        slack: client,
                        apply: flag === "apply",
                        applyHint: "/hawkmod lifecycle roster apply",
                        by: caller.name,
                      })
                    : await slackIdsReport({
                        slack: client,
                        apply: flag === "apply",
                        applyHint: "/hawkmod lifecycle slack-ids apply",
                        by: caller.name,
                      });
          await respond({
            response_type: "ephemeral",
            text: "```" + report + "```",
          });
          return;
        }

        default:
          await respond({ response_type: "ephemeral", text: HELP });
      }
    } catch (err) {
      log.error("command failed", { sub, error: String(err) });
      await respond({
        response_type: "ephemeral",
        text: `That failed: ${String(err)}`,
      });
    }
  });
}

function statusText(teamId: string): string {
  const people = listPeople(true);
  const needEnrollment = people.filter(requiresEnrollment);
  const enrolled = needEnrollment.filter(
    (p) =>
      p.slack_user_id &&
      !getInstallation(teamId, "user", p.slack_user_id)?.revokedAt &&
      getInstallation(teamId, "user", p.slack_user_id)
  );
  const open = countOpenByKind();
  const openTotal = Object.values(open).reduce((a, b) => a + b, 0);

  return [
    `*Coverage:* ${enrolled.length}/${needEnrollment.length} adults enrolled.`,
    needEnrollment.length !== enrolled.length
      ? `_Unenrolled adults' DMs are invisible to ${APP_NAME}._`
      : "_Every adult on the roster is enrolled._",
    `*Roster:* ${people.filter((p) => p.role === "student").length} students, ` +
      `${people.length - people.filter((p) => p.role === "student").length} adults.`,
    `*Open findings:* ${openTotal}` +
      (openTotal
        ? "\n" +
          Object.entries(open)
            .map(([kind, n]) => `  • ${kind}: ${n}`)
            .join("\n")
        : ""),
  ].join("\n");
}

function findingsText(kind?: string): string {
  const open = listFindings("open").filter((f) => !kind || f.kind === kind);
  if (open.length === 0) return "No open findings.";
  return open
    .slice(0, 25)
    .map(
      (f) =>
        `${severityEmoji(f.severity)} *#${f.id}* \`${f.kind}\` — ${f.summary} ` +
        `_(first seen ${f.first_seen_at.slice(0, 10)})_`
    )
    .join("\n");
}

/**
 * Resolves whoever the caller meant. With `should_escape: true` Slack sends
 * `<@U123|handle>` and the first branch is the whole story; the rest exist
 * because an app configured without escaping sends the raw text the user
 * typed, which may be a handle or a display name with a space in it.
 */
async function resolvePerson(
  client: WebClient,
  mention: string
): Promise<Person | undefined> {
  const raw = mention.trim();
  if (!raw) return undefined;

  const escaped = raw.match(/^<@([A-Z0-9]+)/i)?.[1];
  if (escaped) return personBySlackId(escaped.toUpperCase());

  if (/^U[A-Z0-9]{4,}$/i.test(raw)) return personBySlackId(raw.toUpperCase());

  if (raw.includes("@") && raw.includes(".")) {
    const byEmail = personByEmail(raw.replace(/^@/, ""));
    if (byEmail) return byEmail;
  }

  const wanted = raw.replace(/^@/, "").toLowerCase();
  try {
    const list = await client.users.list({ limit: 500 });
    const match = (list.members ?? []).find((m) =>
      [m.name, m.profile?.display_name, m.profile?.real_name]
        .filter(Boolean)
        .some((n) => (n as string).toLowerCase() === wanted)
    );
    if (match?.id) return personBySlackId(match.id);
  } catch {
    // fall through to "not found"
  }
  return undefined;
}

/**
 * Resolves a Slack account, roster row or not.
 *
 * `resolvePerson` answers "who is this on the roster", which is the right
 * question almost everywhere and the wrong one for group edits: joining a role
 * user group is *how* somebody gets a roster row, so demanding one first is a
 * deadlock. This answers the smaller question — which Slack account did they
 * mean — so the edit can proceed and the sync can create the row from it.
 */
async function resolveSlackId(
  client: WebClient,
  mention: string
): Promise<string | undefined> {
  const raw = mention.trim();
  if (!raw) return undefined;

  const escaped = raw.match(/^<@([A-Z0-9]+)/i)?.[1];
  if (escaped) return escaped.toUpperCase();
  if (/^U[A-Z0-9]{4,}$/i.test(raw)) return raw.toUpperCase();

  const wanted = raw.replace(/^@/, "").toLowerCase();
  try {
    const list = await client.users.list({ limit: 500 });
    const match = (list.members ?? []).find(
      (m) =>
        !m.deleted &&
        !m.is_bot &&
        [m.name, m.profile?.display_name, m.profile?.real_name]
          .filter(Boolean)
          .some((n) => (n as string).toLowerCase() === wanted)
    );
    return match?.id;
  } catch {
    return undefined;
  }
}

async function whoisText(
  client: WebClient,
  teamId: string,
  mention: string
): Promise<string> {
  const person = await resolvePerson(client, mention);
  if (!person) return `No roster entry for \`${mention}\`.`;

  const asOf = today();
  const lines = [
    `*${person.full_name}* — ${person.role}, ${person.active ? "active" : "inactive"}`,
    `Person ID: ${person.person_id ?? "not matched to the lifecycle sheet"}`,
    `Email: ${person.email ?? "none on the lifecycle sheet"}`,
  ];

  if (person.role === "student") {
    const consent = consentStatus(person, asOf);
    lines.push(
      `Consent: ${consent.state}` +
        ("expiresOn" in consent
          ? ` (Slack Consent Expiry ${consent.expiresOn})`
          : "")
    );
  } else {
    const s = screeningStatus(person, asOf);
    lines.push(`Screening: ${describeScreening(s)}`);
    if (s.optionalOutstanding.length) {
      lines.push(
        `Reported only, outstanding: ${s.optionalOutstanding.join(", ")}`
      );
    }
  }

  if (requiresEnrollment(person) && person.slack_user_id) {
    const install = getInstallation(teamId, "user", person.slack_user_id);
    lines.push(
      `Enrollment: ${
        !install
          ? "never authorized"
          : install.revokedAt
            ? `revoked ${install.revokedAt.slice(0, 10)}`
            : `active since ${install.installedAt.slice(0, 10)}`
      }`
    );
  }

  return lines.join("\n");
}

/**
 * Pulls the group out of a mention. With link escaping on, Slack sends a user
 * group as `<!subteam^S123|students>`; with it off, the raw `@students`. Both
 * reach `resolveGroup`, which accepts an id or a handle.
 */
function groupRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const escaped = trimmed.match(/^<!subteam\^([A-Z0-9]+)/i)?.[1];
  if (escaped) return escaped.toUpperCase();
  return trimmed.replace(/^@/, "");
}

/**
 * `/hawkmod group add|remove @user @group`.
 *
 * Moving a student into the mentors group requires a written reason. Refusing it
 * outright would be worse than allowing it: the action would simply happen in
 * Slack's own UI instead, where hawk-mod learns of it from an event carrying no
 * reason and no author. Requiring a sentence keeps the most consequential edit
 * on the path that records the most about it — and no one fat-fingers a
 * sentence, so it also kills the typo case.
 */
async function groupText(
  client: WebClient,
  teamId: string,
  caller: Actor,
  rest: string[]
): Promise<string> {
  const [action, mention, group, ...reasonWords] = rest;
  if (action !== "add" && action !== "remove") {
    return "Usage: `/hawkmod group add|remove @user @group`.";
  }
  const ref = groupRef(group ?? "");
  if (!mention || !ref) {
    return `Usage: \`/hawkmod group ${action} @user @group\`.`;
  }

  // A roster row is not a precondition here: a group is for mentions and
  // channel access, and says nothing about who is monitored — the lifecycle
  // sheet does. Slack's account is enough.
  const person = await resolvePerson(client, mention);
  const slackId =
    person?.slack_user_id ?? (await resolveSlackId(client, mention));
  if (!slackId) {
    return (
      `Couldn't work out who \`${mention}\` is. Mention them with @ so Slack ` +
      `sends their account, or paste their Slack member ID.`
    );
  }
  const who = person?.full_name ?? `<@${slackId}>`;

  const reason = reasonWords.join(" ").trim();

  const outcome = await applyGroupEdit({
    teamId,
    actor: caller,
    groupRef: ref,
    action,
    subject: person ?? { slackUserId: slackId },
    reason: reason || null,
    source: "command",
  });

  if (!outcome.ok) return outcome.reason;
  if (outcome.noop) {
    return `*${who}* was already ${
      action === "add" ? "in" : "out of"
    } @${outcome.handle}. Nothing changed.`;
  }

  const lines = [
    `${action === "add" ? "Added" : "Removed"} *${who}* ` +
      `${action === "add" ? "to" : "from"} @${outcome.handle}.`,
  ];

  // Said out loud, so nobody assumes a group edit changed who is monitored:
  // the lifecycle sheet decides that, and a group is for mentions and access.
  lines.push(
    person
      ? `_This does not change monitoring: ${person.full_name} is still a ` +
          `${person.role} on the roster. Roles come from the lifecycle sheet._`
      : `_This does not put them on the roster: the lifecycle sheet does that._`
  );
  return lines.join("\n");
}

/**
 * `/hawkmod deactivate @user <reason>` — the only thing here that makes hawk-mod
 * see less, which is why it names a person and demands a reason in the same
 * breath, exactly as `ack` and `resolve` do.
 */
async function deactivateText(
  client: WebClient,
  caller: Actor,
  rest: string[]
): Promise<string> {
  const [mention, ...reasonWords] = rest;
  const reason = reasonWords.join(" ").trim();
  if (!mention || !reason) {
    return (
      "Usage: `/hawkmod deactivate @user <reason>` — the reason is required.\n" +
      "This is the one command that stops hawk-mod watching somebody."
    );
  }

  const person = await resolvePerson(client, mention);
  if (!person) return `No roster entry for \`${mention}\`.`;
  if (person.active !== 1) {
    return `*${person.full_name}* is already deactivated.`;
  }

  setPersonActive({
    personId: person.id,
    active: false,
    source: "command",
    actor: caller.name,
    reason,
  });

  const after = personById(person.id);
  const lines = [
    `*${person.full_name}* is no longer monitored. Recorded against your name, ` +
      `with the reason you gave.`,
  ];
  if (after?.role === "student") {
    lines.push(
      `_This was a student. Their recorded messages are kept; nothing new will ` +
        `be recorded. Adding them back to a role user group resumes monitoring._`
    );
  }
  return lines.join("\n");
}

/**
 * `/hawkmod config` and `/hawkmod config set <key> <value>`.
 *
 * Everything here used to live in a `.env` file on the host, which meant a
 * Slack admin could not change which user group declares students without an
 * SSH session. `authz.ts` already rejected that shape of problem once, for
 * administrative authority; this is the same argument applied to the settings
 * that decide who is monitored.
 *
 * Credentials are deliberately absent, and cannot be added: `SETTINGS` is an
 * allowlist. You cannot configure from Slack the things that let hawk-mod reach
 * Slack, and changing the encryption key would make every stored token
 * undecryptable.
 */
async function configText(
  client: WebClient,
  caller: Actor,
  rest: string[]
): Promise<string> {
  const [verb, key, ...valueWords] = rest;

  if (!verb) return configListing(client);

  if (verb !== "set") {
    return (
      "Usage: `/hawkmod config` to show, " +
      "`/hawkmod config set <key> <value>` to change one."
    );
  }

  if (!key || !isSettingKey(key)) {
    return (
      `Unknown setting \`${key ?? "(none)"}\`. Settable: ` +
      SETTING_KEYS.map((k) => `\`${k}\``).join(", ") +
      ".\nSlack credentials and the encryption key are deliberately not " +
      "settable from here."
    );
  }

  const raw = valueWords.join(" ").trim();
  if (!raw) return `Usage: \`/hawkmod config set ${key} <value>\`.`;

  const cleaned = await validateSetting(client, key, raw);
  if ("error" in cleaned) return cleaned.error;

  const before = setting(key);
  setSetting({
    key,
    value: cleaned.value,
    actor: caller.slackUserId,
    actorName: caller.name,
  });

  const now = await describeValue(client, key, cleaned.value);
  const was = before.value
    ? await describeValue(client, key, before.value)
    : null;

  const lines = [
    `*${SETTINGS[key].label}* is now ${now}` +
      (was ? ` (was ${was}, from ${before.source})` : "") +
      ".",
  ];

  // The new time takes effect now, not at whatever the old time happened to
  // be: leaving it would mean the setting looked applied and was not.
  if (key === "report-time") {
    const next = rescheduleReports();
    if (next) {
      lines.push(
        `_Next daily report: ${next.toLocaleString("en-US", { timeZone: config().TZ })}._`
      );
    }
  }

  return lines.join("\n");
}

async function configListing(client: WebClient): Promise<string> {
  const rows = await Promise.all(
    SETTING_KEYS.map(async (key) => {
      const { value, source } = setting(key);
      const where =
        source === "slack"
          ? "set here"
          : source === "env"
            ? `from ${SETTINGS[key].env}`
            : "*not set*";
      const shown = value ? await describeValue(client, key, value) : "—";
      return `• \`${key}\` — ${shown}  _(${where})_`;
    })
  );

  const unset = SETTING_KEYS.filter((k) => setting(k).source === "unset");

  return [
    "*Settings*",
    ...rows,
    "",
    "`/hawkmod config set <key> <value>`",
    ...(unset.length
      ? ["", ...unset.map((k) => `_\`${k}\` is unset — ${SETTINGS[k].hint}._`)]
      : []),
    "_Slack credentials and the token encryption key stay in the environment " +
      "and cannot be changed from here._",
  ].join("\n");
}
