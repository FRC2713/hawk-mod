import type { Person } from "../people.js";
import { labelOf, shortNameOf, type PersonLabels } from "./labels.js";
import type {
  DateField,
  RosterChange,
  RosterFinding,
  RosterPlan,
  UndeclaredReason,
} from "./roster.js";

/**
 * The roster plan as text, for `/hawkmod lifecycle roster` and the CLI.
 *
 * It names each person by Person ID, short name and role (`labels.ts`), with
 * their roster row where it helps, plus Slack User IDs, fields and dates. It
 * is an ephemeral reply to an administrator, and the hourly run discards it;
 * the name is there so whoever is about to apply it can check who it changes
 * without opening the sheet. A row the sheet does not have — its Person ID
 * gone, or none yet — is named from the roster's own name, cut down the same
 * way, and is only `row N` when that is all there is. Never an address. What
 * a field changes *to* is shown only for dates, and every date that would be
 * cleared is listed, because a cleared date is the one change here that makes
 * someone count as unscreened.
 */

const DATE_LABEL: Record<DateField, string> = {
  screening_expires_on: "Background Screening",
  training_expires_on: "YPT",
  cori_expires_on: "CORI",
  consent_release_expires_on: "Consent & Release",
  data_privacy_expires_on: "Data Privacy",
  mentor_ready_completed_on: "Mentor Ready",
  slack_consent_expires_on: "Slack Consent",
};

type Update = Extract<RosterChange, { kind: "update" }>;
type Create = Extract<RosterChange, { kind: "create" }>;

function undeclared(reason: UndeclaredReason): string {
  switch (reason.kind) {
    case "inactive":
      return "Inactive on the sheet";
    case "role":
      return reason.roles.length
        ? `now ${reason.roles.join(" and ")}, not Student or Mentor`
        : "has no role on the sheet";
    case "gone":
      return "their Person ID is no longer on the sheet";
    case "not_on_sheet":
      return "matches nobody on the sheet";
  }
}

function section(lines: string[], title: string, items: string[], indent = "") {
  lines.push(`${indent}${title}: ${items.length}`);
  for (const i of items) lines.push(`${indent}  ${i}`);
}

export function formatRosterPlan(args: {
  plan: RosterPlan;
  roster: readonly Person[];
  /** Person ID → label, from the sheet (`personLabels`). */
  labels: PersonLabels;
  /** Sheet problems the parser reported, by count; `lifecycle plan` lists them. */
  sheetProblems: number;
  /** True when nothing was applied; the heading says so. */
  dryRun: boolean;
}): string {
  const { plan } = args;
  const rowById = new Map(args.roster.map((r) => [r.id, r]));
  // A row with no Person ID yet is named from the roster; its Slack ID is
  // something `/hawkmod whois` can turn into the whole person.
  const who = (personId: string | null, rosterId: number | null): string => {
    const r = rosterId === null ? undefined : rowById.get(rosterId);
    if (personId) {
      const label = labelOf(args.labels, personId, r?.full_name);
      return rosterId === null ? label : `${label}, row ${rosterId}`;
    }
    const parts = [
      shortNameOf(r?.full_name),
      rosterId === null ? null : `row ${rosterId}`,
      r?.slack_user_id ? `Slack ${r.slack_user_id}` : null,
    ].filter(Boolean);
    return parts.join(", ");
  };
  const label = (personId: string) => labelOf(args.labels, personId);
  const updates = plan.changes.filter((c): c is Update => c.kind === "update");
  const creates = plan.changes.filter((c): c is Create => c.kind === "create");

  const lines = [
    `Roster from the lifecycle sheet${args.dryRun ? " (dry run: nothing changed)" : ""}`,
    "",
  ];

  if (plan.refused) lines.push(`WOULD BE REFUSED: ${plan.refused}`, "");

  section(
    lines,
    "Rows matched to a Person ID for the first time",
    updates
      .filter((u) => u.set.person_id)
      .map((u) => `row ${u.rosterId} -> ${label(u.personId)}`)
  );

  const students = creates.filter((c) => c.role === "student");
  section(
    lines,
    `New rows (${students.length} student, ${creates.length - students.length} adult)`,
    creates.map(
      (c) =>
        `${label(c.personId)}, ${c.role}` +
        (c.slackUserId ? `, Slack ${c.slackUserId}` : ", not in Slack yet") +
        (c.email ? "" : ", no identity email on the sheet")
    )
  );

  section(
    lines,
    "Changed to student",
    updates.filter((u) => u.set.role).map((u) => who(u.personId, u.rosterId))
  );
  section(
    lines,
    "Monitored again (reactivated)",
    updates
      .filter((u) => u.set.reactivate)
      .map((u) => who(u.personId, u.rosterId))
  );
  section(
    lines,
    "Slack accounts linked",
    updates
      .filter((u) => u.set.slack_user_id)
      .map((u) => `${who(u.personId, u.rosterId)} -> ${u.set.slack_user_id}`)
  );

  const names = updates.filter((u) => u.set.full_name !== undefined).length;
  const emails = updates.filter((u) => u.set.email !== undefined);
  lines.push(`Names updated: ${names}`);
  section(
    lines,
    "Identity emails updated",
    emails.map(
      (u) =>
        who(u.personId, u.rosterId) +
        (u.set.email === null ? " (cleared: the sheet has none)" : "")
    )
  );

  // Dates: every one that would be cleared by name; the rest by count.
  const cleared: string[] = [];
  const setCount: Partial<Record<DateField, number>> = {};
  for (const u of updates) {
    const was = rowById.get(u.rosterId);
    for (const [field, to] of Object.entries(u.set.dates ?? {}) as [
      DateField,
      string | null,
    ][]) {
      if (to === null) {
        cleared.push(
          `${who(u.personId, u.rosterId)}: ${DATE_LABEL[field]} ${was?.[field] ?? "?"} -> blank`
        );
      } else {
        setCount[field] = (setCount[field] ?? 0) + 1;
      }
    }
  }
  const set = Object.entries(setCount).map(
    ([f, n]) => `${DATE_LABEL[f as DateField]} ${n}`
  );
  lines.push(`Dates set or changed: ${set.length ? set.join(", ") : "none"}`);
  section(lines, "Dates cleared (the sheet has them blank)", cleared);

  lines.push("", "Would ask a person (findings):");
  const byKind = (k: RosterFinding["kind"]) =>
    plan.findings.filter((f) => f.kind === k);
  section(
    lines,
    "Still monitored, sheet no longer declares them [End monitoring]",
    byKind("sheet_undeclared").map((f) =>
      f.kind === "sheet_undeclared"
        ? `${who(f.personId, f.rosterId)} ${f.role}: ${undeclared(f.reason)}`
        : ""
    ),
    "  "
  );
  section(
    lines,
    "Sheet says Mentor, monitored as a student [Make adult]",
    byKind("roster_drift").map((f) =>
      f.kind === "roster_drift" ? who(f.personId, f.rosterId) : ""
    ),
    "  "
  );
  section(
    lines,
    "Needs someone to check the sheet",
    byKind("sheet_conflict").map((f) =>
      f.kind === "sheet_conflict"
        ? `${who(f.personId, f.rosterId)}: ${f.reason}`
        : ""
    ),
    "  "
  );

  if (args.sheetProblems) {
    lines.push(
      "",
      `${args.sheetProblems} sheet problem(s); \`lifecycle plan\` lists them.`
    );
  }
  return lines.join("\n");
}
