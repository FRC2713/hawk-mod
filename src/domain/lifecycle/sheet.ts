import type { IsoDate } from "../dates.js";
import type { Header, SheetData, SheetRow, SheetTab } from "./schema.js";

/**
 * What the lifecycle sheet says about one person, reassembled from its tabs.
 *
 * Vocabulary is the sheet's, not the roster's: `Mentor` here is a sheet role,
 * and becomes a roster `adult` only in the roster sync. Volunteers and alumni
 * are people here and nowhere in hawk-mod's roster — they are not in Slack.
 */
export const SHEET_ROLES = [
  "Mentor",
  "Volunteer",
  "Alumni",
  "Student",
] as const;
export type SheetRole = (typeof SHEET_ROLES)[number];

export const ADMIN_ROLES = ["Groups Admin", "Help Desk Admin"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/**
 * `unknown` is a blank or unrecognised Active/Inactive cell. It is kept
 * distinct rather than defaulted either way: defaulting to active would put a
 * departed person back into groups, defaulting to inactive would pull a current
 * one out. Each consumer decides what unknown means for it.
 */
export type SheetStatus = "active" | "inactive" | "unknown";

export type MentorDetails = {
  rhrEmail: string | null;
  slackUserId: string | null;
  /** Blocking: Youth Protection Training. Annual, to 1 August. */
  yptExpiry: IsoDate | null;
  /** Blocking: FIRST's background screening. Three years. */
  screeningExpiry: IsoDate | null;
  /** Blocking: CORI + fingerprints (Massachusetts). Three years. */
  coriExpiry: IsoDate | null;
  /** Reported only. */
  consentReleaseExpiry: IsoDate | null;
  /** Reported only. */
  dataPrivacyExpiry: IsoDate | null;
  /** Reported only; a one-time badge, so a completion date. */
  mentorReadyCompleted: IsoDate | null;
  lead: boolean;
  ra: boolean;
};

export type StudentDetails = {
  schoolEmail: string | null;
  slackUserId: string | null;
  lead: boolean;
  slackConsentExpiry: IsoDate | null;
};

export type SheetPerson = {
  /** `P####`. The only key; never reused. */
  personId: string;
  /** Preferred first name (else legal) and legal last name. */
  name: string;
  personalEmail: string | null;
  status: SheetStatus;
  roles: SheetRole[];
  mentor: MentorDetails | null;
  student: StudentDetails | null;
  adminRoles: AdminRole[];
};

/**
 * Something wrong with the sheet that a person should fix. Names a Person ID
 * and a cell, never a value: these are printed and will be posted, and the
 * value might be a minor's email.
 */
export type SheetProblem = {
  personId: string | null;
  tab: SheetTab;
  row: number;
  message: string;
};

export type ParsedSheet = {
  people: SheetPerson[];
  problems: SheetProblem[];
};

/**
 * P0001–P0003 are the sheet's own placeholder rows, and the sheet says those
 * IDs are never reused. Reading them as people would put "Maya Johnson" in
 * grp-students.
 */
export const SAMPLE_PERSON_IDS: ReadonlySet<string> = new Set([
  "P0001",
  "P0002",
  "P0003",
]);

const PERSON_ID = /^P\d{4}$/;
const SLACK_ID = /^[UW][A-Z0-9]{2,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Enough of a row to point a problem at it. */
type RowRef = { readonly _row: number };

/** Collects problems for one parse; the helpers below report through it. */
class Problems {
  readonly list: SheetProblem[] = [];
  add(tab: SheetTab, row: number, personId: string | null, message: string) {
    this.list.push({ tab, row, personId, message });
  }
}

function date(
  raw: string,
  column: string,
  tab: SheetTab,
  row: RowRef,
  personId: string,
  problems: Problems
): IsoDate | null {
  if (raw === "") return null;
  if (ISO_DATE.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) return raw;
  }
  problems.add(tab, row._row, personId, `${column} is not a YYYY-MM-DD date`);
  return null;
}

function email(
  raw: string,
  column: string,
  tab: SheetTab,
  row: RowRef,
  personId: string,
  problems: Problems
): string | null {
  if (raw === "") return null;
  if (EMAIL.test(raw)) return raw.toLowerCase();
  problems.add(tab, row._row, personId, `${column} is not an email address`);
  return null;
}

function slackId(
  raw: string,
  tab: SheetTab,
  row: RowRef,
  personId: string,
  problems: Problems
): string | null {
  if (raw === "") return null;
  if (SLACK_ID.test(raw)) return raw;
  problems.add(tab, row._row, personId, "Slack User ID is not a Slack user ID");
  return null;
}

/** Blank reads as N, per the sheet's own default for these flags. */
function yesNo(
  raw: string,
  column: string,
  tab: SheetTab,
  row: RowRef,
  personId: string,
  problems: Problems
): boolean {
  if (raw === "Y") return true;
  if (raw === "N" || raw === "") return false;
  problems.add(tab, row._row, personId, `${column} is not Y or N`);
  return false;
}

/**
 * Rows of an extension tab, keyed by Person ID. A malformed ID, a sample ID, an
 * ID the People tab does not have, or a second row for the same person is a
 * problem and the row is skipped — the first row for a person wins.
 */
function keyed<T extends SheetTab>(
  tab: T,
  rows: SheetRow<T>[],
  known: ReadonlySet<string>,
  problems: Problems,
  { unique }: { unique: boolean }
): Map<string, SheetRow<T>[]> {
  const byId = new Map<string, SheetRow<T>[]>();
  for (const row of rows) {
    const id = (row as unknown as { "Person ID": string })["Person ID"];
    if (id === "" || SAMPLE_PERSON_IDS.has(id)) continue;
    if (!known.has(id)) {
      problems.add(
        tab,
        row._row,
        PERSON_ID.test(id) ? id : null,
        "Person ID is not on the People tab"
      );
      continue;
    }
    const existing = byId.get(id);
    if (existing && unique) {
      problems.add(tab, row._row, id, `second ${tab} row for this person`);
      continue;
    }
    byId.set(id, [...(existing ?? []), row]);
  }
  return byId;
}

function isBlank(row: object): boolean {
  return Object.entries(row).every(([k, v]) => k === "_row" || v === "");
}

/**
 * Sheet rows in, people and problems out. Pure: no Google, no database.
 *
 * A problem never stops the parse — one typo must not block the sync for the
 * whole team. The row or cell in question is skipped or read as blank, and the
 * problem is reported, so the result is always "what the sheet clearly says"
 * plus a list of what it did not say clearly. A shape problem (a missing
 * column) is different, and is refused before this runs.
 */
export function parseSheet(data: SheetData): ParsedSheet {
  const problems = new Problems();

  // People first: every other tab hangs off a Person ID this tab defines.
  const people = new Map<string, SheetPerson>();
  let sawSample = false;
  for (const row of data.People) {
    if (isBlank(row)) continue;
    const id = row["Person ID"];
    if (SAMPLE_PERSON_IDS.has(id)) {
      sawSample = true;
      continue;
    }
    if (!PERSON_ID.test(id)) {
      problems.add("People", row._row, null, "Person ID is not P####");
      continue;
    }
    if (people.has(id)) {
      problems.add("People", row._row, id, "Person ID appears twice");
      continue;
    }
    const first = row["Preferred First Name"] || row["Legal First Name"];
    const name = [first, row["Legal Last Name"]].filter(Boolean).join(" ");
    if (!name) problems.add("People", row._row, id, "no name");
    const rawStatus = row["Active/Inactive"];
    const status: SheetStatus =
      rawStatus === "Active"
        ? "active"
        : rawStatus === "Inactive"
          ? "inactive"
          : "unknown";
    if (status === "unknown") {
      problems.add(
        "People",
        row._row,
        id,
        "Active/Inactive is blank or unknown"
      );
    }
    people.set(id, {
      personId: id,
      name: name || id,
      personalEmail: email(
        row["Personal Email"],
        "Personal Email",
        "People",
        row,
        id,
        problems
      ),
      status,
      roles: [],
      mentor: null,
      student: null,
      adminRoles: [],
    });
  }
  if (sawSample) {
    problems.add(
      "People",
      0,
      null,
      "sample people P0001–P0003 are still in the sheet; they are ignored, " +
        "and the sheet says to delete them"
    );
  }
  const known = new Set(people.keys());

  for (const [id, rows] of keyed(
    "People_Roles",
    data.People_Roles.filter((r) => !isBlank(r)),
    known,
    problems,
    { unique: false }
  )) {
    const person = people.get(id)!;
    for (const row of rows) {
      const role = row.Role as SheetRole;
      if (!SHEET_ROLES.includes(role)) {
        problems.add("People_Roles", row._row, id, "Role is not a known role");
      } else if (!person.roles.includes(role)) {
        person.roles.push(role);
      }
    }
  }

  for (const [id, [row]] of keyed(
    "Mentor_Details",
    data.Mentor_Details.filter((r) => !isBlank(r)),
    known,
    problems,
    { unique: true }
  )) {
    const tab = "Mentor_Details";
    const r = row!;
    const d = (column: Header<"Mentor_Details">) =>
      date(r[column], column, tab, r, id, problems);
    people.get(id)!.mentor = {
      rhrEmail: email(r["RHR Email"], "RHR Email", tab, r, id, problems),
      slackUserId: slackId(r["Slack User ID"], tab, r, id, problems),
      yptExpiry: d("YPT Expiry"),
      screeningExpiry: d("Background Screening Expiry"),
      coriExpiry: d("CORI Expiry"),
      consentReleaseExpiry: d("Consent & Release Expiry"),
      dataPrivacyExpiry: d("Data Privacy Expiry"),
      mentorReadyCompleted: d("Mentor Ready Completed"),
      lead: yesNo(
        r["Mentor Lead (Y/N)"],
        "Mentor Lead (Y/N)",
        tab,
        r,
        id,
        problems
      ),
      ra: yesNo(r["RA (Y/N)"], "RA (Y/N)", tab, r, id, problems),
    };
  }

  for (const [id, [row]] of keyed(
    "Student_Details",
    data.Student_Details.filter((r) => !isBlank(r)),
    known,
    problems,
    { unique: true }
  )) {
    const tab = "Student_Details";
    const r = row!;
    people.get(id)!.student = {
      schoolEmail: email(
        r["School Email"],
        "School Email",
        tab,
        r,
        id,
        problems
      ),
      slackUserId: slackId(r["Slack User ID"], tab, r, id, problems),
      lead: yesNo(
        r["Student Lead (Y/N)"],
        "Student Lead (Y/N)",
        tab,
        r,
        id,
        problems
      ),
      slackConsentExpiry: date(
        r["Slack Consent Expiry"],
        "Slack Consent Expiry",
        tab,
        r,
        id,
        problems
      ),
    };
  }

  for (const [id, rows] of keyed(
    "Mentor_Admin_Roles",
    data.Mentor_Admin_Roles.filter((r) => !isBlank(r)),
    known,
    problems,
    { unique: false }
  )) {
    const person = people.get(id)!;
    for (const row of rows) {
      const role = row["Admin Role"] as AdminRole;
      if (!ADMIN_ROLES.includes(role)) {
        problems.add(
          "Mentor_Admin_Roles",
          row._row,
          id,
          "Admin Role is not a known admin role"
        );
      } else if (!person.adminRoles.includes(role)) {
        person.adminRoles.push(role);
      }
    }
  }

  // Cross-tab consistency: a role and its details row travel together.
  for (const p of people.values()) {
    const isMentor = p.roles.includes("Mentor");
    const isStudent = p.roles.includes("Student");
    if (isMentor && !p.mentor) {
      problems.add(
        "Mentor_Details",
        0,
        p.personId,
        "Mentor with no Mentor_Details row"
      );
    }
    if (!isMentor && p.mentor) {
      problems.add(
        "Mentor_Details",
        0,
        p.personId,
        "Mentor_Details row but no Mentor role"
      );
    }
    if (isMentor && p.mentor && !p.mentor.rhrEmail) {
      problems.add("Mentor_Details", 0, p.personId, "Mentor with no RHR Email");
    }
    if (isStudent && !p.student) {
      problems.add(
        "Student_Details",
        0,
        p.personId,
        "Student with no Student_Details row"
      );
    }
    if (!isStudent && p.student) {
      problems.add(
        "Student_Details",
        0,
        p.personId,
        "Student_Details row but no Student role"
      );
    }
    if (isStudent && p.student && !p.student.schoolEmail) {
      problems.add(
        "Student_Details",
        0,
        p.personId,
        "Student with no School Email"
      );
    }
    // A student is never a mentor. Both at once is the one combination the
    // roster cannot represent, and guessing either way is wrong: one guess
    // ends a minor's monitoring, the other counts them as a screened adult.
    if (isStudent && isMentor) {
      problems.add("People_Roles", 0, p.personId, "both Student and Mentor");
    }
    if (p.adminRoles.length && !isMentor) {
      problems.add(
        "Mentor_Admin_Roles",
        0,
        p.personId,
        "admin role but no Mentor role"
      );
    }
    if (!p.roles.length) {
      problems.add("People_Roles", 0, p.personId, "no role");
    }
  }

  return { people: [...people.values()], problems: problems.list };
}

/**
 * The one address a person is known by in Google Groups: their RHR address if
 * they have one, else their school address, else their personal one.
 */
export function groupAddress(p: SheetPerson): string | null {
  return p.mentor?.rhrEmail ?? p.student?.schoolEmail ?? p.personalEmail;
}
