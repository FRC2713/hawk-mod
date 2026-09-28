import type { IsoDate } from "../dates.js";
import {
  addresses,
  GROUPS,
  hasAccess,
  intendedGroups,
  intendedParents,
  PERSON_GROUPS,
  uncleared,
  type GroupName,
} from "./groups.js";
import {
  groupAddress,
  SHEET_ROLES,
  type ParsedSheet,
  type SheetProblem,
  type SheetRole,
  type SheetStatus,
} from "./sheet.js";

/**
 * What the sheet says belongs where, before anything is compared with Google:
 * the `/hawkmod lifecycle plan` dry run. The comparison with actual groups is
 * `groupPlan.ts`.
 */
export type LifecyclePlan = {
  asOf: IsoDate;
  people: {
    total: number;
    byStatus: Record<SheetStatus, number>;
    byRole: Record<SheetRole, number>;
  };
  groups: { name: GroupName; members: string[] }[];
  /**
   * Active mentors who may not have access yet — CORI not current — by
   * Person ID. They join no group and are not invited to Slack.
   */
  noAccess: { personId: string; why: string }[];
  /**
   * Active mentors who are not screened adults, and why. They may still have
   * access; they do not count toward the two-adult rule.
   */
  notCleared: { personId: string; missing: string[] }[];
  /** Active people who would be in a group but have no address to add. */
  noAddress: string[];
  /** Active students with no parent address for grp-parents. */
  noParentEmail: string[];
  problems: SheetProblem[];
};

export function planLifecycle(
  parsed: ParsedSheet,
  asOf: IsoDate
): LifecyclePlan {
  const byStatus: Record<SheetStatus, number> = {
    active: 0,
    inactive: 0,
    unknown: 0,
  };
  const byRole = Object.fromEntries(SHEET_ROLES.map((r) => [r, 0])) as Record<
    SheetRole,
    number
  >;
  for (const p of parsed.people) {
    byStatus[p.status] += 1;
    for (const r of p.roles) byRole[r] += 1;
  }

  const intended = intendedGroups(parsed.people, asOf);
  const parents = intendedParents(parsed.people);
  const inAnyGroup = new Set(PERSON_GROUPS.flatMap((g) => intended[g]));
  const activeMentors = parsed.people.filter(
    (p) => p.status === "active" && p.roles.includes("Mentor")
  );
  const activeStudents = parsed.people.filter(
    (p) => p.status === "active" && p.roles.includes("Student")
  );

  return {
    asOf,
    people: { total: parsed.people.length, byStatus, byRole },
    groups: GROUPS.map((name) => ({
      name,
      members:
        name === "grp-parents"
          ? [...parents.keys()].sort()
          : addresses(intended[name]),
    })),
    noAccess: activeMentors
      .filter((p) => !hasAccess(p, asOf))
      .map((p) => ({
        personId: p.personId,
        why: !p.mentor
          ? "no Mentor_Details row"
          : !p.mentor.coriExpiry
            ? "no CORI Expiry"
            : p.mentor.coriExpiry < asOf
              ? `CORI expired ${p.mentor.coriExpiry}`
              : `CORI Expiry ${p.mentor.coriExpiry} is further out than CORI lasts`,
      })),
    notCleared: activeMentors
      .map((p) => ({
        personId: p.personId,
        // No Mentor_Details row at all is already a problem; it is also,
        // plainly, not cleared.
        missing: p.mentor ? uncleared(p.mentor, asOf) : ["Mentor_Details row"],
      }))
      .filter((m) => m.missing.length > 0),
    noAddress: [...inAnyGroup]
      .filter((p) => groupAddress(p) === null)
      .map((p) => p.personId)
      .sort(),
    noParentEmail: activeStudents
      .filter((p) => p.parentEmails.length === 0)
      .map((p) => p.personId)
      .sort(),
    problems: parsed.problems,
  };
}
