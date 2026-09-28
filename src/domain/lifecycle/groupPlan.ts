import type { IsoDate } from "../dates.js";
import { planGroupMembership } from "../rules/groupMembership.js";
import {
  belongs,
  GROUPS,
  hasAccess,
  intendedGroups,
  intendedParents,
  type GroupName,
  type PersonGroup,
} from "./groups.js";
import { groupAddress, type SheetPerson, type SheetRole } from "./sheet.js";

/**
 * What a run would do to each Google Group: the sheet's intended membership
 * against the group's actual one. Pure — sheet people and member addresses
 * in, a plan out — so every rule below is a test with plain objects.
 *
 * **Joining is automatic; leaving waits for a click** (docs/lifecycle-sync.md,
 * "Groups"). Someone the sheet puts in a group is added. Someone in a group
 * the sheet no longer puts there is *held*: kept where they are, with a reason,
 * for an administrator to remove from a finding. The single exception is a
 * change within the team that takes away a lead or RA flag — someone who stops
 * being a Mentor Lead leaves grp-mentor-leads on the next run — which is
 * `automatic`. An address the sheet does not account for at all is held too
 * (decided 2026-09-28): nothing disappears from a group unasked.
 *
 * The existing refusals sit under all of it: a plan whose automatic removals
 * would empty a group, or take more than a quarter of it, is refused and held
 * for "Apply anyway", because a sheet mistake must not empty a group. Held
 * removals are never applied here, so they never count toward that.
 *
 * Addresses only, compared lower-cased; output names Person IDs alongside
 * them so a report can print the IDs and leave the addresses out.
 */

export type HeldReason =
  | "inactive"
  | "status_unknown"
  /** No longer holds the role the group is for: a graduate, say. */
  | "role_gone"
  /** A mentor whose CORI is not current: `cori_lapsed`. */
  | "no_access"
  /** An address that is nobody's on the sheet. */
  | "not_on_sheet"
  /**
   * Someone's address, but not the one they are added by — a student's
   * school address after they graduate to a personal one is `role_gone`; this
   * is a second address of someone who still belongs, like a student's
   * personal inbox.
   */
  | "other_address"
  /** A parent no Active student lists any more. */
  | "parent_not_listed";

export type Member = {
  address: string;
  /**
   * Whose address this is: the person, or for grp-parents their students —
   * for a held parent, the students who still list them though none is
   * Active, so the parent can go with the student who left.
   */
  personIds: string[];
};

export type HeldMember = Member & { reason: HeldReason };

export type GroupPlanResult = {
  group: GroupName;
  add: Member[];
  /** Removed on their own: a lead or RA flag turned off, nothing else. */
  automatic: Member[];
  /** Kept in the group until an administrator removes them. */
  held: HeldMember[];
  /** Why adds and automatic removals must not be applied, or null. */
  refusal: string | null;
};

const ROLE_FOR: Record<PersonGroup, readonly SheetRole[]> = {
  "grp-mentors": ["Mentor"],
  "grp-mentor-leads": ["Mentor"],
  "grp-ra": ["Mentor"],
  "grp-students": ["Student"],
  "grp-student-leads": ["Student"],
  "grp-volunteers": ["Volunteer"],
  "grp-alumni": ["Alumni"],
  "grp-all-team": ["Mentor", "Student"],
};

/**
 * Why a current member no longer belongs, if it is because they are leaving
 * the group's part of the team; null when it is only a flag turned off.
 */
function leaving(
  group: PersonGroup,
  p: SheetPerson,
  asOf: IsoDate
): HeldReason | null {
  if (p.status === "inactive") return "inactive";
  if (p.status === "unknown") return "status_unknown";
  const roles = ROLE_FOR[group].filter((r) => p.roles.includes(r));
  if (!roles.length) return "role_gone";
  // A mentor's place in a youth-access group rests on CORI; a student's does
  // not. Someone both would already have been refused by the roster.
  if (roles.every((r) => r === "Mentor") && !hasAccess(p, asOf)) {
    return "no_access";
  }
  return null;
}

function refusal(current: Set<string>, desired: Set<string>): string | null {
  const nothingToDo =
    [...desired].every((a) => current.has(a)) &&
    [...current].every((a) => desired.has(a));
  if (nothingToDo) return null;
  if (current.size > 0 && desired.size === 0) {
    return "This would empty the group. Check the lifecycle sheet before applying it.";
  }
  return planGroupMembership(current, desired).refusal;
}

export function planGoogleGroups(args: {
  people: readonly SheetPerson[];
  /** Each group's current members; a group missing here is read as empty. */
  actual: Partial<Record<GroupName, Iterable<string>>>;
  asOf: IsoDate;
}): GroupPlanResult[] {
  const { people, asOf } = args;
  const intended = intendedGroups(people, asOf);
  const parents = intendedParents(people);
  // Every student who lists each parent, Active or not.
  const listedBy = new Map<string, string[]>();
  for (const p of people) {
    if (!p.roles.includes("Student")) continue;
    for (const a of p.parentEmails) {
      listedBy.set(a, [...(listedBy.get(a) ?? []), p.personId]);
    }
  }

  // Whose each address is: the one they are added by, and their School and
  // RHR addresses, so a graduate's school address is still known as theirs.
  // A student's personal address is deliberately not here: it is never how
  // anyone is added, so finding it in a group is never "theirs, keep it".
  const owner = new Map<string, SheetPerson>();
  for (const p of people) {
    for (const a of [
      groupAddress(p),
      p.student?.schoolEmail ?? null,
      p.mentor?.rhrEmail ?? null,
    ]) {
      if (a && !owner.has(a.toLowerCase())) owner.set(a.toLowerCase(), p);
    }
  }

  return GROUPS.map((group): GroupPlanResult => {
    const current = new Set(
      [...(args.actual[group] ?? [])].map((a) => a.toLowerCase())
    );

    const want = new Map<string, string[]>();
    if (group === "grp-parents") {
      for (const [a, ids] of parents) want.set(a, ids);
    } else {
      for (const p of intended[group]) {
        const a = groupAddress(p)?.toLowerCase();
        if (a) want.set(a, [p.personId]);
      }
    }

    const add: Member[] = [];
    for (const [address, personIds] of want) {
      if (!current.has(address)) add.push({ address, personIds });
    }

    const automatic: Member[] = [];
    const held: HeldMember[] = [];
    for (const address of current) {
      if (want.has(address)) continue;
      if (group === "grp-parents") {
        held.push({
          address,
          personIds: listedBy.get(address) ?? [],
          reason: "parent_not_listed",
        });
        continue;
      }
      const p = owner.get(address);
      if (!p) {
        held.push({ address, personIds: [], reason: "not_on_sheet" });
        continue;
      }
      if (belongs(group, p, asOf, false)) {
        // Still entitled to stay (grp-ra's lapsed screening), at this address.
        if (address === groupAddress(p)?.toLowerCase()) continue;
        held.push({
          address,
          personIds: [p.personId],
          reason: "other_address",
        });
        continue;
      }
      const reason = leaving(group, p, asOf);
      if (reason) held.push({ address, personIds: [p.personId], reason });
      else automatic.push({ address, personIds: [p.personId] });
    }

    const desired = new Set(current);
    for (const m of add) desired.add(m.address);
    for (const m of automatic) desired.delete(m.address);

    const byAddress = (x: Member, y: Member) =>
      x.address < y.address ? -1 : 1;
    return {
      group,
      add: add.sort(byAddress),
      automatic: automatic.sort(byAddress),
      held: held.sort(byAddress),
      refusal: refusal(current, desired),
    };
  });
}
