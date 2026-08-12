import { addYears, notExpired, type IsoDate } from "../dates.js";
import type { Person } from "../people.js";

/**
 * "Customer must ... obtain parental/guardian consent before its students sign
 * up or use the Services" — Slack Customer-Specific Supplement §IV. Re-collected
 * annually, so an unrenewed consent expires rather than lingering.
 */
export const CONSENT_VALID_YEARS = 1;

export type Consent = {
  id: number;
  person_id: number;
  signed_on: IsoDate;
  expires_on: IsoDate;
  form_version: string;
  guardian_name: string;
  guardian_email: string | null;
  document_ref: string | null;
  recorded_by: string;
  revoked_on: IsoDate | null;
  created_at: string;
};

export function defaultExpiry(signedOn: IsoDate): IsoDate {
  return addYears(signedOn, CONSENT_VALID_YEARS);
}

export type ConsentStatus =
  | { state: "not_required" }
  | { state: "valid"; consent: Consent }
  | { state: "missing" }
  | { state: "expired"; consent: Consent }
  | { state: "revoked"; consent: Consent };

/**
 * `consents` may be in any order; the most recent signature wins. Only students
 * require consent — adults are adults acting on their own behalf.
 */
export function consentStatus(
  person: Person,
  consents: Consent[],
  asOf: IsoDate
): ConsentStatus {
  if (person.role !== "student") return { state: "not_required" };
  const latest = [...consents]
    .filter((c) => c.person_id === person.id)
    .sort((a, b) => (a.signed_on < b.signed_on ? 1 : -1))[0];
  if (!latest) return { state: "missing" };
  if (latest.revoked_on && latest.revoked_on <= asOf) {
    return { state: "revoked", consent: latest };
  }
  if (!notExpired(latest.expires_on, asOf)) {
    return { state: "expired", consent: latest };
  }
  return { state: "valid", consent: latest };
}

/**
 * The gate the launch checklist names: no student account before a signed
 * consent is on file. A Slack account that exists without one is a finding
 * whether or not the student has posted anything.
 */
export function mayHoldAccount(status: ConsentStatus): boolean {
  return status.state === "not_required" || status.state === "valid";
}
