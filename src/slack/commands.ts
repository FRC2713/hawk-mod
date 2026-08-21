import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { APP_NAME } from "../brand.js";
import { closeFinding } from "../close.js";
import { config } from "../config.js";
import {
  countOpenByKind,
  getFinding,
  getInstallation,
  listConsents,
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
import { screeningStatus } from "../domain/rules/screening.js";
import { log } from "../logger.js";
import { backfillAll } from "../monitor/backfill.js";
import { administrator, type Actor, NOT_PERMITTED } from "./authz.js";
import { applyGroupEdit } from "./groupAdmin.js";
import { openConsent, openScreening } from "./modals.js";
import { runSweep } from "../jobs/sweep.js";
import { syncRolesFromUserGroups } from "../jobs/syncRoles.js";

const HELP = [
  `*${APP_NAME}*`,
  "`/hawkmod status` — enrollment coverage and open findings",
  "`/hawkmod enroll` — link for a adult to authorize monitoring",
  "`/hawkmod findings [kind]` — open findings",
  "`/hawkmod whois @user` — role, consent, screening, enrollment",
  "`/hawkmod group add @user @group` — put someone in a user group",
  "`/hawkmod group remove @user @group` — take someone out of a user group",
  "`/hawkmod deactivate @user <reason>` — stop monitoring someone",
  "`/hawkmod screening @user` — record YPP / Mentor Ready / CORI dates",
  "`/hawkmod consent @user` — record a signed parental consent",
  "`/hawkmod ack <id> <note>` — acknowledge without closing",
  "`/hawkmod resolve <id> <note>` — close a finding, with a reason",
  "`/hawkmod sweep` — run the compliance sweep now",
  "`/hawkmod sync` — re-read the user groups now",
  "`/hawkmod backfill` — walk enrolled adults' DM history now",
  "",
  "_Roles come from Slack user groups. To add someone to the roster, add them",
  "to the students or adults group — it applies straight away._",
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
        case "consent": {
          // Join the rest: an unescaped display name arrives with spaces.
          const person = await resolvePerson(client, rest.join(" "));
          if (!person) {
            await respond({
              response_type: "ephemeral",
              text:
                `Couldn't find \`${rest.join(" ") || "(nobody)"}\` on the roster.\n` +
                `Usage: \`/hawkmod ${sub} @user\`. Roster membership comes from ` +
                `the user groups, so add them to @${config().STUDENT_USERGROUP ?? "students"} ` +
                `or @${config().ADULT_USERGROUP ?? "adults"} first.`,
            });
            return;
          }
          if (sub === "screening") {
            await openScreening(client, command.trigger_id, person);
          } else {
            await openConsent(client, command.trigger_id, person);
          }
          return;
        }

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
          const stats = await syncRolesFromUserGroups(client);
          await respond({
            response_type: "ephemeral",
            text: stats.enabled
              ? "```" + JSON.stringify(stats, null, 2) + "```"
              : "No user groups configured; the roster comes from CSV import.",
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
    `Email: ${person.email}`,
  ];

  if (person.role === "student") {
    lines.push(`Consent: ${consentStatus(person, listConsents(), asOf).state}`);
  } else {
    const s = screeningStatus(person, asOf);
    lines.push(
      `Screening: ${
        s.current
          ? "current"
          : `${s.missing.join(", ")}${s.missing.length && s.expired.length ? "; " : ""}${s.expired
              .map((e) => `${e.item} expired ${e.expiredOn}`)
              .join(", ")}`
      }`
    );
    if (s.optionalOutstanding.length) {
      lines.push(`Optional, outstanding: ${s.optionalOutstanding.join(", ")}`);
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
 * Moving a student into the adults group requires a written reason. Refusing it
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

  const person = await resolvePerson(client, mention);
  if (!person) {
    return (
      `Couldn't find \`${mention}\` on the roster. hawk-mod only edits groups ` +
      `for people it already knows, so the edit is never the first thing it ` +
      `learns about someone.`
    );
  }

  const reason = reasonWords.join(" ").trim();

  const outcome = await applyGroupEdit({
    teamId,
    actor: caller,
    groupRef: ref,
    action,
    subject: person,
    reason: reason || null,
    source: "command",
  });

  if (!outcome.ok) {
    // The group's handle is only known once it has been resolved, so the
    // needs-a-reason refusal comes back from there and is dressed up here,
    // where the caller's own words are still to hand.
    if ("needsReason" in outcome) {
      return (
        `*${person.full_name}* is a student. ${outcome.reason}\n` +
        `\`/hawkmod group add ${mention} ${group} <why>\``
      );
    }
    return outcome.reason;
  }
  if (outcome.noop) {
    return `*${person.full_name}* was already ${
      action === "add" ? "in" : "out of"
    } @${outcome.handle}. Nothing changed.`;
  }

  const lines = [
    `${action === "add" ? "Added" : "Removed"} *${person.full_name}* ` +
      `${action === "add" ? "to" : "from"} @${outcome.handle}.`,
  ];

  // The honest half. Group membership declares a role; it does not end
  // monitoring, and saying otherwise here would be the quiet failure this
  // project exists to avoid.
  if (action === "remove") {
    lines.push(
      `_${person.full_name} is still a ${person.role} on the roster and still ` +
        `monitored. Leaving a group never ends monitoring — use ` +
        `\`/hawkmod deactivate\` for that._`
    );
  }
  if (outcome.reducedMonitoring) {
    lines.push(
      `_${person.full_name} is no longer monitored as a student. Recorded ` +
        `against your name: ${reason}_`
    );
  }
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
