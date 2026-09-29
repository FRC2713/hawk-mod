import { dedupeKey, type NewFinding } from "../findings.js";
import type { GroupPlanResult, Member } from "./groupPlan.js";
import {
  nameMatches,
  type FoundGroup,
  type MissingGroup,
} from "./groupReport.js";
import type { GroupName } from "./groups.js";

/**
 * What a run may do to each Google Group, decided from its plan. Pure, so the
 * three things that stop a group being touched are tested without Google:
 *
 *   - **refused**: the plan's automatic removals would empty the group or take
 *     more than a quarter of it. Held for **Apply anyway**, and only that
 *     overrides it, because a sheet mistake must not empty a group.
 *   - **wrong_group**: the group's ID leads to a group of another name — an ID
 *     on the wrong line. Nothing overrides this: applying would put one
 *     group's people in another.
 *   - **missing**: no ID, or no group has it.
 *
 * Held *members* (someone leaving, an address the sheet does not account for)
 * are never in `remove` at all: this applies joins and flag-off removals and
 * nothing else. Leaving waits for a person (step 4, part 4).
 */
export type HeldWhy = "refused" | "wrong_group" | "missing";

export type GroupDecision =
  | {
      group: GroupName;
      kind: "apply";
      groupId: string;
      name: string;
      add: Member[];
      remove: Member[];
    }
  | { group: GroupName; kind: "held"; why: HeldWhy; message: string }
  | { group: GroupName; kind: "nothing" };

export function decideGroups(args: {
  plans: GroupPlanResult[];
  found: Partial<Record<GroupName, FoundGroup & { id: string }>>;
  missing: Partial<Record<GroupName, MissingGroup>>;
  /** Groups an administrator has said to apply anyway, despite a refusal. */
  force?: ReadonlySet<GroupName>;
}): GroupDecision[] {
  return args.plans.map((plan): GroupDecision => {
    const { group } = plan;
    const found = args.found[group];
    if (!found) {
      const id = args.missing[group]?.id ?? "";
      return {
        group,
        kind: "held",
        why: "missing",
        message: id ? `no group has ID ${id}` : "no ID yet in GOOGLE_GROUP_IDS",
      };
    }
    if (!nameMatches(group, found)) {
      return {
        group,
        kind: "held",
        why: "wrong_group",
        message: `its ID belongs to a group named "${found.name}"`,
      };
    }
    if (plan.refusal && !args.force?.has(group)) {
      return { group, kind: "held", why: "refused", message: plan.refusal };
    }
    if (!plan.add.length && !plan.automatic.length) {
      return { group, kind: "nothing" };
    }
    return {
      group,
      kind: "apply",
      groupId: found.id,
      name: found.name,
      add: plan.add,
      remove: plan.automatic,
    };
  });
}

/** Keys the groups run owns, and closes when it stops seeing them. */
export const GROUP_HELD_PREFIX = "google_group_held:";

export function heldKey(group: GroupName, why: HeldWhy): string {
  return dedupeKey("google_group_held", why, group);
}

/**
 * The alert for a group nothing was applied to. A refusal carries the
 * **Apply anyway** button (see `lifecycleAction` in slack/alerts.ts, keyed on
 * `google_group_held:refused:`); the other two are fixed in the code or in
 * Google, and offer nothing.
 */
export function heldFinding(
  d: Extract<GroupDecision, { kind: "held" }>
): NewFinding {
  const fix =
    d.why === "refused"
      ? "Check the lifecycle sheet: if the change is right, an administrator " +
        "can apply it anyway."
      : d.why === "wrong_group"
        ? "Check its ID in GOOGLE_GROUP_IDS."
        : "Check its ID in GOOGLE_GROUP_IDS, or whether it was deleted.";
  return {
    kind: "google_group_held",
    dedupeKey: heldKey(d.group, d.why),
    severity: "warn",
    summary: `Nothing was applied to ${d.group}: ${d.message}. ${fix}`,
    subjectRef: d.group,
    detail: { group: d.group, why: d.why },
  };
}

/**
 * Changes an apply could not make, for one group. The next run tries again,
 * and the finding closes when one runs clean. By Person ID, never address.
 */
export function failedFinding(
  group: GroupName,
  count: number,
  reason: string
): NewFinding {
  return {
    kind: "google_group_held",
    dedupeKey: dedupeKey("google_group_held", "failed", group),
    severity: "warn",
    summary:
      `${count} change(s) to ${group} failed (Google said: ${reason}). The ` +
      "rest were applied; the next run tries these again.",
    subjectRef: group,
    detail: { group, why: "failed", count },
  };
}

/**
 * The hourly groups run failed outright: Google refused hawk-mod@, the sheet
 * could not be read, or anything else that stops the run before it settles.
 * Without this the failure is a log line on a host nobody has a shell on, and
 * the groups quietly stop following the sheet. Under the same prefix as the
 * held groups, so the next run that settles cleanly closes it. The message is
 * the error's own, which never carries the key (CLAUDE.md).
 */
export function runFailedFinding(message: string): NewFinding {
  return {
    kind: "google_group_held",
    dedupeKey: dedupeKey("google_group_held", "run_failed"),
    severity: "warn",
    summary:
      `The hourly Google Groups run failed (${message}). The groups were left ` +
      "as they were, and nobody new is being added to them until a run " +
      "succeeds. The next run tries again.",
    detail: { why: "run_failed" },
  };
}

/**
 * The alert-channel line for grp-ra changes, applied automatically or not:
 * grp-ra can edit the lifecycle sheet, so a change to it is a change to who
 * can change everyone's access. Names people; the alert channel may.
 */
export function raAnnouncement(
  changes: readonly { action: "add" | "remove"; member: Member }[],
  names: ReadonlyMap<string, string>
): string {
  const who = (m: Member) =>
    m.personIds
      .map((id) => (names.get(id) ? `${id} ${names.get(id)}` : id))
      .join(", ") || "an address not on the sheet";
  const added = changes
    .filter((c) => c.action === "add")
    .map((c) => who(c.member));
  const removed = changes
    .filter((c) => c.action === "remove")
    .map((c) => who(c.member));
  return [
    ":key: *grp-ra changed* — grp-ra can edit the lifecycle sheet.",
    added.length ? `Added: ${added.join("; ")}` : "",
    removed.length ? `Removed: ${removed.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
