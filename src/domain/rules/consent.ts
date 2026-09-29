import { notExpired, type IsoDate } from "../dates.js";
import type { Person } from "../people.js";

/**
 * "Customer must ... obtain parental/guardian consent before its students sign
 * up or use the Services" — Slack Customer-Specific Supplement §IV.
 *
 * The consent is the lifecycle sheet's `Slack Consent Expiry`, copied to
 * `people.slack_consent_expires_on` by the roster run; the paper form is the
 * record, and the sheet stores when it runs out. A consent withdrawn is a date
 * cleared or moved into the past on the sheet. Nothing here computes an
 * expiry: annual items run to 1 August, whatever day the form was signed.
 *
 * The old `consents` table stays in the schema as history and is not read.
 */
export type ConsentStatus =
  | { state: "not_required" }
  | { state: "valid"; expiresOn: IsoDate }
  | { state: "missing" }
  | { state: "expired"; expiresOn: IsoDate };

/**
 * Only students require consent — adults act on their own behalf. Takes only
 * the two fields it reads, so onboarding can ask it about a sheet row that has
 * no roster row yet.
 */
export function consentStatus(
  person: Pick<Person, "role" | "slack_consent_expires_on">,
  asOf: IsoDate
): ConsentStatus {
  if (person.role !== "student") return { state: "not_required" };
  const expiresOn = person.slack_consent_expires_on;
  if (!expiresOn) return { state: "missing" };
  if (!notExpired(expiresOn, asOf)) return { state: "expired", expiresOn };
  return { state: "valid", expiresOn };
}

/**
 * The gate the launch checklist names: no student account without a current
 * consent. A Slack account that exists without one is a finding whether or
 * not the student has posted anything.
 */
export function mayHoldAccount(status: ConsentStatus): boolean {
  return status.state === "not_required" || status.state === "valid";
}
