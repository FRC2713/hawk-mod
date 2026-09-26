/**
 * The columns hawk-mod reads from the lifecycle sheet, and nothing else.
 *
 * This is an allowlist in the strong sense: the sheet client fetches the header
 * row, finds these columns, and requests only them. Every other column — home
 * addresses, birthdays, medical notes, race/ethnicity, emergency contacts —
 * never leaves Google, so nothing hawk-mod does with the rest can leak it.
 * Adding a column here is adding a minor's personal data to hawk-mod's
 * custody; it should need a reason written down next to it.
 *
 * Headers are matched exactly (after trimming whitespace). A missing header
 * stops the sync rather than being guessed at: a renamed `YPT Expiry` read as
 * blank would make every mentor unscreened, and a renamed `Active/Inactive`
 * read as blank could empty every group.
 */
export const SHEET_TABS = {
  People: [
    "Person ID",
    // Names, for the roster's full_name and for reports.
    "Legal First Name",
    "Preferred First Name",
    "Legal Last Name",
    // The group address for anyone without an RHR or school email —
    // volunteers and alumni.
    "Personal Email",
    "Active/Inactive",
  ],
  People_Roles: ["Person ID", "Role"],
  Mentor_Details: [
    "Person ID",
    "RHR Email",
    "Slack User ID",
    "Consent & Release Expiry",
    "Mentor Ready Completed",
    "YPT Expiry",
    "Background Screening Expiry",
    "CORI Expiry",
    "Data Privacy Expiry",
    "Mentor Lead (Y/N)",
    "RA (Y/N)",
  ],
  Mentor_Admin_Roles: ["Person ID", "Admin Role"],
  Student_Details: [
    "Person ID",
    "School Email",
    "Slack User ID",
    "Student Lead (Y/N)",
    "Slack Consent Expiry",
  ],
} as const satisfies Record<string, readonly string[]>;

export type SheetTab = keyof typeof SHEET_TABS;

export const SHEET_TAB_NAMES = Object.keys(SHEET_TABS) as SheetTab[];

export type Header<T extends SheetTab> = (typeof SHEET_TABS)[T][number];

/** One data row of one tab, keyed by header, every value a trimmed string. */
export type SheetRow<T extends SheetTab> = { [H in Header<T>]: string } & {
  /** 1-based sheet row number, so a problem can point at the cell. */
  readonly _row: number;
};

/** What the sheet client hands the parser: every allowlisted tab, as rows. */
export type SheetData = { [T in SheetTab]: SheetRow<T>[] };

export type HeaderProblem = {
  tab: string;
  /** The tab itself is gone or renamed. */
  absent: boolean;
  missing: string[];
  duplicated: string[];
};

/**
 * Locates each allowlisted header in a tab's header row. Pure, so the refusal
 * — the thing that keeps the sheet and hawk-mod aligned — is testable without
 * Google.
 */
export function locateHeaders(
  tab: SheetTab,
  headerRow: readonly string[]
): { columns: Map<string, number>; problem: HeaderProblem | null } {
  const columns = new Map<string, number>();
  const missing: string[] = [];
  const duplicated: string[] = [];
  const trimmed = headerRow.map((h) => h.trim());
  for (const header of SHEET_TABS[tab]) {
    const first = trimmed.indexOf(header);
    if (first === -1) {
      missing.push(header);
      continue;
    }
    if (trimmed.indexOf(header, first + 1) !== -1) duplicated.push(header);
    columns.set(header, first);
  }
  const problem =
    missing.length || duplicated.length
      ? { tab, absent: false, missing, duplicated }
      : null;
  return { columns, problem };
}

/** Thrown when the sheet's shape no longer matches `SHEET_TABS`. */
export class SheetShapeError extends Error {
  constructor(readonly problems: HeaderProblem[]) {
    super(
      "The lifecycle sheet does not match what hawk-mod reads, so nothing was " +
        "synced:\n" +
        problems
          .map((p) =>
            p.absent
              ? `  no tab named "${p.tab}"`
              : [
                  ...p.missing.map((h) => `  ${p.tab}: no column "${h}"`),
                  ...p.duplicated.map(
                    (h) => `  ${p.tab}: "${h}" appears twice`
                  ),
                ].join("\n")
          )
          .join("\n")
    );
    this.name = "SheetShapeError";
  }
}
