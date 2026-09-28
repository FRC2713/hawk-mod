import { daysBetween, type IsoDate } from "../dates.js";
import { dedupeKey, type NewFinding } from "../findings.js";
import type { SheetPerson } from "./sheet.js";

/**
 * Sixty days before a mentor's CORI expires, hawk-mod warns — in the alert
 * channel, and in a Slack message to the mentor — so the lapse, which takes
 * them out of the mentor groups on a click, is never a surprise (decided
 * 2026-09-27). Once per expiry date: the date is in the finding's key, so a
 * renewed date entered on the sheet is simply a key nobody sees any more, and
 * the run closes it.
 */
export const CORI_WARNING_DAYS = 60;

export type CoriExpiring = {
  personId: string;
  name: string;
  expiresOn: IsoDate;
  daysLeft: number;
};

/** Active mentors whose CORI is current and expires within the window. */
export function coriExpiringSoon(
  people: readonly SheetPerson[],
  asOf: IsoDate
): CoriExpiring[] {
  return people.flatMap((p) => {
    const e = p.mentor?.coriExpiry;
    if (p.status !== "active" || !p.roles.includes("Mentor") || !e) return [];
    const daysLeft = daysBetween(asOf, e);
    return daysLeft >= 0 && daysLeft <= CORI_WARNING_DAYS
      ? [{ personId: p.personId, name: p.name, expiresOn: e, daysLeft }]
      : [];
  });
}

export const CORI_EXPIRING_PREFIX = "cori_expiring:";

export function coriExpiringFinding(c: CoriExpiring): NewFinding {
  return {
    kind: "cori_expiring",
    dedupeKey: dedupeKey("cori_expiring", c.personId, c.expiresOn),
    severity: "info",
    summary:
      `${c.personId} ${c.name}'s CORI expires on ${c.expiresOn} ` +
      `(${c.daysLeft} day${c.daysLeft === 1 ? "" : "s"}). Once it lapses they ` +
      `stop counting as a screened adult, and an administrator will be asked ` +
      `whether to remove them from the mentor groups. Entering the renewed ` +
      `expiry on the lifecycle sheet closes this.`,
    subjectRef: c.personId,
    detail: { personId: c.personId, expiresOn: c.expiresOn },
  };
}

/** The Slack message to the mentor: a colleague's tone, not a warning. */
export function coriReminderText(c: CoriExpiring): string {
  return (
    `Hi — a heads-up that your CORI + fingerprint check expires on ` +
    `${c.expiresOn}. Once it lapses you can't count toward the two-adult rule ` +
    `or keep access to the mentor groups, so it's worth starting the renewal ` +
    `now. When it's done, let whoever keeps the team's lifecycle sheet know ` +
    `the new expiry date and this reminder stops. Thanks!`
  );
}
