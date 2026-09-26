import { notExpired, type IsoDate } from "../dates.js";
import {
  groupAddress,
  type MentorDetails,
  type SheetPerson,
  type SheetRole,
} from "./sheet.js";

/**
 * The three requirements that decide whether a mentor is cleared to be around
 * students. Consent & Release, Data Privacy and Mentor Ready are reported and
 * never block (docs/lifecycle-sync.md, "Screening requirements").
 *
 * Expiry dates are the sheet's, as written; nothing here computes one. FIRST
 * expires annual items on 1 August rather than a year after completion, so a
 * computed date would be wrong in a direction that matters.
 */
const BLOCKING = [
  ["Youth Protection Training", "yptExpiry"],
  ["Background Screening", "screeningExpiry"],
  ["CORI + fingerprints", "coriExpiry"],
] as const satisfies readonly (readonly [string, keyof MentorDetails])[];

/** Blocking requirements that are blank or past on `asOf`. Empty = cleared. */
export function uncleared(m: MentorDetails, asOf: IsoDate): string[] {
  return BLOCKING.filter(([, key]) => {
    const expiry = m[key];
    return !expiry || !notExpired(expiry, asOf);
  }).map(([item]) => item);
}

export function isCleared(p: SheetPerson, asOf: IsoDate): boolean {
  return p.mentor !== null && uncleared(p.mentor, asOf).length === 0;
}

export const GROUPS = [
  "grp-mentors",
  "grp-volunteers",
  "grp-students",
  "grp-alumni",
  "grp-mentor-leads",
  "grp-student-leads",
  "grp-ra",
  "grp-all-team",
] as const;

export type GroupName = (typeof GROUPS)[number];

/** Who belongs in each computed group, as sheet people. */
export type IntendedGroups = Record<GroupName, SheetPerson[]>;

function has(p: SheetPerson, role: SheetRole): boolean {
  return p.roles.includes(role);
}

/**
 * Who the sheet says belongs in each group. Pure; the Google side diffs this
 * against actual membership.
 *
 * Only `active` people are members. `unknown` status is left out too — the
 * parse already reported it, and group membership is access, so the
 * conservative reading is the right one here. (The planner's refusals are what
 * stop a sheet-wide mistake from emptying a group.)
 *
 * `grp-all-team` is every active mentor and student, screened or not. Screening
 * gates Slack, not email: an uncleared mentor stays off the Slack invite list
 * and is flagged if already in Slack, but is on the team's mailing list. Group
 * email is observable and interruptible — the whole group sees it — and a
 * mentor is only set Active once they have started screening and are trusted.
 * The reasoning is in docs/lifecycle-sync.md; do not re-gate this on screening
 * without revisiting it there.
 */
export function intendedGroups(people: readonly SheetPerson[]): IntendedGroups {
  const active = people.filter((p) => p.status === "active");
  const mentors = active.filter((p) => has(p, "Mentor"));
  const students = active.filter((p) => has(p, "Student"));
  return {
    "grp-mentors": mentors,
    "grp-volunteers": active.filter((p) => has(p, "Volunteer")),
    "grp-students": students,
    "grp-alumni": active.filter((p) => has(p, "Alumni")),
    "grp-mentor-leads": mentors.filter((p) => p.mentor?.lead),
    "grp-student-leads": students.filter((p) => p.student?.lead),
    "grp-ra": mentors.filter((p) => p.mentor?.ra),
    "grp-all-team": [...students, ...mentors],
  };
}

/** Group members as addresses, sorted; people without one are left out. */
export function addresses(members: readonly SheetPerson[]): string[] {
  return [
    ...new Set(
      members.map(groupAddress).filter((a): a is string => a !== null)
    ),
  ].sort();
}
