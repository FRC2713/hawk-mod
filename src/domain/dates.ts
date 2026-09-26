/** Date-only values are ISO `YYYY-MM-DD`; instants are full ISO-8601. */
export type IsoDate = string;

/** The team's timezone; `TZ` is set in both compose files, and this is its default. */
const TEAM_TZ = "America/New_York";

function dayFormatter(): Intl.DateTimeFormat {
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  } as const;
  try {
    // en-CA formats a date as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      ...options,
      timeZone: process.env.TZ || TEAM_TZ,
    });
  } catch {
    // An unrecognised TZ must not stop every date comparison in the app.
    return new Intl.DateTimeFormat("en-CA", { ...options, timeZone: TEAM_TZ });
  }
}

/**
 * Today's date where the team is, not in UTC. Expiry dates are calendar days in
 * Massachusetts; in UTC, "today" rolls over at 8pm Eastern, and a date that is
 * still valid tonight would read as expired four hours early.
 */
export function today(now: Date = new Date()): IsoDate {
  return dayFormatter().format(now);
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function addYears(date: IsoDate, years: number): IsoDate {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Not an ISO date: ${date}`);
  // Day 0 of the next month is the last day of this one, so a Feb 29 anchor
  // lands on Feb 28 in a common year instead of silently becoming Mar 1.
  const lastOfMonth = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  const day = Math.min(d, lastOfMonth);
  const dt = new Date(Date.UTC(y + years, m - 1, day));
  return dt.toISOString().slice(0, 10);
}

/** True when `date` is still in force on `asOf` (inclusive). */
export function notExpired(expiresOn: IsoDate, asOf: IsoDate): boolean {
  return expiresOn >= asOf;
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Slack `ts` values ("1712345678.000200") to an ISO instant. */
export function tsToIso(ts: string): string {
  const seconds = Number(ts.split(".")[0] ?? "0");
  return new Date(seconds * 1000).toISOString();
}
