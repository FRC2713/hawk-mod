import type { WebClient } from "@slack/web-api";
import {
  createPersonFromSlack,
  peopleBySlackId,
  personBySlackId,
  setPersonActive,
  setPersonRole,
} from "../db/repo.js";
import { dedupeKey } from "../domain/findings.js";
import { reconcileRoles } from "../domain/rules/rosterSync.js";
import { log } from "../logger.js";
import { settingValue } from "../settings.js";
import { raise } from "../raise.js";
import { fetchProfiles, resolveGroup } from "../slack/userGroups.js";

export type RoleSyncStats = {
  enabled: boolean;
  studentsInGroup: number;
  adultsInGroup: number;
  created: number;
  changed: number;
  reactivated: number;
  conflicts: number;
  reducedProtection: number;
  missingGroups: number;
};

const SOURCE = "usergroup_sync";

/**
 * Pulls role declarations from Slack user groups into the roster.
 *
 * Monitoring is only ever *added*. Dropping someone from the students group
 * does not un-student them — that would silently end their monitoring, which is
 * the failure this whole system exists to prevent. Moving out of `student`
 * requires putting them in the adults group, which is deliberate, and is
 * reported as a finding either way. Ending monitoring altogether is
 * `/hawkmod deactivate`, which names a person and demands a reason.
 *
 * The same asymmetry runs the other way: a deactivated person who reappears in
 * a group is reactivated here without ceremony, because gaining protection back
 * never needs approval.
 *
 * Group editing is restricted to Workspace Admins in the workspace settings.
 * That is not readable through any API, so it stays on the manual §6 checklist
 * alongside retention and huddles — and it is precisely why `slack/groupAdmin.ts`
 * edits groups with an administrator's own token rather than the bot's.
 */
export async function syncRolesFromUserGroups(
  client: WebClient
): Promise<RoleSyncStats> {
  // From Slack if an admin has set it, from the environment otherwise.
  const studentHandle = settingValue("student-group");
  const adultHandle = settingValue("mentor-group");
  const stats: RoleSyncStats = {
    enabled: false,
    studentsInGroup: 0,
    adultsInGroup: 0,
    created: 0,
    changed: 0,
    reactivated: 0,
    conflicts: 0,
    reducedProtection: 0,
    missingGroups: 0,
  };

  if (!studentHandle && !adultHandle) return stats;
  stats.enabled = true;

  const studentGroup = studentHandle
    ? await resolveGroup(client, studentHandle)
    : null;
  const adultGroup = adultHandle
    ? await resolveGroup(client, adultHandle)
    : null;

  // A configured group that does not exist is a typo, and it reads exactly
  // like an empty group: nobody rostered, nothing monitored, no complaint.
  // Being quieter by being blinder is the failure this project must not have.
  for (const [handle, group] of [
    [studentHandle, studentGroup],
    [adultHandle, adultGroup],
  ] as const) {
    if (!handle || group) continue;
    stats.missingGroups += 1;
    await raise({
      kind: "workspace_config",
      dedupeKey: dedupeKey("workspace_config", "usergroup_missing", handle),
      severity: "violation",
      summary:
        `Configured user group @${handle} does not exist in this workspace. ` +
        `Nobody is being rostered from it, so nobody is being monitored ` +
        `through it either. Fix it with \`/hawkmod config\`.`,
      subjectRef: handle,
    });
  }

  stats.studentsInGroup = studentGroup?.members.size ?? 0;
  stats.adultsInGroup = adultGroup?.members.size ?? 0;

  const decisions = reconcileRoles(peopleBySlackId(), {
    students: studentGroup?.members ?? new Set<string>(),
    adults: adultGroup?.members ?? new Set<string>(),
  });

  // Only group members with no roster row need a profile lookup.
  const needProfiles = decisions
    .filter((d) => d.kind === "create")
    .map((d) => d.slackId);
  const profiles = needProfiles.length
    ? await fetchProfiles(client, needProfiles)
    : new Map();

  for (const decision of decisions) {
    switch (decision.kind) {
      case "unchanged":
        break;

      case "create": {
        const profile = profiles.get(decision.slackId);
        createPersonFromSlack({
          slackUserId: decision.slackId,
          email: profile?.email ?? null,
          fullName: profile?.fullName ?? decision.slackId,
          role: decision.role,
          source: SOURCE,
        });
        stats.created += 1;
        log.info("roster row created from user group", {
          user: decision.slackId,
          role: decision.role,
        });
        break;
      }

      case "reactivate": {
        // Declared again after being deactivated. Monitoring resumes without
        // anyone's approval, for the same reason `create` needs none: this
        // direction only ever adds protection.
        setPersonActive({
          personId: decision.personId,
          active: true,
          source: SOURCE,
          actor: SOURCE,
          reason: "declared by a Slack user group",
        });
        stats.reactivated += 1;
        log.info("monitoring resumed from user group", {
          user: decision.slackId,
          role: decision.role,
        });
        break;
      }

      case "change": {
        if (decision.reactivates) {
          setPersonActive({
            personId: decision.personId,
            active: true,
            source: SOURCE,
            actor: SOURCE,
            reason: "declared by a Slack user group",
          });
          stats.reactivated += 1;
        }
        setPersonRole({
          personId: decision.personId,
          toRole: decision.to,
          source: SOURCE,
          detail: { from: decision.from, to: decision.to },
        });
        stats.changed += 1;
        if (decision.reducesProtection) {
          stats.reducedProtection += 1;
          const person = personBySlackId(decision.slackId);
          await raise({
            kind: "roster_drift",
            dedupeKey: dedupeKey(
              "roster_drift",
              decision.slackId,
              decision.from,
              decision.to
            ),
            severity: "warn",
            summary:
              `${person?.full_name ?? `<@${decision.slackId}>`} moved from ` +
              `${decision.from} to ${decision.to} via Slack user groups — ` +
              `their DMs are no longer monitored as a student's.`,
            subjectPersonId: decision.personId,
            subjectRef: decision.slackId,
            detail: { from: decision.from, to: decision.to, source: SOURCE },
          });
        }
        break;
      }

      case "conflict": {
        stats.conflicts += 1;
        await raise({
          kind: "usergroup_conflict",
          dedupeKey: dedupeKey("usergroup_conflict", decision.slackId),
          severity: "violation",
          summary:
            `<@${decision.slackId}> is in both the students and the adults ` +
            `user group. Roster left unchanged until that is resolved.`,
          subjectPersonId: decision.personId,
          subjectRef: decision.slackId,
        });
        break;
      }
    }
  }

  log.info("user group role sync complete", { ...stats });
  return stats;
}
