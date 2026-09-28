import type { GroupDecision } from "../domain/lifecycle/groupApply.js";
import type { Member } from "../domain/lifecycle/groupPlan.js";
import type { GroupName } from "../domain/lifecycle/groups.js";

/** The two writes a groups run makes. Google in production; a fake in tests. */
export type GroupWriter = {
  add(groupId: string, email: string): Promise<void>;
  remove(groupId: string, email: string): Promise<void>;
};

export type GroupChange = {
  group: GroupName;
  groupId: string;
  /** The group's name in Google, for the record. */
  name: string;
  action: "add" | "remove";
  member: Member;
};

export type GroupApplyResult = {
  applied: GroupChange[];
  failed: (GroupChange & { reason: string })[];
};

/**
 * Applies what `decideGroups` allowed: joins and flag-off removals, for
 * groups not held. Held groups and held members are not in the decisions to
 * begin with, so there is nothing here that could remove someone leaving.
 *
 * One refused address does not stop the rest — a parent's mailbox that
 * Google will not accept must not keep forty students out of grp-students —
 * so each failure is collected and reported, and the next run tries again.
 * `record` is called for each change that was made, as it is made.
 */
export async function applyGroupDecisions(
  decisions: readonly GroupDecision[],
  writer: GroupWriter,
  record: (change: GroupChange) => void
): Promise<GroupApplyResult> {
  const result: GroupApplyResult = { applied: [], failed: [] };
  for (const d of decisions) {
    if (d.kind !== "apply") continue;
    const changes: GroupChange[] = [
      ...d.add.map((member) => ({ action: "add" as const, member })),
      ...d.remove.map((member) => ({ action: "remove" as const, member })),
    ].map((c) => ({ ...c, group: d.group, groupId: d.groupId, name: d.name }));
    for (const change of changes) {
      try {
        await (change.action === "add" ? writer.add : writer.remove)(
          change.groupId,
          change.member.address
        );
        record(change);
        result.applied.push(change);
      } catch (err) {
        result.failed.push({
          ...change,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}
