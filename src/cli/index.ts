import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync } from "node:fs";
import { db } from "../db/client.js";
import {
  getConversation,
  insertConsent,
  listFindings,
  personByEmail,
  personBySlackId,
  SCREENING_FIELDS,
  setPersonRole,
  upsertPerson,
} from "../db/repo.js";
import { defaultExpiry } from "../domain/rules/consent.js";
import { ROLES, type Role } from "../domain/people.js";
import { backfillAll } from "../monitor/backfill.js";
import { runSweep } from "../jobs/sweep.js";
import { today } from "../domain/dates.js";
import { planLifecycle, type LifecyclePlan } from "../domain/lifecycle/plan.js";
import { parseSheet } from "../domain/lifecycle/sheet.js";
import { googleEnv, serviceAccountClient } from "../google/credentials.js";
import {
  fillBlankCells,
  readLifecycleSheet,
  SHEETS_READONLY,
  SHEETS_READWRITE,
} from "../google/sheets.js";
import {
  planSlackIds,
  type SlackIdDecision,
} from "../domain/lifecycle/slackIds.js";
import { fetchWorkspaceUsers } from "../slack/roster.js";
import { botClient } from "../slack/tokens.js";

const USAGE = `hawk-mod cli

  import-roster <file.csv>     email,full_name,role,screening_expires_on,
                               training_expires_on,cori_expires_on,
                               consent_release_expires_on,
                               data_privacy_expires_on,
                               mentor_ready_completed_on,active,notes
                               Dates are EXPIRY dates, as FIRST shows them
  import-consents <file.csv>   email,signed_on,form_version,guardian_name,
                               guardian_email,document_ref,recorded_by[,expires_on]
  set-role <email|U…> <role>   role: student|adult|district_observer.
                               Nothing here grants access to /hawkmod — that
                               is Slack's Owner/Admin, read live.
  sweep                        run the compliance sweep
  backfill                     walk enrolled adults' DM history
  findings [status]            list findings (default: open)
  export-conversation <id> [out.json]
                               produce one conversation's full log
  lifecycle plan [--members]   read the lifecycle sheet and print what a sync
                               would do. Changes nothing. Needs
                               GOOGLE_SERVICE_ACCOUNT_KEY_FILE and
                               LIFECYCLE_SHEET_ID; --members lists addresses
  lifecycle slack-ids [--apply]
                               match sheet people to Slack accounts by email
                               and show which Slack User ID cells would be
                               filled; --apply fills them. Only ever fills a
                               blank cell. Needs the Slack install too
`;

