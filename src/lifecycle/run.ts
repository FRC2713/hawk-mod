import type { WebClient } from "@slack/web-api";
import { today } from "../domain/dates.js";
import { planLifecycle, type LifecyclePlan } from "../domain/lifecycle/plan.js";
import { parseSheet } from "../domain/lifecycle/sheet.js";
import {
  planSlackIds,
  type SlackIdDecision,
} from "../domain/lifecycle/slackIds.js";
import { googleEnv, serviceAccountClient } from "../google/credentials.js";
import {
  fillBlankCells,
  readLifecycleSheet,
  SHEETS_READONLY,
  SHEETS_READWRITE,
} from "../google/sheets.js";
import { log } from "../logger.js";
import { fetchWorkspaceUsers } from "../slack/roster.js";

/**
 * The lifecycle commands, once, for both doors: the CLI prints what these
 * return, and `/hawkmod lifecycle` posts it. Production has no shell anyone
 * logs into, so Slack is the door that matters there; keeping one
 * implementation means the dry run seen in Slack is the dry run that was
 * tested from a laptop.
 *
 * Output names Person IDs, rows and counts, never a name or an address — it is
 * posted into Slack, and most of the people in it are minors. The CLI's
 * `--members` is the one exception, and Slack never offers it.
 */

function requireGoogle() {
  const env = googleEnv();
  if (!env) {
    throw new Error(
      "Google is not configured: set GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 (or " +
        "GOOGLE_SERVICE_ACCOUNT_KEY_FILE). See docs/google-setup.md."
    );
  }
  if (!env.sheetId) throw new Error("LIFECYCLE_SHEET_ID is not set");
  return { ...env, sheetId: env.sheetId };
}

function formatPlan(plan: LifecyclePlan, members: boolean): string {
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
  if (plan.notCleared.length) {
    lines.push("", "Active mentors not cleared (not eligible for Slack):");
    for (const m of plan.notCleared) {
      lines.push(`  ${m.personId}: ${m.missing.join(", ")}`);
    }
  }
  if (plan.noAddress.length) {
    lines.push("", `No email to add to groups: ${plan.noAddress.join(", ")}`);
  }
  lines.push("", `Sheet problems: ${plan.problems.length}`);
  for (const p of plan.problems) {
    const where = p.row ? `${p.tab} row ${p.row}` : p.tab;
    lines.push(
      `  ${where}${p.personId ? `, ${p.personId}` : ""}: ${p.message}`
    );
  }
  return lines.join("\n");
}

/** Reads the sheet and describes it. Changes nothing, anywhere. */
export async function lifecyclePlanReport(
  opts: { members?: boolean } = {}
): Promise<string> {
  const env = requireGoogle();
  const client = serviceAccountClient(env, [SHEETS_READONLY]);
  const data = await readLifecycleSheet(client, env.sheetId);
  return formatPlan(
    planLifecycle(parseSheet(data), today()),
    opts.members ?? false
  );
}

const SLACK_ID_LABEL: Record<SlackIdDecision["kind"], string> = {
  write: "To fill in",
  unchanged: "Already correct",
  not_in_slack: "Not in Slack yet",
  conflict: "Needs a person to look at",
};

/**
 * Step 1 of the lifecycle sync. A dry run unless `apply`; both print the same
 * plan, so what an administrator read is what gets written.
 */
export async function slackIdsReport(opts: {
  slack: WebClient;
  apply: boolean;
  /** How to ask for the write, in the words of the door being used. */
  applyHint: string;
  /** Who asked, for the log. */
  by: string;
}): Promise<string> {
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [
    opts.apply ? SHEETS_READWRITE : SHEETS_READONLY,
  ]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));
  const accounts = (await fetchWorkspaceUsers(opts.slack)).map((u) => ({
    id: u.id,
    email: u.email,
    live: !u.isBot && !u.isDeleted,
  }));
  const decisions = planSlackIds(parsed.people, accounts);

  const lines = [
    `Slack User IDs${opts.apply ? "" : " (dry run: nothing changed)"}`,
    "",
  ];
  for (const kind of Object.keys(SLACK_ID_LABEL) as SlackIdDecision["kind"][]) {
    const these = decisions.filter((d) => d.kind === kind);
    lines.push(`${SLACK_ID_LABEL[kind]}: ${these.length}`);
    for (const d of these) {
      const where = `${d.personId} (${d.tab} row ${d.row})`;
      if (d.kind === "write") lines.push(`  ${where} -> ${d.slackUserId}`);
      else if (d.kind === "conflict") lines.push(`  ${where}: ${d.reason}`);
      else if (d.kind === "not_in_slack") lines.push(`  ${where}`);
    }
  }
  if (parsed.problems.length) {
    lines.push(
      "",
      `${parsed.problems.length} sheet problem(s); the lifecycle plan lists them.`
    );
  }

  const writes = decisions.flatMap((d) =>
    d.kind === "write"
      ? [
          {
            tab: d.tab,
            row: d.row,
            header: "Slack User ID" as const,
            personId: d.personId,
            value: d.slackUserId,
          },
        ]
      : []
  );
  if (!opts.apply) {
    if (writes.length) lines.push("", `To fill them in: ${opts.applyHint}`);
    return lines.join("\n");
  }
  const result = await fillBlankCells(sheets, env.sheetId, writes);
  log.info("lifecycle slack ids applied", {
    by: opts.by,
    written: result.written.length,
    skipped: result.skipped.length,
  });
  lines.push("", `Filled ${result.written.length} cell(s).`);
  for (const s of result.skipped) {
    lines.push(`  skipped ${s.write.personId}: ${s.reason}; run it again`);
  }
  return lines.join("\n");
}
