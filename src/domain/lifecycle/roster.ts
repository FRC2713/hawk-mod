import type { IsoDate } from "../dates.js";
import type { Person, Role } from "../people.js";
import type { MentorDetails, SheetPerson, StudentDetails } from "./sheet.js";
import type { SlackAccount } from "./slackIds.js";

/**
 * Step 3 of the lifecycle sync: hawk-mod's roster, kept in step with the
 * lifecycle sheet. Pure — roster rows, sheet people and Slack accounts in,
 * decisions out — so every row of the table in docs/lifecycle-sync.md ("What
 * applies, and what asks") is a test with plain objects.
 *
 * **Nothing here can make hawk-mod see less.** There is no decision that
 * deactivates a row, deletes one, or moves one out of `student`. Those are the
 * findings: `sheet_undeclared` (End monitoring) and `roster_drift` (Make
 * adult), each waiting for a person's click. Everything this applies on its
 * own either adds monitoring, or updates a fact — a name, an address, a date —
 * whose only effect on the rules is to make them stricter when it is blank.
 *
 * Output names Person IDs and roster ids, never an address: it is printed into
 * Slack, and most of the people in it are minors.
 */

/** The requirement dates the sheet owns, by the roster column they land in. */
export const MENTOR_DATE_FIELDS = {
  screening_expires_on: "screeningExpiry",
  training_expires_on: "yptExpiry",
  cori_expires_on: "coriExpiry",
  consent_release_expires_on: "consentReleaseExpiry",
  data_privacy_expires_on: "dataPrivacyExpiry",
  mentor_ready_completed_on: "mentorReadyCompleted",
} as const satisfies Record<string, keyof MentorDetails>;

export type DateField =
  keyof typeof MENTOR_DATE_FIELDS | "slack_consent_expires_on";

export type DateValues = Partial<Record<DateField, IsoDate | null>>;

/** The fields of an existing row the sync may change on its own. */
export type RowUpdate = {
  /** Stamp the sheet's Person ID: the row is matched, and keyed by it now. */
  person_id?: string;
  full_name?: string;
  email?: string | null;
  slack_user_id?: string;
  /** Only ever `student`: moving someone into monitoring needs no one. */
  role?: "student";
  /** Only ever on: the sheet declares them again, so monitoring resumes. */
  reactivate?: true;
  dates?: DateValues;
};

export type RosterChange =
  | {
      kind: "create";
      personId: string;
      role: "student" | "adult";
      fullName: string;
      email: string | null;
      slackUserId: string | null;
      dates: DateValues;
    }
  | { kind: "update"; rosterId: number; personId: string; set: RowUpdate };

/** Why the sheet no longer declares someone hawk-mod still monitors. */
export type UndeclaredReason =
  | { kind: "inactive" }
  /** Neither Student nor Mentor any more — typically, now Alumni. */
  | { kind: "role"; roles: string[] }
  /** Their Person ID is not on the sheet any more. */
  | { kind: "gone" }
  /** Never matched to anyone on the sheet. */
  | { kind: "not_on_sheet" };

export type RosterFinding =
  /** Still monitored, until someone clicks End monitoring. */
  | {
      kind: "sheet_undeclared";
      rosterId: number;
      personId: string | null;
      role: Role;
      reason: UndeclaredReason;
    }
  /** The sheet says Mentor; hawk-mod monitors a student. Make adult waits. */
  | { kind: "roster_drift"; rosterId: number; personId: string }
  /** Something only a person can untangle. Nothing it touches was changed. */
  | {
      kind: "sheet_conflict";
      personId: string | null;
      rosterId: number | null;
      reason: string;
    };

export type RosterPlan = {
  changes: RosterChange[];
  findings: RosterFinding[];
  /**
   * Active roster rows with a Slack account that match nobody on the sheet.
   * On the first apply these refuse it: creating a fresh row for such a
   * person would make them two rows, one holding their Slack account and one
   * holding their screening.
   */
  unmatchedWithSlack: number[];
  /** Set when the plan must not be applied, and why. */
  refused: string | null;
};

