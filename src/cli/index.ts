import { writeFileSync } from "node:fs";
import { db } from "../db/client.js";
import {
  getConversation,
  listFindings,
  personByEmail,
  personBySlackId,
  setPersonRole,
} from "../db/repo.js";
import { backfillAll } from "../monitor/backfill.js";
import { runSweep } from "../jobs/sweep.js";
import {
  lifecyclePlanReport,
  rosterReport,
  rosterSync,
  slackIdsReport,
} from "../lifecycle/run.js";
import { botClient } from "../slack/tokens.js";

const USAGE = `hawk-mod cli

  set-role <email|U…> <role>   district_observer, or back to adult from it —
                               the one role the lifecycle sheet has no word
                               for. Everything else comes from the sheet.
                               Nothing here grants access to /hawkmod — that
                               is Slack's Owner/Admin, read live.
  sweep                        run the compliance sweep
  backfill                     walk enrolled adults' DM history
  findings [status]            list findings (default: open)
  export-conversation <id> [out.json]
                               produce one conversation's full log
  lifecycle plan [--members]   read the lifecycle sheet and print what a sync
                               would do. Changes nothing. Needs
                               GOOGLE_SERVICE_ACCOUNT_KEY_FILE (or _BASE64)
                               and LIFECYCLE_SHEET_ID; --members lists
                               addresses
  lifecycle slack-ids [--apply]
                               match sheet people to Slack accounts by email
                               and show which Slack User ID cells would be
                               filled; --apply fills them. Only ever fills a
                               blank cell. Needs the Slack install too
  lifecycle roster [--apply]   what building the roster from the sheet would
                               change, and what it would ask about; --apply
                               makes the changes. Needs the Slack install too
  lifecycle sync               what the hourly job does: apply the roster from
                               the sheet and write Slack User IDs back. Does
                               nothing until the first roster --apply
`;

/** Retired at the cutover; the sheet is where these facts live now. */
const FROM_THE_SHEET =
  "Roles, screening dates and consent come from the lifecycle sheet now. " +
  "Edit the sheet, then run `lifecycle sync` (or wait for the hourly run).";

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
 * `district_observer` (§8) is the one role the lifecycle sheet has no word
 * for, so it is set here, and only between it and `adult` — which the rules
 * treat alike. Never to or from `student`: that is the sheet's, and moving
 * someone out of it lowers monitoring, which only a Make adult click may do.
 * Recorded in role_changes like any other role change.
 */
function setRole(who: string, role: string) {
  if (role !== "district_observer" && role !== "adult") {
    throw new Error(
      `set-role sets district_observer or adult. ${FROM_THE_SHEET}`
    );
  }
  const person = who.startsWith("U")
    ? (personBySlackId(who) ?? personByEmail(who))
    : personByEmail(who);
  if (!person) throw new Error(`No roster entry for ${who}.`);
  if (person.role === role) {
    console.log(`${person.full_name} is already ${role}.`);
    return;
  }
  if (person.role === "student") {
    throw new Error(`${person.full_name} is a student. ${FROM_THE_SHEET}`);
  }
  setPersonRole({
    personId: person.id,
    toRole: role,
    source: "cli",
    detail: { via: "set-role" },
  });
  console.log(`${person.full_name}: ${person.role} -> ${role}`);
}

async function lifecyclePlan(args: string[]) {
  console.log(
    await lifecyclePlanReport({ members: args.includes("--members") })
  );
}

async function lifecycleSlackIds(args: string[]) {
  console.log(
    await slackIdsReport({
      slack: botClient(),
      apply: args.includes("--apply"),
      applyHint: "run again with --apply",
      by: "cli",
    })
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "import-roster":
    case "import-consents":
      throw new Error(FROM_THE_SHEET);
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
      else if (args[0] === "roster")
        console.log(
          await rosterReport({
            slack: botClient(),
            apply: args.includes("--apply"),
            applyHint: "run again with --apply",
            by: "cli",
          })
        );
      else if (args[0] === "sync")
        console.log(await rosterSync({ slack: botClient(), by: "cli" }));
      else throw new Error("usage: lifecycle plan|slack-ids|roster|sync");
      return;
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
