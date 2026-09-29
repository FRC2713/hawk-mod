import { REASON } from "./groupReport.js";
import {
  SLACK_GROUP_IDS,
  type SlackCopy,
  type SlackCopyDecision,
  type SlackCopyPlan,
  type SlackMember,
} from "./slackGroups.js";

/**
 * The Slack copies' plan as text, for `/hawkmod lifecycle slack-groups` and
 * the CLI. It goes only to an administrator, so it names people — Person ID
 * and name, and for an account the sheet does not know, its Slack name —
 * which is what they need to act on it. There are no addresses to hide: a
 * Slack group holds accounts.
 */

/** A copy's Slack group as read for this report. */
export type ReadCopy = {
  id: string;
  handle: string;
  /** Members now. */
  count: number;
  /** Default channels, already labelled `#name (C…)`. */
  channels: string[];
  /**
   * Found by its handle because `SLACK_GROUP_IDS` has no ID for it yet:
   * planned so the dry run shows real numbers, never applied.
   */
  byHandle: boolean;
};

/** A user group in the workspace, for the list that helps fill in IDs. */
export type ListedGroup = {
  id: string;
  handle: string;
  name: string;
  disabled: boolean;
};

export function formatSlackCopies(args: {
  plans: readonly SlackCopyPlan[];
  decisions: readonly SlackCopyDecision[];
  read: Partial<Record<SlackCopy, ReadCopy>>;
  /** Copies whose group Slack has only as disabled. */
  disabled: ReadonlySet<SlackCopy>;
  workspace: readonly ListedGroup[];
  /** Person ID → name, from the sheet. */
  names: ReadonlyMap<string, string>;
  /** Slack user ID → name, for accounts the sheet does not know. */
  accounts: ReadonlyMap<string, string>;
  dryRun: boolean;
}): string {
  const { plans, read, dryRun } = args;
  const decision = new Map(args.decisions.map((d) => [d.copy, d]));

  const who = (m: SlackMember) =>
    m.personId
      ? `${m.personId} ${args.names.get(m.personId) ?? ""}`.trim()
      : `${args.accounts.get(m.slackUserId) ?? "an account"} (${m.slackUserId})`;

  const counted = plans.filter((p) => read[p.copy]);
  const total = (f: (p: SlackCopyPlan) => unknown[]) =>
    counted.reduce((n, p) => n + f(p).length, 0);
  const lines = [
    `Slack user groups from the lifecycle sheet${dryRun ? " (dry run: nothing changed)" : ""}`,
    "",
    `${dryRun ? "Would add" : "Adding"}: ${total((p) => p.add)} · ` +
      `${dryRun ? "would remove" : "removing"} (lead/RA flag off): ` +
      `${total((p) => p.remove)} · held (Apply never removes them): ` +
      `${total((p) => p.held)}`,
  ];

  for (const plan of plans) {
    const { copy } = plan;
    const expected = SLACK_GROUP_IDS[copy];
    const r = read[copy];
    lines.push("");
    if (!r) {
      lines.push(
        args.disabled.has(copy)
          ? `  @${expected.handle} (${copy}): disabled in Slack; skipped. ` +
              "Enable it in Slack if it should be copied."
          : expected.id
            ? `  @${expected.handle} (${copy}): Slack has no user group ` +
              `${expected.id}. Check the ID in SLACK_GROUP_IDS; hawk-mod ` +
              "never creates groups."
            : `  @${expected.handle} (${copy}): no ID yet in SLACK_GROUP_IDS, ` +
              `and Slack has no group @${expected.handle}; skipped.`
      );
      continue;
    }

    lines.push(`  @${r.handle} (${r.id}, ${r.count} now) ← ${copy}`);
    lines.push(
      r.channels.length
        ? `    Default channels: ${r.channels.join(", ")}`
        : "    Default channels: none"
    );
    if (r.byHandle) {
      lines.push(
        `    NO ID YET: found by its handle for this dry run. Put ${r.id} in ` +
          "SLACK_GROUP_IDS; nothing is applied to it until then."
      );
    }
    const d = decision.get(copy);
    if (d?.kind === "held" && d.why === "wrong_group") {
      lines.push(
        `    WRONG GROUP: ${d.message}. Check the ID in SLACK_GROUP_IDS; ` +
          "nothing will be applied to it."
      );
    }
    if (plan.refusal) lines.push(`    WOULD BE HELD: ${plan.refusal}`);

    const list = (title: string, items: SlackMember[]) => {
      if (!items.length) return;
      lines.push(`    ${title}: ${items.length}`);
      for (const m of items) lines.push(`      ${who(m)}`);
    };
    list(dryRun ? "Would add" : "Adding", plan.add);
    list(
      dryRun
        ? "Would remove (lead/RA flag off)"
        : "Removing (lead/RA flag off)",
      plan.remove
    );
    if (plan.held.length) {
      lines.push(`    Held, Apply never removes them: ${plan.held.length}`);
      for (const h of plan.held) {
        lines.push(`      ${who(h)}: ${REASON[h.reason]}`);
      }
    }
    if (
      !plan.refusal &&
      !plan.add.length &&
      !plan.remove.length &&
      !plan.held.length
    ) {
      lines.push("    Matches the sheet.");
    }
  }

  if (plans.some((p) => !SLACK_GROUP_IDS[p.copy].id)) {
    lines.push("", "User groups in Slack, to fill in SLACK_GROUP_IDS:");
    const sorted = [...args.workspace].sort((a, b) =>
      a.handle < b.handle ? -1 : 1
    );
    for (const g of sorted) {
      lines.push(
        `  @${g.handle}  ${g.id}  ${g.name}${g.disabled ? "  (disabled)" : ""}`
      );
    }
  }
  return lines.join("\n");
}
