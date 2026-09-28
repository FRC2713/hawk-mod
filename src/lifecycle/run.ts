import type { WebClient } from "@slack/web-api";
import { today } from "../domain/dates.js";
import { planLifecycle, type LifecyclePlan } from "../domain/lifecycle/plan.js";
import { planRoster } from "../domain/lifecycle/roster.js";
import { formatRosterPlan } from "../domain/lifecycle/rosterReport.js";
import { parseSheet } from "../domain/lifecycle/sheet.js";
import {
  planSlackIds,
  type SlackIdDecision,
} from "../domain/lifecycle/slackIds.js";
import {
  googleActor,
  googleDomain,
  googleEnv,
  serviceAccountClient,
} from "../google/credentials.js";
import {
  DIRECTORY_GROUP_MEMBER,
  DIRECTORY_GROUP_READONLY,
  readGroupMembers,
} from "../google/directory.js";
import { planGoogleGroups } from "../domain/lifecycle/groupPlan.js";
import { formatGroupPlans } from "../domain/lifecycle/groupReport.js";
import { GROUPS, type GroupName } from "../domain/lifecycle/groups.js";
import {
  fillBlankCells,
  readLifecycleSheet,
  SHEETS_READONLY,
  SHEETS_READWRITE,
} from "../google/sheets.js";
import { APP_ACTOR } from "../brand.js";
import { closeFinding } from "../close.js";
import {
  findingByKey,
  listPeople,
  resolveMissingWithPrefix,
  rosterCutoverDone,
} from "../db/repo.js";
import {
  ROSTER_FINDING_PREFIXES,
  rosterFinding,
  rosterFindingKey,
  UNREADABLE_KEY,
  unreadableFinding,
} from "../domain/lifecycle/rosterFindings.js";
import { raise } from "../raise.js";
import { refreshFinding } from "../slack/alerts.js";
import { applyRosterChanges } from "./applyRoster.js";
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
  if (plan.noAccess.length) {
    lines.push(
      "",
      "Active mentors without CORI current (join no group; not invited to Slack):"
    );
    for (const m of plan.noAccess) lines.push(`  ${m.personId}: ${m.why}`);
  }
  if (plan.notCleared.length) {
    lines.push(
      "",
      "Active mentors not screened (do not count toward the two-adult rule):"
    );
    for (const m of plan.notCleared) {
      lines.push(`  ${m.personId}: ${m.missing.join(", ")}`);
    }
  }
  if (plan.noAddress.length) {
    lines.push("", `No email to add to groups: ${plan.noAddress.join(", ")}`);
  }
  if (plan.noParentEmail.length) {
    lines.push(
      "",
      `Active students with no parent email for grp-parents: ${plan.noParentEmail.join(", ")}`
    );
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

/** Everything a roster plan is made from, read fresh. */
async function readRosterInputs(slack: WebClient) {
  const env = requireGoogle();
  const client = serviceAccountClient(env, [SHEETS_READONLY]);
  const parsed = parseSheet(await readLifecycleSheet(client, env.sheetId));
  const accounts = (await fetchWorkspaceUsers(slack)).map((u) => ({
    id: u.id,
    email: u.email,
    live: !u.isBot && !u.isDeleted,
  }));
  const roster = listPeople(false);
  const plan = planRoster({
    roster,
    sheet: parsed.people,
    accounts,
    firstApply: !rosterCutoverDone(),
  });
  return { parsed, roster, plan };
}

/**
 * Step 3: the roster from the sheet. A dry run unless `apply`; both plan the
 * same way and print the same text, so what an administrator read is what
 * gets applied.
 *
 * Applying writes every change or none, then raises what the plan asks a
 * person about and closes whatever it no longer sees. A refused plan changes
 * nothing. So does a sheet that cannot be read — and once the roster comes
 * from the sheet, that is itself a finding, because a roster that silently
 * stops updating is one that silently stops adding new students.
 */
export async function rosterReport(opts: {
  slack: WebClient;
  apply: boolean;
  /** How to ask for the apply, in the words of the door being used. */
  applyHint: string;
  /** Who asked, for the log. */
  by: string;
}): Promise<string> {
  let inputs;
  try {
    inputs = await readRosterInputs(opts.slack);
  } catch (err) {
    if (opts.apply && rosterCutoverDone()) {
      await raise(unreadableFinding(errorText(err)));
    }
    throw err;
  }
  const { parsed, roster, plan } = inputs;
  const text = formatRosterPlan({
    plan,
    roster,
    sheetProblems: parsed.problems.length,
    dryRun: !opts.apply,
  });

  if (!opts.apply) {
    const anything = plan.changes.length || plan.findings.length;
    return plan.refused || !anything
      ? text
      : `${text}\n\nTo apply it: ${opts.applyHint}`;
  }
  if (plan.refused) return `${text}\n\nNothing was changed.`;

  const stats = applyRosterChanges(plan);
  log.info("lifecycle roster applied", { by: opts.by, ...stats });

  // The sheet was readable, so a finding saying otherwise is over.
  const unreadable = findingByKey(UNREADABLE_KEY);
  if (unreadable && unreadable.status !== "resolved") {
    await closeFinding(
      unreadable.id,
      APP_ACTOR,
      "The lifecycle sheet was read."
    );
  }

  const names = {
    roster: new Map(roster.map((r) => [r.id, r])),
    sheet: new Map(parsed.people.map((p) => [p.personId, p.name])),
  };
  const seen = new Set<string>();
  for (const f of plan.findings) {
    const finding = rosterFinding(f, names);
    seen.add(finding.dedupeKey);
    await raise(finding);
  }
  const closed = resolveMissingWithPrefix(
    ROSTER_FINDING_PREFIXES,
    seen,
    "No longer true on the lifecycle sheet."
  );
  for (const id of closed) await refreshFinding(id);

  return (
    `${text}\n\nApplied: ${stats.created} created, ${stats.updated} updated. ` +
    `${plan.findings.length} question(s) are in the alert channel; ` +
    `${closed.length} closed as no longer true.`
  );
}

/**
 * Whether a roster finding is still what the sheet says, read now — for a
 * button that would lower monitoring. An hour-old finding is not enough to
 * end someone's monitoring on: the sheet may have declared them Active again
 * since, and the button must not act on a request nobody is making any more.
 */
export async function rosterFindingStillTrue(
  slack: WebClient,
  key: string
): Promise<boolean> {
  const { plan } = await readRosterInputs(slack);
  return plan.findings.some((f) => rosterFindingKey(f) === key);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Step 4's dry run: each computed Google Group against its real membership,
 * read as hawk-mod@ through domain-wide delegation. Changes nothing, anywhere.
 */
export async function groupsReport(
  opts: { members?: boolean } = {}
): Promise<string> {
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [SHEETS_READONLY]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));

  const directory = serviceAccountClient(
    env,
    [DIRECTORY_GROUP_READONLY, DIRECTORY_GROUP_MEMBER],
    googleActor()
  );
  const domain = googleDomain();
  const actual: Partial<Record<GroupName, string[]>> = {};
  const current: Partial<Record<GroupName, number>> = {};
  const missing: GroupName[] = [];
  for (const group of GROUPS) {
    const members = await readGroupMembers(directory, `${group}@${domain}`);
    if (members === null) missing.push(group);
    else {
      actual[group] = members;
      current[group] = members.length;
    }
  }

  const plans = planGoogleGroups({
    people: parsed.people,
    actual,
    asOf: today(),
  });
  return formatGroupPlans({
    plans,
    current,
    missing,
    members: opts.members ?? false,
    dryRun: true,
  });
}

