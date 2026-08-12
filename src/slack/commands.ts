import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import {
  countOpenByKind,
  getFinding,
  getInstallation,
  listConsents,
  listFindings,
  listPeople,
  personByEmail,
  personBySlackId,
  resolveFinding,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import { severityEmoji } from "../domain/findings.js";
import {
  mayAdministerWorkspace,
  requiresEnrollment,
  type Person,
} from "../domain/people.js";
import { consentStatus } from "../domain/rules/consent.js";
import { screeningStatus } from "../domain/rules/screening.js";
import { log } from "../logger.js";
import { backfillAll } from "../monitor/backfill.js";
import { openConsent, openScreening } from "./modals.js";
import { runSweep } from "../jobs/sweep.js";
import { syncRolesFromUserGroups } from "../jobs/syncRoles.js";

const HELP = [
  "*hawk-mod*",
  "`/hawkmod status` — enrollment coverage and open findings",
  "`/hawkmod enroll` — link for a adult to authorize monitoring",
  "`/hawkmod findings [kind]` — open findings",
  "`/hawkmod whois @user` — role, consent, screening, enrollment",
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

    // Findings name students and describe conduct concerns. Only the adults
    // responsible for youth protection get to read them.
    const caller = personBySlackId(command.user_id);
    if (!caller || !mayAdministerWorkspace(caller)) {
      await respond({
        response_type: "ephemeral",
        text: "hawk-mod is limited to Lead Coaches and workspace admins.",
      });
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
              "screen will name the DM scopes hawk-mod is asking for.",
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
          resolveFinding(
            id,
            caller.full_name,
            note,
            sub === "ack" ? "acknowledged" : "resolved"
          );
          await respond({
            response_type: "ephemeral",
            text: `Finding #${id} ${sub === "ack" ? "acknowledged" : "resolved"}.`,
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
      ? `_Unenrolled adults' DMs are invisible to hawk-mod._`
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
