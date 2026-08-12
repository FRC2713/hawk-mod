import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync } from "node:fs";
import { db } from "../db/client.js";
import {
  getConversation,
  insertConsent,
  listFindings,
  personByEmail,
  personBySlackId,
  setPersonRole,
  upsertPerson,
} from "../db/repo.js";
import { defaultExpiry } from "../domain/rules/consent.js";
import { ROLES, type Role } from "../domain/people.js";
import { backfillAll } from "../monitor/backfill.js";
import { runSweep } from "../jobs/sweep.js";

const USAGE = `hawk-mod cli

  import-roster <file.csv>     email,full_name,role,ypp_completed_on,
                               ypt_completed_on,mentor_ready_on,
                               cori_completed_on,active,notes
  import-consents <file.csv>   email,signed_on,form_version,guardian_name,
                               guardian_email,document_ref,recorded_by[,expires_on]
  set-role <email|U…> <role>   role: student|adult|lead_coach|admin|
                               district_observer. Bootstraps the first Lead
                               Coach, since /hawkmod needs one to exist.
  sweep                        run the compliance sweep
  backfill                     walk enrolled adults' DM history
  findings [status]            list findings (default: open)
  export-conversation <id> [out.json]
                               produce one conversation's full log
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
    upsertPerson({
      email: r.email,
      fullName: r.full_name,
      role,
      active: r.active === undefined ? true : r.active !== "0",
      yppCompletedOn: optional(r.ypp_completed_on),
      yptCompletedOn: optional(r.ypt_completed_on),
      mentorReadyOn: optional(r.mentor_ready_on),
      coriCompletedOn: optional(r.cori_completed_on),
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
 * The user group sync only ever assigns `student` or `adult`, so the first
 * Lead Coach has to be set from outside Slack — otherwise nobody can run
 * /hawkmod at all. Recorded in role_changes like any other role change.
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
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