type Sided = {
  s: SheetPerson;
  /** The role the sheet declares, or null when it declares no monitoring. */
  declares: "student" | "adult" | null;
  /** Both Student and Mentor: too ambiguous to act on at all. */
  ambiguous: boolean;
  /** The details row carrying their identity email and Slack User ID. */
  details: MentorDetails | StudentDetails | null;
  email: string | null;
  slackId: string | null;
  /** The sheet contradicts itself about them; see the sheet_conflict. */
  conflicted: boolean;
};

function lower(s: string | null | undefined): string | null {
  return s ? s.toLowerCase() : null;
}

function identity(s: SheetPerson): Omit<Sided, "slackId" | "s" | "conflicted"> {
  const student = s.roles.includes("Student");
  const mentor = s.roles.includes("Mentor");
  // Inactive settles it whatever the roles say: they are leaving, and the
  // End monitoring question is the same one either way.
  const ambiguous = student && mentor && s.status !== "inactive";
  const monitored = s.status !== "inactive" && !ambiguous;
  const declares = !monitored
    ? null
    : student
      ? "student"
      : mentor
        ? "adult"
        : null;
  // The identity address is the one the declared role owns. Someone the
  // sheet no longer declares — an alum — keeps whichever they had.
  const details: MentorDetails | StudentDetails | null =
    (declares === "student" ? s.student : null) ??
    (declares === "adult" ? s.mentor : null) ??
    (declares === null ? (s.mentor ?? s.student) : null);
  const email =
    details === null
      ? null
      : "rhrEmail" in details
        ? details.rhrEmail
        : details.schoolEmail;
  return { declares, ambiguous, details, email: lower(email) };
}

/** The dates a sheet person's details rows say, blanks included. */
function sheetDates(s: SheetPerson): DateValues {
  const dates: DateValues = {};
  // No details row means the sheet said nothing, not that it said blank: the
  // dates on record stay.
  if (s.mentor) {
    for (const [field, key] of Object.entries(MENTOR_DATE_FIELDS)) {
      dates[field as keyof typeof MENTOR_DATE_FIELDS] = s.mentor[
        key
      ] as IsoDate | null;
    }
  }
  if (s.student) dates.slack_consent_expires_on = s.student.slackConsentExpiry;
  return dates;
}

function changedDates(r: Person, dates: DateValues): DateValues {
  const out: DateValues = {};
  for (const [field, value] of Object.entries(dates) as [
    DateField,
    IsoDate | null,
  ][]) {
    if (r[field] !== value) out[field] = value;
  }
  return out;
}

/**
 * Plans one run. `firstApply` is true until the roster has been built from the
 * sheet once — the cutover — and is what makes unmatched Slack accounts refuse
 * the plan rather than raise findings.
 */
