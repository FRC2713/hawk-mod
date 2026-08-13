import { type Person, type Role } from "../people.js";

export type GroupMembership = {
  /** Slack ids in the group designating students. */
  students: ReadonlySet<string>;
  /** Slack ids in the group designating adults/adults. */
  adults: ReadonlySet<string>;
};

export type RoleDecision =
  | { kind: "unchanged"; slackId: string }
  /** In a group but not on the roster — the row gets created from Slack. */
  | { kind: "create"; slackId: string; role: Role }
  | {
      kind: "change";
      personId: number;
      slackId: string;
      from: Role;
      to: Role;
      /** Moving out of `student` removes someone from monitoring. */
      reducesProtection: boolean;
    }
  /** In both groups at once; too ambiguous to act on. */
  | { kind: "conflict"; slackId: string; personId: number | null };

const ADULT_ROLES: Role[] = ["adult", "district_observer"];

function isAdultRole(role: Role): boolean {
  return ADULT_ROLES.includes(role);
}

/**
 * Reconciles Slack user groups against roster roles.
 *
 * Deliberately one-directional in the safe sense: **membership of a group can
 * only ever be added to the roster, never subtracted from it.** Someone dropped
 * from the students group is left a student, because the alternative — silently
 * ending their monitoring — is the failure this whole system exists to avoid.
 * The only way out of `student` is an explicit move into the adults group,
 * which is a deliberate admin action and is reported as one.
 *
 * Pure: the caller does the Slack reads and the writes.
 */
export function reconcileRoles(
  roster: ReadonlyMap<string, Person>,
  groups: GroupMembership
): RoleDecision[] {
  const decisions: RoleDecision[] = [];
  const seen = new Set<string>([...groups.students, ...groups.adults]);

  for (const slackId of seen) {
    const inStudents = groups.students.has(slackId);
    const inAdults = groups.adults.has(slackId);
    const person = roster.get(slackId) ?? null;

    if (inStudents && inAdults) {
      decisions.push({
        kind: "conflict",
        slackId,
        personId: person?.id ?? null,
      });
      continue;
    }

    const target: Role = inStudents ? "student" : "adult";

    if (!person) {
      decisions.push({ kind: "create", slackId, role: target });
      continue;
    }

    // A district observer in the adults group is agreement, not a demotion to
    // plain `adult`.
    if (target === "adult" && isAdultRole(person.role)) {
      decisions.push({ kind: "unchanged", slackId });
      continue;
    }

    if (person.role === target) {
      decisions.push({ kind: "unchanged", slackId });
      continue;
    }

    decisions.push({
      kind: "change",
      personId: person.id,
      slackId,
      from: person.role,
      to: target,
      reducesProtection: person.role === "student" && target !== "student",
    });
  }

  return decisions;
}
