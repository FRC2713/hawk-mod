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
  /**
   * Deactivated, but declared again by a group. Monitoring resumes: someone
   * back in @students is a student again, and requiring a human to confirm
   * that would leave a real student unmonitored until somebody got round to it.
   */
  | { kind: "reactivate"; personId: number; slackId: string; role: Role }
  | {
      kind: "change";
      personId: number;
      slackId: string;
      from: Role;
      to: Role;
      /** Moving out of `student` removes someone from monitoring. */
      reducesProtection: boolean;
      /** Deactivated when the group declared them; monitoring resumes too. */
      reactivates: boolean;
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
 * Deliberately one-directional in the safe sense: **this reconciliation may only
 * ever add monitoring, never subtract it.** Someone dropped from the students
 * group is left a student, because the alternative — silently ending their
 * monitoring — is the failure this whole system exists to avoid. The only way
 * out of `student` is an explicit move into the adults group, which is a
 * deliberate admin action and is reported as one.
 *
 * That invariant is about direction, not about writes. `reactivate` adds
 * monitoring back to someone who was deactivated and has since been declared
 * again, so it belongs here for the same reason `create` does: gaining
 * protection never needs anyone's permission. Losing it always does — which is
 * why there is no decision here that deactivates anybody.
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
    const roleAlreadyRight =
      person.role === target ||
      (target === "adult" && isAdultRole(person.role));

    if (roleAlreadyRight) {
      decisions.push(
        person.active === 1
          ? { kind: "unchanged", slackId }
          : {
              kind: "reactivate",
              personId: person.id,
              slackId,
              role: person.role,
            }
      );
      continue;
    }

    decisions.push({
      kind: "change",
      personId: person.id,
      slackId,
      from: person.role,
      to: target,
      reducesProtection: person.role === "student" && target !== "student",
      reactivates: person.active !== 1,
    });
  }

  return decisions;
}
