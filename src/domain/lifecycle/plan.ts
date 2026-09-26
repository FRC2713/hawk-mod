import type { IsoDate } from "../dates.js";
import {
  addresses,
  GROUPS,
  intendedGroups,
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
 * What a lifecycle run would do. In step 0 that is only the sheet's side —
 * who it says belongs where — since nothing yet reads Google Groups or Slack
 * to diff against. Later steps add the changes to this shape; the dry run and
 * the real run will always print the same plan.
 */
export type LifecyclePlan = {
  asOf: IsoDate;
  people: {
    total: number;
    byStatus: Record<SheetStatus, number>;
    byRole: Record<SheetRole, number>;
  };
  groups: { name: GroupName; members: string[] }[];
  /** Active mentors kept out of grp-all-team, and why. By Person ID. */
  notCleared: { personId: string; missing: string[] }[];
  /** Active people who would be in a group but have no address to add. */
  noAddress: string[];
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
  const inAnyGroup = new Set(GROUPS.flatMap((g) => intended[g]));

  return {
    asOf,
    people: { total: parsed.people.length, byStatus, byRole },
    groups: GROUPS.map((name) => ({
      name,
      members: addresses(intended[name]),
    })),
    notCleared: intended["grp-mentors"]
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
    problems: parsed.problems,
  };
}
