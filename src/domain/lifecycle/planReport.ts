import { labelOf, type PersonLabels } from "./labels.js";
import type { LifecyclePlan } from "./plan.js";

/**
 * The lifecycle plan as text, for `/hawkmod lifecycle plan` and the CLI: what
 * the sheet computes, before anything is compared with Google.
 *
 * Each person is named by Person ID, short name and role (`labels.ts`). It is
 * an ephemeral reply to an administrator. Never an address, except under the
 * CLI's `--members`, which Slack never offers: most of the addresses in these
 * groups belong to minors or their parents.
 */
export function formatPlan(
  plan: LifecyclePlan,
  labels: PersonLabels,
  members: boolean
): string {
  const who = (personId: string) => labelOf(labels, personId);
  const { people } = plan;
  const count = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  const lines = [
    `Lifecycle plan as of ${plan.asOf} (dry run: nothing changed)`,
    "",
    `People: ${people.total} (${count(people.byStatus)})`,
    `Roles:  ${count(people.byRole)}`,
    "",
    "Groups, as the sheet computes them:",
  ];
  for (const g of plan.groups) {
    lines.push(`  ${g.name.padEnd(18)} ${g.members.length}`);
    if (members) for (const m of g.members) lines.push(`      ${m}`);
  }
  if (plan.noAccess.length) {
    lines.push(
      "",
      "Active mentors without CORI current (join no group; not invited to Slack):"
    );
    for (const m of plan.noAccess) lines.push(`  ${who(m.personId)}: ${m.why}`);
  }
  if (plan.notCleared.length) {
    lines.push(
      "",
      "Active mentors not screened (do not count toward the two-adult rule):"
    );
    for (const m of plan.notCleared) {
      lines.push(`  ${who(m.personId)}: ${m.missing.join(", ")}`);
    }
  }
  if (plan.noAddress.length) {
    lines.push(
      "",
      `No email to add to groups: ${plan.noAddress.map(who).join(", ")}`
    );
  }
  if (plan.noParentEmail.length) {
    lines.push(
      "",
      `Active students with no parent email for grp-parents: ${plan.noParentEmail.map(who).join(", ")}`
    );
  }
  lines.push("", `Sheet problems: ${plan.problems.length}`);
  for (const p of plan.problems) {
    const where = p.row ? `${p.tab} row ${p.row}` : p.tab;
    lines.push(
      `  ${where}${p.personId ? `, ${who(p.personId)}` : ""}: ${p.message}`
    );
  }
  return lines.join("\n");
}