const SLACK_ID_LABEL: Record<SlackIdDecision["kind"], string> = {
  write: "To fill in",
  unchanged: "Already correct",
  typed: "Typed by hand, trusted (Slack email differs)",
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

export const NOT_YET_BUILT =
  "The roster has not been built from the lifecycle sheet yet, so there is " +
  "nothing to keep in step. Check it with `/hawkmod lifecycle roster`, then " +
  "build it with `/hawkmod lifecycle roster apply`.";

/**
 * One run of the roster from the sheet, as the hourly job and "sync now" both
 * do it: apply the plan, then write newly linked Slack User IDs back to the
 * sheet. Does nothing before the cutover — the first apply is a person's
 * decision, taken after reading the dry run.
 *
 * A sheet that cannot be read raises `lifecycle_unreadable` and leaves the
 * roster as it was (rosterReport). A write-back that fails does not undo a
 * roster already applied: the IDs are filled in on the next run.
 */
export async function rosterSync(opts: {
  slack: WebClient;
  /** Who asked, for the log: "hourly", "cli", or an administrator's name. */
  by: string;
}): Promise<string> {
  if (!rosterCutoverDone()) {
    log.info("lifecycle roster sync skipped: not built from the sheet yet");
    return NOT_YET_BUILT;
  }
  const roster = await rosterReport({
    slack: opts.slack,
    apply: true,
    applyHint: "",
    by: opts.by,
  });
  let ids: string;
  try {
    ids = await slackIdsReport({
      slack: opts.slack,
      apply: true,
      applyHint: "",
      by: opts.by,
    });
  } catch (err) {
    log.warn("slack id write-back failed", { error: errorText(err) });
    ids = `Slack User IDs were not written back (${errorText(err)}); the next run tries again.`;
  }
  return `${roster}\n\n${ids}`;
}
