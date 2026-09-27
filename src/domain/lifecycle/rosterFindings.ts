import { dedupeKey, type NewFinding } from "../findings.js";
import type { Person } from "../people.js";
import type { RosterFinding, UndeclaredReason } from "./roster.js";

/**
 * What the roster plan's findings say in the alert channel, and the keys that
 * make each one the same finding from run to run. Pure, so the wording — and
 * the rule that it names a person and a Person ID, never an address — is
 * tested without Slack.
 *
 * All of these describe something currently true, so the run that no longer
 * sees one closes it: fix the sheet, and the finding goes. The held Make adult
 * is included: if the sheet stops saying Mentor, there is nothing left to
 * approve, and a button still offering it would change someone's monitoring
 * on a stale request.
 */

/** Keys the roster run owns, and may therefore close when it stops seeing them. */
export const ROSTER_FINDING_PREFIXES = [
  "sheet_undeclared:",
  "sheet_conflict:",
  "roster_drift:sheet:",
] as const;

export function rosterFindingKey(f: RosterFinding): string {
  switch (f.kind) {
    case "sheet_undeclared":
      return dedupeKey("sheet_undeclared", String(f.rosterId));
    case "roster_drift":
      return dedupeKey("roster_drift", "sheet", String(f.rosterId));
    case "sheet_conflict":
      return dedupeKey(
        "sheet_conflict",
        f.personId ?? "-",
        f.rosterId === null ? "-" : String(f.rosterId),
        f.reason
      );
  }
}

export const UNREADABLE_KEY = dedupeKey("lifecycle_unreadable");

type Names = {
  roster: ReadonlyMap<number, Person>;
  /** Sheet names by Person ID, for people with no roster row. */
  sheet: ReadonlyMap<string, string>;
};

/** "P0042 Jordan Lee", or "Jordan Lee (@them)" for a row not yet matched. */
function who(personId: string | null, rosterId: number | null, n: Names) {
  const row = rosterId === null ? undefined : n.roster.get(rosterId);
  // The sheet's name first: the roster's may be a Slack display name from
  // before the cutover.
  const name = (personId && n.sheet.get(personId)) || row?.full_name;
  if (personId) return name ? `${personId} ${name}` : personId;
  if (row) {
    return row.slack_user_id
      ? `${row.full_name} (<@${row.slack_user_id}>)`
      : row.full_name;
  }
  return `roster row ${rosterId}`;
}

function why(reason: UndeclaredReason): string {
  switch (reason.kind) {
    case "inactive":
      return "is Inactive on the lifecycle sheet";
    case "role":
      return reason.roles.length
        ? `is now ${reason.roles.join(" and ")} on the lifecycle sheet, not Student or Mentor`
        : "has no role on the lifecycle sheet";
    case "gone":
      return "has no row on the lifecycle sheet any more";
    case "not_on_sheet":
      return "is not on the lifecycle sheet";
  }
}

export function rosterFinding(f: RosterFinding, names: Names): NewFinding {
  const row = f.rosterId === null ? undefined : names.roster.get(f.rosterId);
  const base = {
    dedupeKey: rosterFindingKey(f),
    subjectPersonId: f.rosterId,
    subjectRef: row?.slack_user_id ?? f.personId,
    detail: { personId: f.personId, source: "lifecycle_sheet" },
  };
  const person = who(f.personId, f.rosterId, names);
  switch (f.kind) {
    case "sheet_undeclared":
      return {
        ...base,
        kind: "sheet_undeclared",
        severity: "warn",
        summary:
          `${person} ${why(f.reason)}. hawk-mod is still monitoring them as ` +
          `${f.role === "student" ? "a student" : "an adult"}, and will until ` +
          `someone ends it.`,
        detail: { ...base.detail, reason: f.reason },
      };
    case "roster_drift":
      return {
        ...base,
        kind: "roster_drift",
        severity: "warn",
        summary:
          `The lifecycle sheet says ${person} is a Mentor, but hawk-mod ` +
          `monitors them as a student. Nothing was changed: as an adult, ` +
          `their DMs with students would stop being treated as a student's.`,
      };
    case "sheet_conflict":
      return {
        ...base,
        kind: "sheet_conflict",
        severity: "warn",
        summary: `${person}: ${f.reason}. Nothing was changed; check the lifecycle sheet.`,
      };
  }
}

/**
 * The run could not read the sheet. The message is the sheet client's own —
 * a missing tab or column, or Google's error — which never carries the key.
 */
export function unreadableFinding(message: string): NewFinding {
  return {
    kind: "lifecycle_unreadable",
    dedupeKey: UNREADABLE_KEY,
    severity: "violation",
    summary:
      `hawk-mod could not read the lifecycle sheet (${message}). The roster ` +
      `was left as it was: nobody new is being added until this is fixed.`,
  };
}
