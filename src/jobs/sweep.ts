import {
  autoResolveMissing,
  deleteInstallation,
  finishAuditRun,
  getInstallation,
  listConsents,
  listPeople,
  startAuditRun,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import {
  dedupeKey,
  type FindingKind,
  type NewFinding,
} from "../domain/findings.js";
import { requiresEnrollment } from "../domain/people.js";
import { consentStatus, mayHoldAccount } from "../domain/rules/consent.js";
import { screeningStatus } from "../domain/rules/screening.js";
import { evaluateTwoAdultRule } from "../domain/rules/twoAdults.js";
import { log } from "../logger.js";
import { raise } from "../raise.js";
import { channelMemberships, syncSlackAccounts } from "../slack/roster.js";
import { syncRolesFromUserGroups } from "./syncRoles.js";
import { botClient, revokeUserToken } from "../slack/tokens.js";

/** Kinds this sweep owns end to end, and may therefore close on its own. */
const SWEEP_OWNED: FindingKind[] = [
  "unknown_account",
  "unconsented_account",
  "screening_lapsed",
  "adult_not_enrolled",
  "enrollment_revoked",
  "lone_adult_channel",
  "workspace_config",
];
// Deliberately absent above: `student_enrolled` records that a student's peer
// DMs were briefly visible. Removing the token does not un-happen that, so a
// person closes it, not the sweep.

export type SweepStats = {
  rolesFromUserGroups: {
    enabled: boolean;
    created: number;
    changed: number;
    conflicts: number;
  };
  people: number;
  slackAccountsLinked: number;
  unknownAccounts: number;
  unconsentedAccounts: number;
  screeningLapsed: number;
  adultsNotEnrolled: number;
  enrollmentsRevoked: number;
  studentEnrollmentsRemoved: number;
  channelsChecked: number;
  channelsFailingTwoAdults: number;
  findingsClosed: number;
};

export async function runSweep(): Promise<SweepStats> {
  const runId = startAuditRun("sweep");
  const client = botClient();
  const asOf = today();
  const seen = new Set<string>();
  const stats: SweepStats = {
    rolesFromUserGroups: {
      enabled: false,
      created: 0,
      changed: 0,
      conflicts: 0,
    },
    people: 0,
    slackAccountsLinked: 0,
    unknownAccounts: 0,
    unconsentedAccounts: 0,
    screeningLapsed: 0,
    adultsNotEnrolled: 0,
    enrollmentsRevoked: 0,
    studentEnrollmentsRemoved: 0,
    channelsChecked: 0,
    channelsFailingTwoAdults: 0,
    findingsClosed: 0,
  };

  const emit = async (f: NewFinding) => {
    seen.add(f.dedupeKey);
    await raise(f);
  };

  /* ---- roles from Slack user groups ------------------------------------- */

  // Runs first: everything below reads roles, so the roster must reflect the
  // groups before consent, screening, and the two-adult rule are evaluated.
  const roleSync = await syncRolesFromUserGroups(client);

  stats.rolesFromUserGroups = {
    enabled: roleSync.enabled,
    created: roleSync.created,
    changed: roleSync.changed,
    conflicts: roleSync.conflicts,
  };

  /* ---- roster vs Slack -------------------------------------------------- */

  const { sync, users } = await syncSlackAccounts(client);
  stats.slackAccountsLinked = sync.linked;

  const teamId = (await client.auth.test()).team_id as string;
  const botIds = new Set(users.filter((u) => u.isBot).map((u) => u.id));

  for (const u of sync.unknown) {
    stats.unknownAccounts += 1;
    await emit({
      kind: "unknown_account",
      dedupeKey: dedupeKey("unknown_account", u.id),
      severity: "violation",
      summary: `Slack account @${u.name} (${u.email ?? "no email"}) is not on the roster.`,
      subjectRef: u.id,
      detail: { realName: u.realName, isOwner: u.isOwner, isAdmin: u.isAdmin },
    });
  }

  /* ---- consent, screening, enrollment ----------------------------------- */

  const people = listPeople(true);
  const consents = listConsents();
  stats.people = people.length;

  for (const p of people) {
    if (p.role === "student" && p.slack_user_id) {
      const status = consentStatus(p, consents, asOf);
      if (!mayHoldAccount(status)) {
        stats.unconsentedAccounts += 1;
        await emit({
          kind: "unconsented_account",
          dedupeKey: dedupeKey("unconsented_account", String(p.id)),
          severity: "violation",
          summary: `${p.full_name} has a Slack account but consent is ${status.state}.`,
          subjectPersonId: p.id,
          subjectRef: p.slack_user_id,
          detail: { state: status.state },
        });
      }
    }

    if (p.role === "adult" || p.role === "lead_coach") {
      const screening = screeningStatus(p, asOf);
      if (!screening.current) {
        stats.screeningLapsed += 1;
        await emit({
          kind: "screening_lapsed",
          dedupeKey: dedupeKey("screening_lapsed", String(p.id)),
          severity: "warn",
          summary:
            `${p.full_name}: ` +
            [
              screening.missing.length
                ? `missing ${screening.missing.join(", ")}`
                : "",
              screening.expired.length
                ? `expired ${screening.expired.map((e) => `${e.item} (${e.expiredOn})`).join(", ")}`
                : "",
            ]
              .filter(Boolean)
              .join("; "),
          subjectPersonId: p.id,
          detail: screening,
        });
      }
    }

    // Someone can enrol legitimately as a adult and later be moved into the
    // students group. The install-time refusal cannot see the future, so the
    // sweep tears the token down instead of leaving their peer DMs visible.
    if (p.role === "student" && p.slack_user_id) {
      const install = getInstallation(teamId, "user", p.slack_user_id);
      if (install) {
        await revokeUserToken(teamId, p.slack_user_id);
        deleteInstallation(teamId, "user", p.slack_user_id);
        stats.studentEnrollmentsRemoved += 1;
        await emit({
          kind: "student_enrolled",
          dedupeKey: dedupeKey("student_enrolled", String(p.id)),
          severity: "violation",
          summary:
            `${p.full_name} is rostered as a student but had authorized ` +
            `hawk-mod. The token has been revoked and removed — until now it ` +
            `made their DMs with other students visible.`,
          subjectPersonId: p.id,
          subjectRef: p.slack_user_id,
          detail: { installedAt: install.installedAt },
        });
      }
    }

    if (requiresEnrollment(p) && p.slack_user_id) {
      const install = getInstallation(teamId, "user", p.slack_user_id);
      if (!install) {
        stats.adultsNotEnrolled += 1;
        await emit({
          kind: "adult_not_enrolled",
          dedupeKey: dedupeKey("adult_not_enrolled", String(p.id)),
          severity: "violation",
          summary:
            `${p.full_name} has not authorized hawk-mod. Their DMs with students ` +
            `are not monitored by anything.`,
          subjectPersonId: p.id,
          subjectRef: p.slack_user_id,
        });
      } else if (install.revokedAt) {
        stats.enrollmentsRevoked += 1;
        await emit({
          kind: "enrollment_revoked",
          dedupeKey: dedupeKey("enrollment_revoked", String(p.id)),
          severity: "violation",
          summary: `${p.full_name}'s hawk-mod authorization stopped working on ${install.revokedAt.slice(0, 10)}.`,
          subjectPersonId: p.id,
          subjectRef: p.slack_user_id,
        });
      }
    }
  }

  /* ---- two screened adults in every student channel --------------------- */

  const channels = await channelMemberships(client, botIds);
  stats.channelsChecked = channels.length;

  for (const channel of channels) {
    const result = evaluateTwoAdultRule(channel, asOf);
    if (result.ok) continue;
    stats.channelsFailingTwoAdults += 1;
    await emit({
      kind: "lone_adult_channel",
      dedupeKey: dedupeKey("lone_adult_channel", channel.channelId),
      severity: "violation",
      summary: result.summary,
      subjectRef: channel.channelId,
      detail: result,
    });
  }

  /* ---- workspace configuration (§6) ------------------------------------- */

  const owners = users.filter((u) => u.isOwner && !u.isDeleted && !u.isBot);
  if (owners.length < 2) {
    await emit({
      kind: "workspace_config",
      dedupeKey: dedupeKey("workspace_config", "owner_count"),
      severity: "violation",
      summary: `Workspace has ${owners.length} owner(s); at least two screened adults are required.`,
    });
  }

  const rosterBySlackId = new Map(
    people.filter((p) => p.slack_user_id).map((p) => [p.slack_user_id!, p])
  );
  for (const u of users) {
    if (!u.isOwner && !u.isAdmin) continue;
    const person = rosterBySlackId.get(u.id);
    if (person?.role === "student") {
      await emit({
        kind: "workspace_config",
        dedupeKey: dedupeKey("workspace_config", "student_admin", u.id),
        severity: "violation",
        summary: `${person.full_name} is a student and holds workspace ${u.isOwner ? "Owner" : "Admin"}.`,
        subjectPersonId: person.id,
        subjectRef: u.id,
      });
    }
  }

  stats.findingsClosed = autoResolveMissing(SWEEP_OWNED, seen);
  finishAuditRun(runId, stats);
  log.info("sweep complete", { ...stats });
  return stats;
}
