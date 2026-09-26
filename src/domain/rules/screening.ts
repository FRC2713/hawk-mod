import { addYears, notExpired, type IsoDate } from "../dates.js";
import { isKnown, type Member, type Person } from "../people.js";

/**
 * Requirements are recorded as the date they EXPIRE, exactly as FIRST and the
 * state show it, and nothing here computes one. FIRST expires its annual items
 * on 1 August — the season rollover — not a year after completion, so any
 * arithmetic from a completion date is wrong in the direction that matters.
 *
 * The windows below are therefore not how long anything lasts. They bound how
 * far in the future a real expiry can be, and a date beyond the bound is
 * treated as a typo: reported, and NOT current. A mistyped year would otherwise
 * extend someone's clearance silently, which is the unsafe direction.
 */

/**
 * Background screening: FIRST's Youth Protection tracking form sets the next
 * renewal at 36 months (FRC2713/hawk-mod#17 — this was 4, and reported less
 * than it should have).
 */
export const SCREENING_VALID_YEARS = 3;

/**
 * CORI and national fingerprint checks every three years for volunteers with
 * direct and unmonitored contact with students — M.G.L. c. 71 §38R and
 * 603 CMR 51.00. State law, independent of anything FIRST asks for.
 */
export const CORI_VALID_YEARS = 3;

/** FIRST's season rollover, when its annual items expire. */
export const ROLLOVER = "08-01";

/**
 * The latest expiry an annual FIRST item can plausibly have on `asOf`: the
 * next 1 August, plus one season for training done just before a rollover and
 * counted toward the following one.
 */
export function latestAnnualExpiry(asOf: IsoDate): IsoDate {
  const year = Number(asOf.slice(0, 4));
  const next = asOf.slice(5) < ROLLOVER ? year : year + 1;
  return `${next + 1}-${ROLLOVER}`;
}

/** The fields screening reads. A `Person` has them; so can a sheet row. */
export type RequirementDates = Pick<
  Person,
  | "screening_expires_on"
  | "training_expires_on"
  | "cori_expires_on"
  | "consent_release_expires_on"
  | "data_privacy_expires_on"
  | "mentor_ready_completed_on"
>;

type Requirement = {
  item: string;
  expiresOn: IsoDate | null;
  /** Latest plausible expiry on `asOf`. */
  latest: (asOf: IsoDate) => IsoDate;
};

/**
 * The three that decide whether an adult counts as screened. The annual one is
 * the part of Mentor Ready FIRST actually requires; the other two are the
 * background checks.
 */
function blocking(p: RequirementDates): Requirement[] {
  return [
    {
      item: "Youth Protection Training",
      expiresOn: p.training_expires_on,
      latest: latestAnnualExpiry,
    },
    {
      item: "Background Screening",
      expiresOn: p.screening_expires_on,
      latest: (asOf) => addYears(asOf, SCREENING_VALID_YEARS),
    },
    {
      item: "CORI + fingerprints",
      expiresOn: p.cori_expires_on,
      latest: (asOf) => addYears(asOf, CORI_VALID_YEARS),
    },
  ];
}

/**
 * Reported so someone can chase them, and never a reason to treat an adult as
 * unscreened. Consent & Release is registration with FIRST, not safety; Data
 * Privacy is about data handling; Mentor Ready is encouraged, not required.
 */
function reportedOnly(p: RequirementDates): Requirement[] {
  return [
    {
      item: "Consent & Release",
      expiresOn: p.consent_release_expires_on,
      latest: latestAnnualExpiry,
    },
    {
      item: "Data Privacy for Mentors",
      expiresOn: p.data_privacy_expires_on,
      latest: latestAnnualExpiry,
    },
  ];
}

export type ScreeningStatus = {
  current: boolean;
  missing: string[];
  expired: { item: string; expiredOn: IsoDate }[];
  /** A blocking expiry too far out to be real — probably a typo. Not current. */
  implausible: { item: string; expiresOn: IsoDate }[];
  /** Encouraged but not required; reported, never blocking. */
  optionalOutstanding: string[];
};