function rows(path: string): Record<string, string>[] {
  return parse(readFileSync(path, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

function optional(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

const RETIRED_COLUMNS = [
  "ypp_completed_on",
  "ypt_completed_on",
  "mentor_ready_on",
  "cori_completed_on",
];

function importRoster(path: string) {
  let count = 0;
  for (const r of rows(path)) {
    const role = r.role as Role;
    if (!ROLES.includes(role)) {
      throw new Error(`Row for ${r.email}: unknown role "${r.role}"`);
    }
    if (!r.email || !r.full_name) {
      throw new Error("Every row needs an email and a full_name");
    }
    const old = RETIRED_COLUMNS.filter((c) => c in r);
    if (old.length) {
      // These held COMPLETION dates. Read under the new names they would be
      // taken as expiry dates and shorten or lengthen someone's clearance; left
      // unread they would import every adult as unscreened with no warning.
      throw new Error(
        `This CSV uses retired columns (${old.join(", ")}). Requirements are ` +
          "now expiry dates, as FIRST shows them: " +
          SCREENING_FIELDS.join(", ")
      );
    }
    upsertPerson({
      email: r.email,
      fullName: r.full_name,
      role,
      active: r.active === undefined ? true : r.active !== "0",
      requirements: Object.fromEntries(
        SCREENING_FIELDS.map((f) => [f, optional(r[f])])
      ),
      notes: optional(r.notes),
    });
    count += 1;
  }
  console.log(`Imported ${count} roster row(s).`);
}

function importConsents(path: string) {
  let count = 0;
  for (const r of rows(path)) {
    const person = r.email ? personByEmail(r.email) : undefined;
    if (!person)
      throw new Error(
        `No roster entry for ${r.email}; import the roster first`
      );
    if (!r.signed_on)
      throw new Error(`Consent for ${r.email} has no signed_on date`);
    insertConsent({
      personId: person.id,
      signedOn: r.signed_on,
      expiresOn: r.expires_on || defaultExpiry(r.signed_on),
      formVersion: r.form_version || "unversioned",
      guardianName: r.guardian_name || "",
      guardianEmail: optional(r.guardian_email),
      documentRef: optional(r.document_ref),
      recordedBy: r.recorded_by || "cli",
    });
    count += 1;
  }
  console.log(`Recorded ${count} consent(s).`);
}

/**
 * The thing §4.4 promises a parent or the district: one conversation, in full,
 * including edits and deletions. Writes to a file rather than stdout so the
 * content does not land in a terminal scrollback.
 */
function exportConversation(id: string, out?: string) {
  const conversation = getConversation(id);
  if (!conversation) throw new Error(`No conversation ${id} on record`);
  const messages = db()
    .prepare(
      `SELECT m.*, (
         SELECT json_group_array(json_object('previous_text', r.previous_text,
                                             'replaced_at', r.replaced_at))
         FROM dm_message_revisions r WHERE r.message_id = m.id
       ) AS revisions
       FROM dm_messages m WHERE m.conversation_id = ? ORDER BY m.ts`
    )
    .all(id);
  const payload = {
    conversation,
    messages,
    exportedAt: new Date().toISOString(),
  };
  const path = out ?? `conversation-${id}.json`;
  writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${messages.length} message(s) to ${path}`);
}

/**
 * The user group sync only ever assigns `student` or `adult`, so
 * `district_observer` (§8) has to be set from outside Slack. Recorded in
 * role_changes like any other role change.
 */
function setRole(who: string, role: string) {
  if (!ROLES.includes(role as Role)) {
    throw new Error(`Unknown role "${role}". One of: ${ROLES.join(", ")}`);
  }
  const person = who.startsWith("U")
    ? (personBySlackId(who) ?? personByEmail(who))
    : personByEmail(who);
  if (!person) {
    throw new Error(
      `No roster entry for ${who}. Run a sweep first so the user groups create it.`
    );
  }
  if (person.role === role) {
    console.log(`${person.full_name} is already ${role}.`);
    return;
  }
  setPersonRole({
    personId: person.id,
    toRole: role as Role,
    source: "cli",
    detail: { via: "set-role" },
  });
  console.log(`${person.full_name}: ${person.role} -> ${role}`);
}

function printPlan(plan: LifecyclePlan, members: boolean) {
  const { people } = plan;
  const count = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
  console.log(`Lifecycle plan as of ${plan.asOf} (dry run: nothing changed)\n`);
  console.log(`People: ${people.total} (${count(people.byStatus)})`);
  console.log(`Roles:  ${count(people.byRole)}\n`);
  console.log("Groups, as the sheet computes them:");
  for (const g of plan.groups) {
    console.log(`  ${g.name.padEnd(18)} ${g.members.length}`);
    if (members) for (const m of g.members) console.log(`      ${m}`);
  }
  if (plan.notCleared.length) {
    console.log("\nActive mentors not cleared (kept out of grp-all-team):");
    for (const m of plan.notCleared) {
      console.log(`  ${m.personId}: ${m.missing.join(", ")}`);
    }
  }
  if (plan.noAddress.length) {
    console.log(`\nNo email to add to groups: ${plan.noAddress.join(", ")}`);
  }
  console.log(`\nSheet problems: ${plan.problems.length}`);
  for (const p of plan.problems) {
    const where = p.row ? `${p.tab} row ${p.row}` : p.tab;
    console.log(
      `  ${where}${p.personId ? `, ${p.personId}` : ""}: ${p.message}`
    );
  }
}

/**
 * Reads the sheet and prints the plan. Addresses are printed only on request:
 * the default output is safe to paste into a channel, since it names Person
 * IDs and counts, and most of the addresses belong to minors.
 */
function requireGoogle() {
  const env = googleEnv();
  if (!env) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set; see docs/google-setup.md"
    );
  }
  if (!env.sheetId) throw new Error("LIFECYCLE_SHEET_ID is not set");
  return { ...env, sheetId: env.sheetId };
}

async function lifecyclePlan(args: string[]) {
  const env = requireGoogle();
  const client = serviceAccountClient(env, [SHEETS_READONLY]);
  const data = await readLifecycleSheet(client, env.sheetId);
  printPlan(
    planLifecycle(parseSheet(data), today()),
    args.includes("--members")
  );
}

const SLACK_ID_LABEL: Record<SlackIdDecision["kind"], string> = {
  write: "To fill in",
  unchanged: "Already correct",
  not_in_slack: "Not in Slack yet",
  conflict: "Needs a person to look at",
};

/**
 * Step 1 of the lifecycle sync. Dry run unless `--apply`; the dry run and the
 * write print the same plan, so what is approved is what is written.
 */
async function lifecycleSlackIds(args: string[]) {
  const apply = args.includes("--apply");
  const env = requireGoogle();
  const sheets = serviceAccountClient(env, [
    apply ? SHEETS_READWRITE : SHEETS_READONLY,
  ]);
  const parsed = parseSheet(await readLifecycleSheet(sheets, env.sheetId));
  const accounts = (await fetchWorkspaceUsers(botClient())).map((u) => ({
    id: u.id,
    email: u.email,
    live: !u.isBot && !u.isDeleted,
  }));
  const decisions = planSlackIds(parsed.people, accounts);

  console.log(`Slack User IDs${apply ? "" : " (dry run: nothing changed)"}\n`);
  for (const kind of Object.keys(SLACK_ID_LABEL) as SlackIdDecision["kind"][]) {
    const these = decisions.filter((d) => d.kind === kind);
    console.log(`${SLACK_ID_LABEL[kind]}: ${these.length}`);
    for (const d of these) {
      const where = `${d.personId} (${d.tab} row ${d.row})`;
      if (d.kind === "write") console.log(`  ${where} -> ${d.slackUserId}`);
      else if (d.kind === "conflict") console.log(`  ${where}: ${d.reason}`);
      else if (d.kind === "not_in_slack") console.log(`  ${where}`);
    }
  }
  if (parsed.problems.length) {
    console.log(
      `\n${parsed.problems.length} sheet problem(s); run "lifecycle plan" to see them.`
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
  if (!apply) {
    if (writes.length) console.log("\nRun again with --apply to fill them in.");
    return;
  }
  const result = await fillBlankCells(sheets, env.sheetId, writes);
  console.log(`\nFilled ${result.written.length} cell(s).`);
  for (const s of result.skipped) {
    console.log(`  skipped ${s.write.personId}: ${s.reason}; run it again`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "import-roster":
      if (!args[0]) throw new Error("import-roster needs a CSV path");
      importRoster(args[0]);
      return;
    case "import-consents":
      if (!args[0]) throw new Error("import-consents needs a CSV path");
      importConsents(args[0]);
      return;
    case "set-role":
      if (!args[0] || !args[1])
        throw new Error("set-role needs <email|U…> and a role");
      setRole(args[0], args[1]);
      return;
    case "sweep":
      console.log(JSON.stringify(await runSweep(), null, 2));
      return;
    case "backfill":
      console.log(JSON.stringify(await backfillAll(), null, 2));
      return;
    case "findings": {
      const status = (args[0] ?? "open") as
        "open" | "acknowledged" | "resolved";
      for (const f of listFindings(status)) {
        console.log(`#${f.id}\t${f.severity}\t${f.kind}\t${f.summary}`);
      }
      return;
    }
    case "export-conversation":
      if (!args[0])
        throw new Error("export-conversation needs a conversation id");
      exportConversation(args[0], args[1]);
      return;
    case "lifecycle":
      if (args[0] === "plan") await lifecyclePlan(args.slice(1));
      else if (args[0] === "slack-ids") await lifecycleSlackIds(args.slice(1));
      else throw new Error("usage: lifecycle plan|slack-ids");
      return;
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
