import type { JWT } from "google-auth-library";
import {
  locateHeaders,
  SHEET_TAB_NAMES,
  SHEET_TABS,
  SheetShapeError,
  type Header,
  type HeaderProblem,
  type SheetData,
  type SheetTab,
} from "../domain/lifecycle/schema.js";
import { log } from "../logger.js";

export const SHEETS_READONLY =
  "https://www.googleapis.com/auth/spreadsheets.readonly";

/** Only the write-back asks for this; every read uses the read-only scope. */
export const SHEETS_READWRITE = "https://www.googleapis.com/auth/spreadsheets";

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

async function call<T>(
  client: JWT,
  url: string,
  params: [string, string][],
  body?: unknown
): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await client.request<T>({
      url: qs ? `${url}?${qs}` : url,
      ...(body === undefined ? {} : { method: "POST", data: body }),
    });
    return res.data;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 403) {
      throw new Error(
        body === undefined
          ? "Google refused access to the lifecycle sheet. Is it shared with " +
              "the service account?"
          : "Google refused to write to the lifecycle sheet. The service " +
              "account needs Editor access, not Viewer."
      );
    }
    if (status === 404) {
      throw new Error("No spreadsheet with that ID. Check LIFECYCLE_SHEET_ID.");
    }
    throw err;
  }
}

const get = <T>(client: JWT, url: string, params: [string, string][]) =>
  call<T>(client, url, params);

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

/** One cell hawk-mod means to fill, and what must still be true to fill it. */
export type CellWrite = {
  tab: SheetTab;
  /** 1-based row, as read. */
  row: number;
  header: Header<SheetTab>;
  /** The Person ID that row held when it was read. */
  personId: string;
  value: string;
};

export type WriteResult = {
  written: CellWrite[];
  /** Not written, because the sheet changed underneath the plan. */
  skipped: { write: CellWrite; reason: string }[];
};

/**
 * The check `fillBlankCells` makes against the sheet as it is right now. Pure,
 * so the one thing standing between a stale row number and the wrong person's
 * cell is tested on its own. `column` returns a column's current values from
 * row 1 down.
 */
export function guardWrites(
  writes: readonly CellWrite[],
  column: (tab: SheetTab, header: string) => readonly string[]
): { ok: CellWrite[]; skipped: WriteResult["skipped"] } {
  const ok: CellWrite[] = [];
  const skipped: WriteResult["skipped"] = [];
  for (const w of writes) {
    const at = w.row - 1;
    if (String(column(w.tab, "Person ID")[at] ?? "").trim() !== w.personId) {
      skipped.push({ write: w, reason: "the row now holds someone else" });
    } else if (String(column(w.tab, w.header)[at] ?? "").trim() !== "") {
      skipped.push({ write: w, reason: "the cell is no longer blank" });
    } else {
      ok.push(w);
    }
  }
  return { ok, skipped };
}

/**
 * Fills blank cells, and only blank cells, in rows that still belong to the
 * person they belonged to when the plan was made.
 *
 * Row numbers go stale the moment someone sorts or inserts a row, and writing
 * one person's Slack ID into the next person's row is exactly the mistake that
 * must not happen. So this re-reads the header row (columns may have moved),
 * the Person ID column and each target column immediately before writing, and
 * drops any write whose row no longer holds the same Person ID or whose cell is
 * no longer blank. The window left between that check and the write is the
 * length of one request.
 */
export async function fillBlankCells(
  client: JWT,
  spreadsheetId: string,
  writes: readonly CellWrite[]
): Promise<WriteResult> {
  const result: WriteResult = { written: [], skipped: [] };
  if (!writes.length) return result;
  const base = `${API}/${encodeURIComponent(spreadsheetId)}`;
  const tabs = [...new Set(writes.map((w) => w.tab))];

  const headers = await get<{ valueRanges?: ValueRange[] }>(
    client,
    `${base}/values:batchGet`,
    tabs.map((tab) => ["ranges", `${quoted(tab)}!1:1`])
  );
  const located = new Map<SheetTab, Map<string, number>>();
  const problems: HeaderProblem[] = [];
  tabs.forEach((tab, i) => {
    const { columns, problem } = locateHeaders(
      tab,
      headers.valueRanges?.[i]?.values?.[0] ?? []
    );
    if (problem) problems.push(problem);
    located.set(tab, columns);
  });
  if (problems.length) throw new SheetShapeError(problems);

  // The Person ID column and every target column, per tab, as they are now.
  const wanted = tabs.flatMap((tab) =>
    [
      ...new Set([
        "Person ID",
        ...writes.filter((w) => w.tab === tab).map((w) => w.header),
      ]),
    ].map((header) => ({ tab, header }))
  );
  const current = await get<{ valueRanges?: ValueRange[] }>(
    client,
    `${base}/values:batchGet`,
    [
      ...wanted.map(({ tab, header }): [string, string] => {
        const letter = columnLetter(located.get(tab)!.get(header)!);
        return ["ranges", `${quoted(tab)}!${letter}1:${letter}`];
      }),
      ["majorDimension", "COLUMNS"],
    ]
  );
  const column = (tab: SheetTab, header: string): string[] => {
    const i = wanted.findIndex((w) => w.tab === tab && w.header === header);
    return current.valueRanges?.[i]?.values?.[0] ?? [];
  };

  const { ok, skipped } = guardWrites(writes, column);
  result.skipped.push(...skipped);
  const data = ok.map((w) => {
    const letter = columnLetter(located.get(w.tab)!.get(w.header)!);
    return { range: `${quoted(w.tab)}!${letter}${w.row}`, values: [[w.value]] };
  });
  result.written.push(...ok);

  if (data.length) {
    // RAW, so a value is stored exactly as given and never parsed as a
    // formula, a number or a date.
    await call(client, `${base}/values:batchUpdate`, [], {
      valueInputOption: "RAW",
      data,
    });
  }
  log.info("lifecycle sheet written", {
    written: result.written.length,
    skipped: result.skipped.length,
  });
  return result;
}
