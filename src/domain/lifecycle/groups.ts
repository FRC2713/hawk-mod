import type { IsoDate } from "../dates.js";
import { screeningStatus, type RequirementDates } from "../rules/screening.js";
import {
  groupAddress,
  type MentorDetails,
  type SheetPerson,
  type SheetRole,
} from "./sheet.js";

/**
 * A sheet row's dates in the roster's terms. The lifecycle sync and the
 * two-adult rule must agree on who is screened, so "cleared" here is exactly
 * `screeningStatus(...).current` — one definition, including its refusal of
 * an expiry too far out to be real.
 */
export function requirementDates(m: MentorDetails): RequirementDates {
  return {
    training_expires_on: m.yptExpiry,
    screening_expires_on: m.screeningExpiry,
    cori_expires_on: m.coriExpiry,
    consent_release_expires_on: m.consentReleaseExpiry,
    data_privacy_expires_on: m.dataPrivacyExpiry,
    mentor_ready_completed_on: m.mentorReadyCompleted,
  };
}

/** Why a mentor is not cleared on `asOf`; empty when they are. */
export function uncleared(m: MentorDetails, asOf: IsoDate): string[] {
  const s = screeningStatus(requirementDates(m), asOf);
  return [
    ...s.missing,
    ...s.expired.map((e) => e.item),
    ...s.implausible.map((e) => `${e.item} (date too far out)`),
  ];
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
 * `grp-all-team` reaches students, so a mentor joins it only once cleared —
 * the same gate as the Slack invite list — and leaves it if a blocking
 * requirement lapses.
 */
export function intendedGroups(
  people: readonly SheetPerson[],
  asOf: IsoDate
): IntendedGroups {
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
    "grp-all-team": [...students, ...mentors.filter((p) => isCleared(p, asOf))],
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
