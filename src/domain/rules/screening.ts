import { addYears, notExpired, type IsoDate } from "../dates.js";
import { isKnown, type Member, type Person } from "../people.js";

/**
 * Youth Protection Training is annual, and is the training component FIRST
 * actually requires for clearance.
 */
export const YPT_VALID_YEARS = 1;

/**
 * Youth Protection Screening — the background check run through FIRST's
 * screening provider. Verify the renewal interval against FIRST before a
 * season: it is longer than the training cycle, and getting it wrong in the
 * short direction means flagging adults who are perfectly current.
 */
export const SCREENING_VALID_YEARS = 4;

/**
 * CORI and national fingerprint checks every three years for volunteers with
 * direct and unmonitored contact with students — M.G.L. c. 71 §38R and
 * 603 CMR 51.00. State law, independent of anything FIRST asks for.
 */
export const CORI_VALID_YEARS = 3;

export type ScreeningStatus = {
  current: boolean;
  missing: string[];
  expired: { item: string; expiredOn: IsoDate }[];
  /** Encouraged but not required; reported, never blocking. */
  optionalOutstanding: string[];
};

type Requirement = { item: string; completedOn: IsoDate | null; years: number };

/** The three FIRST and Massachusetts actually require. */
function requirements(p: Person): Requirement[] {
  return [
    {
      item: "Youth Protection Screening",
      completedOn: p.ypp_completed_on,
      years: SCREENING_VALID_YEARS,
    },
    {
      item: "Youth Protection Training",
      completedOn: p.ypt_completed_on,
      years: YPT_VALID_YEARS,
    },
    {
      item: "CORI + fingerprints",
      completedOn: p.cori_completed_on,
      years: CORI_VALID_YEARS,
    },
  ];
}

export function screeningStatus(p: Person, asOf: IsoDate): ScreeningStatus {
  const missing: string[] = [];
  const expired: { item: string; expiredOn: IsoDate }[] = [];
  for (const r of requirements(p)) {
    if (!r.completedOn) {
      missing.push(r.item);
      continue;
    }
    const expiresOn = addYears(r.completedOn, r.years);
    if (!notExpired(expiresOn, asOf)) {
      expired.push({ item: r.item, expiredOn: expiresOn });
    }
  }

  // Mentor Ready is encouraged, not required. Worth surfacing so a coach can
  // chase it; never a reason to treat someone as unscreened.
  const optionalOutstanding: string[] = [];
  if (!p.mentor_ready_on) optionalOutstanding.push("Mentor Ready");

  return {
    current: missing.length === 0 && expired.length === 0,
    missing,
    expired,
    optionalOutstanding,
  };
}

/**
 * The unit the two-adult rule counts (§4.2). Deliberately strict about the
 * three requirements, and deliberately indifferent to the optional one. If the
 * district administrator's screening is held by their employer, record those
 * dates on their roster row as attested — do not weaken this predicate.
 */
export function isScreenedAdult(m: Member, asOf: IsoDate): boolean {
  if (!isKnown(m)) return false;
  if (m.role === "student") return false;
  if (m.active !== 1) return false;
  return screeningStatus(m, asOf).current;
}

/** Screening that lapses within the horizon — surfaced before it bites. */
export function expiringWithin(
  p: Person,
  asOf: IsoDate,
  horizon: IsoDate
): { item: string; expiresOn: IsoDate }[] {
  const soon: { item: string; expiresOn: IsoDate }[] = [];
  for (const r of requirements(p)) {
    if (!r.completedOn) continue;
    const expiresOn = addYears(r.completedOn, r.years);
    if (notExpired(expiresOn, asOf) && !notExpired(expiresOn, horizon)) {
      soon.push({ item: r.item, expiresOn });
    }
  }
  return soon;
}