export function screeningStatus(
  p: RequirementDates,
  asOf: IsoDate
): ScreeningStatus {
  const missing: string[] = [];
  const expired: { item: string; expiredOn: IsoDate }[] = [];
  const implausible: { item: string; expiresOn: IsoDate }[] = [];
  for (const r of blocking(p)) {
    if (!r.expiresOn) missing.push(r.item);
    else if (!notExpired(r.expiresOn, asOf)) {
      expired.push({ item: r.item, expiredOn: r.expiresOn });
    } else if (r.expiresOn > r.latest(asOf)) {
      implausible.push({ item: r.item, expiresOn: r.expiresOn });
    }
  }

  const optionalOutstanding: string[] = [];
  for (const r of reportedOnly(p)) {
    if (!r.expiresOn || !notExpired(r.expiresOn, asOf)) {
      optionalOutstanding.push(r.item);
    }
  }
  if (!p.mentor_ready_completed_on) optionalOutstanding.push("Mentor Ready");

  return {
    current: !missing.length && !expired.length && !implausible.length,
    missing,
    expired,
    implausible,
    optionalOutstanding,
  };
}

/** One line a person can act on, for findings and `/hawkmod whois`. */
export function describeScreening(s: ScreeningStatus): string {
  if (s.current) return "current";
  return [
    s.missing.length ? `missing ${s.missing.join(", ")}` : "",
    s.expired.length
      ? `expired ${s.expired.map((e) => `${e.item} (${e.expiredOn})`).join(", ")}`
      : "",
    s.implausible.length
      ? `check the date of ${s.implausible
          .map((e) => `${e.item} (${e.expiresOn})`)
          .join(", ")}, it is further out than that item lasts`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The unit the two-adult rule counts (§4.2). Deliberately strict about the
 * three requirements, and deliberately indifferent to the reported ones. If the
 * district administrator's screening is held by their employer, record those
 * dates on their roster row as attested — do not weaken this predicate.
 */
export function isScreenedAdult(m: Member, asOf: IsoDate): boolean {
  if (!isKnown(m)) return false;
  if (m.role === "student") return false;
  if (m.active !== 1) return false;
  return screeningStatus(m, asOf).current;
}

/**
 * What to refuse when a person types requirement dates in, keyed by field.
 * Pure, so the form's rules are tested without Slack. A past expiry is
 * accepted — recording that something lapsed is legitimate — but one further
 * out than the item can last is a typo, and so is a completion in the future.
 */
export function screeningEntryErrors(
  values: Partial<Record<keyof RequirementDates, string | null>>,
  asOf: IsoDate
): Partial<Record<keyof RequirementDates, string>> {
  const errors: Partial<Record<keyof RequirementDates, string>> = {};
  const bound: [keyof RequirementDates, string, IsoDate][] = [
    ["training_expires_on", "a year", latestAnnualExpiry(asOf)],
    [
      "screening_expires_on",
      `${SCREENING_VALID_YEARS} years`,
      addYears(asOf, SCREENING_VALID_YEARS),
    ],
    [
      "cori_expires_on",
      `${CORI_VALID_YEARS} years`,
      addYears(asOf, CORI_VALID_YEARS),
    ],
    ["consent_release_expires_on", "a year", latestAnnualExpiry(asOf)],
    ["data_privacy_expires_on", "a year", latestAnnualExpiry(asOf)],
  ];
  for (const [field, lasts, latest] of bound) {
    const v = values[field];
    if (v && v > latest) {
      errors[field] = `That is further out than ${lasts} — check the year.`;
    }
  }
  const earned = values.mentor_ready_completed_on;
  if (earned && earned > asOf) {
    errors.mentor_ready_completed_on = "That date is in the future.";
  }
  return errors;
}

/** Blocking screening that lapses within the horizon — surfaced before it bites. */
export function expiringWithin(
  p: RequirementDates,
  asOf: IsoDate,
  horizon: IsoDate
): { item: string; expiresOn: IsoDate }[] {
  return blocking(p).flatMap((r) =>
    r.expiresOn &&
    notExpired(r.expiresOn, asOf) &&
    !notExpired(r.expiresOn, horizon)
      ? [{ item: r.item, expiresOn: r.expiresOn }]
      : []
  );
}