export function planRoster(args: {
  roster: readonly Person[];
  sheet: readonly SheetPerson[];
  accounts: readonly SlackAccount[];
  firstApply: boolean;
}): RosterPlan {
  const changes: RosterChange[] = [];
  const findings: RosterFinding[] = [];
  const conflict = (
    personId: string | null,
    rosterId: number | null,
    reason: string
  ) => findings.push({ kind: "sheet_conflict", personId, rosterId, reason });

  const liveIds = new Set(args.accounts.filter((a) => a.live).map((a) => a.id));
  const liveByEmail = new Map<string, string>();
  for (const a of args.accounts) {
    if (a.live && a.email) liveByEmail.set(a.email.toLowerCase(), a.id);
  }

  // --- Each sheet person's identity, and the Slack account it points at.
  const sided: Sided[] = args.sheet.map((s) => {
    const id = identity(s);
    const typed = id.details?.slackUserId ?? null;
    let slackId: string | null = null;
    let conflicted = false;
    if (id.ambiguous) {
      conflicted = true;
      conflict(
        s.personId,
        null,
        "the sheet lists them as both Student and Mentor"
      );
    } else if (typed) {
      // Typing an ID is the statement, so it is trusted even when that
      // account's email is not the identity email — that is exactly why a
      // person types one. Refused only when it is not a live account.
      if (liveIds.has(typed)) slackId = typed;
      else if (id.declares) {
        conflicted = true;
        conflict(
          s.personId,
          null,
          "the Slack User ID on the sheet is not an active Slack account"
        );
      }
    } else if (id.email) {
      slackId = liveByEmail.get(id.email) ?? null;
    }
    return { s, ...id, slackId, conflicted };
  });

  // One Slack account, one address: if two sheet people claim the same one,
  // neither is used until someone sorts out which is which.
  for (const key of ["slackId", "email"] as const) {
    const claims = new Map<string, Sided[]>();
    for (const x of sided) {
      const v = x[key];
      if (v) claims.set(v, [...(claims.get(v) ?? []), x]);
    }
    for (const [, xs] of claims) {
      if (xs.length < 2) continue;
      for (const x of xs) {
        x[key] = null;
        x.conflicted = true;
        conflict(
          x.s.personId,
          null,
          key === "slackId"
            ? `the same Slack account is on more than one row (${xs.map((y) => y.s.personId).join(", ")})`
            : `the same identity email is on more than one row (${xs.map((y) => y.s.personId).join(", ")})`
        );
      }
    }
  }

  const byPersonId = new Map(sided.map((x) => [x.s.personId, x]));
  const bySlack = new Map<string, Sided>();
  const byEmail = new Map<string, Sided>();
  for (const x of sided) {
    if (x.slackId) bySlack.set(x.slackId, x);
    if (x.email) byEmail.set(x.email, x);
  }

  // --- Match each roster row to a sheet person. A stamped Person ID is the
  // key; otherwise the Slack account, then the identity email, and nothing
  // looser — a wrong match puts one person's monitoring on someone else.
  const matchOf = new Map<number, Sided>();
  const inConflict = new Set<number>();
  const stamped = new Set(
    args.roster.flatMap((r) => (r.person_id ? [r.person_id] : []))
  );
  for (const r of args.roster) {
    if (r.person_id) {
      const x = byPersonId.get(r.person_id);
      if (x) matchOf.set(r.id, x);
      continue;
    }
    const viaSlack = r.slack_user_id ? bySlack.get(r.slack_user_id) : undefined;
    const viaEmail = r.email ? byEmail.get(r.email.toLowerCase()) : undefined;
    if (viaSlack && viaEmail && viaSlack !== viaEmail) {
      inConflict.add(r.id);
      conflict(
        null,
        r.id,
        `roster row ${r.id}'s Slack account is ${viaSlack.s.personId}'s, but its email is ${viaEmail.s.personId}'s`
      );
      continue;
    }
    const x = viaSlack ?? viaEmail;
    if (!x) continue;
    if (!viaSlack && r.slack_user_id && x.slackId) {
      // Matched by email, but the two sides name different Slack accounts.
      inConflict.add(r.id);
      conflict(
        x.s.personId,
        r.id,
        `roster row ${r.id} has the same email but a different Slack account`
      );
      continue;
    }
    if (stamped.has(x.s.personId)) {
      inConflict.add(r.id);
      conflict(
        x.s.personId,
        r.id,
        `roster row ${r.id} matches a Person ID already on another roster row`
      );
      continue;
    }
    matchOf.set(r.id, x);
  }
  // Two rows on one person: neither is matched.
  const rowsFor = new Map<Sided, Person[]>();
  for (const r of args.roster) {
    const x = matchOf.get(r.id);
    if (x) rowsFor.set(x, [...(rowsFor.get(x) ?? []), r]);
  }
  for (const [x, rs] of rowsFor) {
    if (rs.length < 2) continue;
    for (const r of rs) {
      matchOf.delete(r.id);
      inConflict.add(r.id);
    }
    conflict(
      x.s.personId,
      null,
      `roster rows ${rs.map((r) => r.id).join(" and ")} both match this person`
    );
  }

  // What the rest of the roster already holds, so no update or new row
  // collides with another row's Slack account or address.
  const heldSlack = new Map<string, number>();
  const heldEmail = new Map<string, number>();
  for (const r of args.roster) {
    if (r.slack_user_id) heldSlack.set(r.slack_user_id, r.id);
    if (r.email) heldEmail.set(r.email.toLowerCase(), r.id);
  }
  const takenBySomeoneElse = (
    held: Map<string, number>,
    value: string,
    self: number | null
  ) => {
    const owner = held.get(value);
    return owner !== undefined && owner !== self;
  };

  // --- Matched rows.
  const matchedSheet = new Set<Sided>();
  for (const r of args.roster) {
    const x = matchOf.get(r.id);
    if (!x) continue;
    matchedSheet.add(x);
    const personId = x.s.personId;

    // Already reported; too ambiguous to change anything.
    if (x.ambiguous) continue;

    const set: RowUpdate = {};
    if (!r.person_id) set.person_id = personId;
    if (x.s.name && x.s.name !== r.full_name) set.full_name = x.s.name;

    // Identity email, and the Slack account, only when the sheet has a
    // details row to say so.
    if (x.details) {
      if (lower(r.email) !== x.email) {
        if (x.email && takenBySomeoneElse(heldEmail, x.email, r.id)) {
          conflict(
            personId,
            r.id,
            "their identity email is on another roster row"
          );
        } else {
          set.email = x.email;
        }
      }
      if (x.slackId && x.slackId !== r.slack_user_id) {
        if (r.slack_user_id) {
          conflict(
            personId,
            r.id,
            "the Slack User ID on the sheet is a different account from the one hawk-mod has"
          );
        } else if (takenBySomeoneElse(heldSlack, x.slackId, r.id)) {
          conflict(
            personId,
            r.id,
            "their Slack account is on another roster row"
          );
        } else {
          set.slack_user_id = x.slackId;
        }
      }
    }

    const dates = changedDates(r, sheetDates(x.s));
    if (Object.keys(dates).length) set.dates = dates;

    if (x.declares === null) {
      if (r.active === 1 && r.role !== "district_observer") {
        findings.push({
          kind: "sheet_undeclared",
          rosterId: r.id,
          personId,
          role: r.role,
          reason:
            x.s.status === "inactive"
              ? { kind: "inactive" }
              : { kind: "role", roles: [...x.s.roles] },
        });
      }
    } else {
      if (r.active !== 1) set.reactivate = true;
      if (x.declares === "student" && r.role !== "student")
        set.role = "student";
      if (x.declares === "adult" && r.role === "student") {
        findings.push({ kind: "roster_drift", rosterId: r.id, personId });
      }
    }

    if (Object.keys(set).length) {
      changes.push({ kind: "update", rosterId: r.id, personId, set });
    }
  }

  // --- Roster rows the sheet does not have.
  const unmatchedWithSlack: number[] = [];
  for (const r of args.roster) {
    if (matchOf.has(r.id) || inConflict.has(r.id)) {
      if (inConflict.has(r.id) && r.active === 1 && r.slack_user_id) {
        unmatchedWithSlack.push(r.id);
      }
      continue;
    }
    // The sheet has no district observers; being absent from it is normal.
    if (r.role === "district_observer" || r.active !== 1) continue;
    if (r.slack_user_id) unmatchedWithSlack.push(r.id);
    findings.push({
      kind: "sheet_undeclared",
      rosterId: r.id,
      personId: r.person_id,
      role: r.role,
      reason: r.person_id ? { kind: "gone" } : { kind: "not_on_sheet" },
    });
  }

  // --- Sheet people with no roster row: created, if the sheet declares them.
  for (const x of sided) {
    if (matchedSheet.has(x) || x.declares === null) continue;
    if (stamped.has(x.s.personId)) continue;
    // Not while the sheet contradicts itself about them: a row created
    // without the Slack account the sheet could not settle becomes the second
    // row for someone the roster already has. Their sheet_conflict says so.
    if (x.conflicted) continue;
    if (x.slackId && heldSlack.has(x.slackId)) {
      conflict(
        x.s.personId,
        heldSlack.get(x.slackId)!,
        "their Slack account is on a roster row that did not match them"
      );
      continue;
    }
    if (x.email && heldEmail.has(x.email)) {
      conflict(
        x.s.personId,
        heldEmail.get(x.email)!,
        "their identity email is on a roster row that did not match them"
      );
      continue;
    }
    const dates = sheetDates(x.s);
    changes.push({
      kind: "create",
      personId: x.s.personId,
      role: x.declares,
      fullName: x.s.name || x.s.personId,
      email: x.email,
      slackUserId: x.slackId,
      dates,
    });
  }

  const refused =
    args.firstApply && unmatchedWithSlack.length
      ? `${unmatchedWithSlack.length} roster row(s) with a Slack account match ` +
        "nobody on the lifecycle sheet. Type each one's Slack User ID into " +
        "the sheet, then run it again."
      : null;

  return { changes, findings, unmatchedWithSlack, refused };
}
