import type { GroupName } from "./groups.js";
import type {
  GroupPlanResult,
  HeldMember,
  HeldReason,
  Member,
} from "./groupPlan.js";

/**
 * The Google Groups plan as text, for `/hawkmod lifecycle groups` and the CLI.
 *
 * Names Person IDs and counts, never an address: it is posted into Slack, and
 * most of the people in these groups are minors or their parents. An address
 * the sheet does not account for has no Person ID, so it is counted, and the
 * CLI's `--members` — which Slack never offers — lists it.
 */

const REASON: Record<HeldReason, string> = {
  inactive: "Inactive on the sheet",
  status_unknown: "Active/Inactive is blank or unknown",
  role_gone: "no longer holds the role this group is for",
  no_access: "CORI not current",
  not_on_sheet: "not on the sheet",
  other_address: "a second address of theirs, not the one they are added by",
  parent_not_listed: "no Active student lists them as a parent",
};

function who(m: Member, group: GroupName, members: boolean): string {
  const ids =
    group === "grp-parents"
      ? m.personIds.length
        ? `parent of ${m.personIds.join(", ")}`
        : "a parent"
      : m.personIds.join(", ") || "no Person ID";
  return members ? `${ids} <${m.address}>` : ids;
}

function list(
  lines: string[],
  title: string,
  items: Member[],
  group: GroupName,
  members: boolean
) {
  if (!items.length) return;
  lines.push(`    ${title}: ${items.length}`);
  for (const m of items) lines.push(`      ${who(m, group, members)}`);
}

/** A group as read by its ID. */
export type FoundGroup = { name: string; email: string; count: number };

/** Why a group was not planned: no ID yet, or no group with that ID. */
export type MissingGroup = { id: string };

/**
 * A group is only acted on when its ID leads to a group of the expected name.
 * A different name means an ID on the wrong line, and applying there would put
 * one group's people in another.
 */
export function nameMatches(group: GroupName, found: FoundGroup): boolean {
  return found.name.trim().toLowerCase() === group;
}

export function formatGroupPlans(args: {
  plans: GroupPlanResult[];
  /** Groups read by their ID, with their current name and address. */
  found: Partial<Record<GroupName, FoundGroup>>;
  /** Groups not read: no ID configured, or no group has that ID. */
  missing: Partial<Record<GroupName, MissingGroup>>;
  /** Print member addresses too. The CLI only; Slack never offers it. */
  members: boolean;
  dryRun: boolean;
}): string {
  const { plans, members } = args;
  // Only groups that were read, and are the group they should be, count.
  const counted = plans.filter((p) => {
    const f = args.found[p.group];
    return f && nameMatches(p.group, f);
  });
  const count = (f: (p: GroupPlanResult) => unknown[]) =>
    counted.reduce((n, p) => n + f(p).length, 0);
  const lines = [
    `Google Groups from the lifecycle sheet${args.dryRun ? " (dry run: nothing changed)" : ""}`,
    "",
    `${args.dryRun ? "Would join" : "Joining"}: ${count((p) => p.add)} · ` +
      `${args.dryRun ? "leave" : "leaving"} on their own (lead/RA flag off): ` +
      `${count((p) => p.automatic)} · held for a click: ${count((p) => p.held)}`,
  ];

  for (const plan of plans) {
    const { group } = plan;
    lines.push("");
    const missing = args.missing[group];
    const found = args.found[group];
    if (missing || !found) {
      lines.push(
        missing?.id
          ? `  ${group}: no group has ID ${missing.id}. Check the ID in ` +
              "GOOGLE_GROUP_IDS; hawk-mod never creates groups."
          : `  ${group}: no ID yet in GOOGLE_GROUP_IDS; skipped.`
      );
      continue;
    }
    // Group addresses are team lists, not anyone's personal address.
    lines.push(`  ${group} (${found.email}, ${found.count} now)`);
    if (!nameMatches(group, found)) {
      lines.push(
        `    WRONG GROUP: this ID belongs to a group named "${found.name}". ` +
          "Check the ID in GOOGLE_GROUP_IDS; nothing will be applied to it."
      );
    }
    if (plan.refusal) lines.push(`    WOULD BE HELD: ${plan.refusal}`);
    list(
      lines,
      args.dryRun ? "Would join" : "Joining",
      plan.add,
      group,
      members
    );
    list(
      lines,
      args.dryRun ? "Would leave on their own" : "Leaving on their own",
      plan.automatic,
      group,
      members
    );

    const onSheet = plan.held.filter((h) => h.reason !== "not_on_sheet");
    const unknown = plan.held.filter((h) => h.reason === "not_on_sheet");
    if (onSheet.length) {
      lines.push(`    Held for a click: ${onSheet.length}`);
      for (const h of onSheet as HeldMember[]) {
        lines.push(`      ${who(h, group, members)}: ${REASON[h.reason]}`);
      }
    }
    if (unknown.length) {
      lines.push(
        `    Held, not on the sheet: ${unknown.length} address(es)` +
          (members
            ? ""
            : " — compare the group's members in the Google Admin console")
      );
      if (members) for (const h of unknown) lines.push(`      <${h.address}>`);
    }
    if (
      !plan.refusal &&
      !plan.add.length &&
      !plan.automatic.length &&
      !plan.held.length
    ) {
      lines.push("    Matches the sheet.");
    }
  }
  return lines.join("\n");
}
