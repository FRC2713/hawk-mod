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

export function formatGroupPlans(args: {
  plans: GroupPlanResult[];
  /** Current member counts, per group that exists. */
  current: Partial<Record<GroupName, number>>;
  /** Groups Google says do not exist. hawk-mod never creates one. */
  missing: GroupName[];
  /** Print addresses too. The CLI only; Slack never offers it. */
  members: boolean;
  dryRun: boolean;
}): string {
  const { plans, members } = args;
  const count = (f: (p: GroupPlanResult) => unknown[]) =>
    plans.reduce((n, p) => n + f(p).length, 0);
  const lines = [
    `Google Groups from the lifecycle sheet${args.dryRun ? " (dry run: nothing changed)" : ""}`,
    "",
    `Would join: ${count((p) => p.add)} · leave on their own (lead/RA flag off): ` +
      `${count((p) => p.automatic)} · held for a click: ${count((p) => p.held)}`,
  ];

  for (const plan of plans) {
    const { group } = plan;
    lines.push("");
    if (args.missing.includes(group)) {
      lines.push(
        `  ${group}: does not exist in Google. Create it by hand; hawk-mod never creates groups.`
      );
      continue;
    }
    lines.push(`  ${group} (${args.current[group] ?? 0} now)`);
    if (plan.refusal) lines.push(`    WOULD BE HELD: ${plan.refusal}`);
    list(lines, "Would join", plan.add, group, members);
    list(lines, "Would leave on their own", plan.automatic, group, members);

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
