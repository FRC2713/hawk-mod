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
    // Literally the union of the two role groups, so it cannot drift from them.
    "grp-all-team": [...new Set([...mentors, ...students])],
  };
}

/**
 * Every group that sits inside another, as [subset, superset]. Google Groups
 * are kept flat — each holds its people directly, never another group —
 * because nested groups behave inconsistently across Drive, Calendar and
 * Slack. So "a lead is also a mentor" is not something Google enforces; it is
 * this list, and a test that checks every subset member is in its superset.
 * Adding a group that belongs inside another means adding it here.
 */
export const SUBSETS: readonly (readonly [GroupName, GroupName])[] = [
  ["grp-mentor-leads", "grp-mentors"],
  ["grp-student-leads", "grp-students"],
  ["grp-mentors", "grp-all-team"],
  ["grp-students", "grp-all-team"],
];

/** Group members as addresses, sorted; people without one are left out. */
export function addresses(members: readonly SheetPerson[]): string[] {
  return [
    ...new Set(
      members.map(groupAddress).filter((a): a is string => a !== null)
    ),
  ].sort();
}
