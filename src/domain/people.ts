import type { IsoDate } from "./dates.js";

/**
 * What the roster says about a person, and nothing more. Deliberately no role
 * for "runs hawk-mod": administrative authority is Slack's Owner/Admin flags,
 * read live in `slack/authz.ts`, so there is nothing here to keep in sync with
 * Slack and nothing to bootstrap by hand on a fresh install.
 */
export const ROLES = ["student", "adult", "district_observer"] as const;

export type Role = (typeof ROLES)[number];

export type Person = {
  id: number;
  /**
   * The lifecycle sheet's Person ID (`P####`), once the row is matched to the
   * sheet. From then on it is the row's key; null only on rows not yet matched.
   */
  person_id: string | null;
  slack_user_id: string | null;
  /**
   * The identity email: RHR Email for a mentor, School Email for a student.
   * Null when the sheet has none yet — never filled with a personal address.
   */
  email: string | null;
  full_name: string;
  role: Role;
  active: number;
  // Requirement dates are EXPIRY dates, as FIRST and the state show them —
  // never computed here. See rules/screening.ts for which ones block.
  /** Background screening. Blocking. FIRST renews it every 3 years. */
  screening_expires_on: IsoDate | null;
  /** Youth Protection Training. Blocking. Annual, expiring 1 August. */
  training_expires_on: IsoDate | null;
  /** CORI + national fingerprints. Blocking. Massachusetts, every 3 years. */
  cori_expires_on: IsoDate | null;
  /** Consent & Release. Reported only: registration, not safety. */
  consent_release_expires_on: IsoDate | null;
  /** Data Privacy for Mentors. Reported only. */
  data_privacy_expires_on: IsoDate | null;
  /** Mentor Ready — a one-time badge, so a completion date. Reported only. */
  mentor_ready_completed_on: IsoDate | null;
  /** Student_Details.Slack Consent Expiry, as the sheet has it. */
  slack_consent_expires_on: IsoDate | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** A Slack account with no roster row. Unknown people are never safe. */
export type UnknownMember = { slackUserId: string };

export type Member = Person | UnknownMember;

export function isKnown(m: Member): m is Person {
  return "id" in m;
}

export function isStudent(m: Member): boolean {
  return isKnown(m) && m.role === "student";
}

/**
 * Anyone on the roster who is not a student — `district_observer` included,
 * not just the `adult` role, and a workspace Owner is no exception. Seniority
 * has never been an argument for being alone with a student; that is exactly
 * the situation the rules exist for. Unknown members are not adults either, so
 * an unidentified account can never satisfy the two-adult rule.
 */
export function isAdult(m: Member): boolean {
  return isKnown(m) && m.role !== "student";
}

/** Roles whose DMs hawk-mod expects to monitor via an enrolled user token. */
export function requiresEnrollment(p: Person): boolean {
  return p.active === 1 && p.role !== "student";
}

export function label(m: Member): string {
  return isKnown(m) ? m.full_name : `unknown account ${m.slackUserId}`;
}

export function slackIdOf(m: Member): string | null {
  return isKnown(m) ? m.slack_user_id : m.slackUserId;
}
