import type { JWT } from "google-auth-library";
import {
  locateHeaders,
  SHEET_TAB_NAMES,
  SHEET_TABS,
  SheetShapeError,
  type HeaderProblem,
  type SheetData,
  type SheetTab,
} from "../domain/lifecycle/schema.js";
import { log } from "../logger.js";

export const SHEETS_READONLY =
  "https://www.googleapis.com/auth/spreadsheets.readonly";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A1 notation needs a tab name quoted, with any quote inside doubled. */
function quoted(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

type ValueRange = { range: string; values?: string[][] };

async function get<T>(
  client: JWT,
  url: string,
  params: [string, string][]
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await client.request<T>({ url: `${url}?${qs}` });
    return res.data;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) {
      throw new Error(
        "Google refused access to the lifecycle sheet. Is the service account " +
          "a member of the shared drive (or the sheet shared with it)?"
      );
    }
    if (status === 404) {
      throw new Error("No spreadsheet with that ID. Check LIFECYCLE_SHEET_ID.");
    }
    throw err;
  }
}

/**
 * Reads the allowlisted columns of the lifecycle sheet, and only those.
 *
 * Three requests: the tab list, the header rows, then exactly the columns
 * `SHEET_TABS` names. The last is the point — the other columns never cross
 * the wire, so a minor's address or medical notes cannot end up in memory, a
 * log line, or a stack trace here, whatever else goes wrong.
 *
 * Refuses (throws `SheetShapeError`) if a tab or header is missing, rather than
 * reading around it.
 */
export async function readLifecycleSheet(
  client: JWT,
  spreadsheetId: string
): Promise<SheetData> {
  const base = `${API}/${encodeURIComponent(spreadsheetId)}`;

  const meta = await get<{ sheets?: { properties?: { title?: string } }[] }>(
    client,
    base,
    [["fields", "sheets.properties.title"]]
  );
  const titles = new Set(
    (meta.sheets ?? []).map((s) => s.properties?.title ?? "")
  );

  const problems: HeaderProblem[] = [];
  const present = SHEET_TAB_NAMES.filter((tab) => {
    if (titles.has(tab)) return true;
    problems.push({ tab, absent: true, missing: [], duplicated: [] });
    return false;
  });

  const headers = await get<{ valueRanges?: ValueRange[] }>(
    client,
    `${base}/values:batchGet`,
    present.map((tab) => ["ranges", `${quoted(tab)}!1:1`])
  );

  // Where each allowlisted header sits, per tab.
  const located = new Map<SheetTab, Map<string, number>>();
  present.forEach((tab, i) => {
    const row = headers.valueRanges?.[i]?.values?.[0] ?? [];
    const { columns, problem } = locateHeaders(tab, row);
    if (problem) problems.push(problem);
    located.set(tab, columns);
  });
  if (problems.length) throw new SheetShapeError(problems);

  // One range per allowlisted column, from row 2 down, as columns.
  const wanted: { tab: SheetTab; header: string }[] = [];
  const ranges: [string, string][] = [];
  for (const tab of present) {
    for (const header of SHEET_TABS[tab]) {
      const letter = columnLetter(located.get(tab)!.get(header)!);
      wanted.push({ tab, header });
      ranges.push(["ranges", `${quoted(tab)}!${letter}2:${letter}`]);
    }
  }
  const columns = await get<{ valueRanges?: ValueRange[] }>(
    client,
    `${base}/values:batchGet`,
    [
      ...ranges,
      ["majorDimension", "COLUMNS"],
      // As displayed: dates arrive as the sheet shows them, and the parser
      // insists on YYYY-MM-DD, so a cell formatted any other way is reported
      // rather than silently reinterpreted.
      ["valueRenderOption", "FORMATTED_VALUE"],
    ]
  );

  const byTab = new Map<SheetTab, Map<string, string[]>>();
  wanted.forEach(({ tab, header }, i) => {
    const values = columns.valueRanges?.[i]?.values?.[0] ?? [];
    if (!byTab.has(tab)) byTab.set(tab, new Map());
    byTab.get(tab)!.set(header, values);
  });

  const data = {} as Record<SheetTab, Record<string, string | number>[]>;
  for (const tab of present) {
    const cols = byTab.get(tab)!;
    // The API drops trailing blanks per column, so the tab is as long as its
    // longest column.
    const length = Math.max(0, ...[...cols.values()].map((c) => c.length));
    const rows: Record<string, string | number>[] = [];
    for (let i = 0; i < length; i++) {
      const row: Record<string, string | number> = { _row: i + 2 };
      for (const [header, values] of cols) {
        row[header] = String(values[i] ?? "").trim();
      }
      rows.push(row);
    }
    data[tab] = rows;
  }

  // Counts only. Never a value: these are people, most of them minors.
  log.info("lifecycle sheet read", {
    rows: Object.fromEntries(present.map((t) => [t, data[t].length])),
  });
  return data as unknown as SheetData;
}
