import type { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import {
  createPersonFromSlack,
  peopleBySlackId,
  personBySlackId,
  setPersonRole,
} from "../db/repo.js";
import { dedupeKey } from "../domain/findings.js";
import { reconcileRoles } from "../domain/rules/rosterSync.js";
import { log } from "../logger.js";
import { raise } from "../raise.js";
import { fetchProfiles, resolveGroup } from "../slack/userGroups.js";

export type RoleSyncStats = {
  enabled: boolean;
  studentsInGroup: number;
  adultsInGroup: number;
  created: number;
  changed: number;
  conflicts: number;
  reducedProtection: number;
};

const SOURCE = "usergroup_sync";

/**
 * Pulls role declarations from Slack user groups into the roster.
 *
 * Membership is only ever *added*. Dropping someone from the students group
 * does not un-student them — that would silently end their monitoring, which is
 * the failure this whole system exists to prevent. Moving out of `student`
 * requires putting them in the adults group, which is deliberate, and is
 * reported as a finding either way.
 *
 * Group editing is restricted to Workspace Admins in the workspace settings.
 * That is not readable through any API, so it lives on the manual §6 checklist
 * alongside retention and huddles.
 */
export async function syncRolesFromUserGroups(
  client: WebClient
): Promise<RoleSyncStats> {
  const cfg = config();
  const stats: RoleSyncStats = {
    enabled: false,
    studentsInGroup: 0,
    adultsInGroup: 0,
    created: 0,
    changed: 0,
    conflicts: 0,
    reducedProtection: 0,
  };

  if (!cfg.STUDENT_USERGROUP && !cfg.ADULT_USERGROUP) return stats;
  stats.enabled = true;

  const studentGroup = cfg.STUDENT_USERGROUP
    ? await resolveGroup(client, cfg.STUDENT_USERGROUP)
    : null;
  const adultGroup = cfg.ADULT_USERGROUP
    ? await resolveGroup(client, cfg.ADULT_USERGROUP)
    : null;

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

      case "change": {
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
