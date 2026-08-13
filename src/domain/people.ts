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
  slack_user_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  active: number;
  /** Youth Protection Screening — the background check. */
  ypp_completed_on: IsoDate | null;
  /** Youth Protection Training — annual, and the part FIRST requires. */
  ypt_completed_on: IsoDate | null;
  /** Mentor Ready — optional, encouraged. Never blocks screened status. */
  mentor_ready_on: IsoDate | null;
  cori_completed_on: IsoDate | null;
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
