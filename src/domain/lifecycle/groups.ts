import type { IsoDate } from "../dates.js";
import {
  mayHaveAccess,
  screeningStatus,
  type RequirementDates,
} from "../rules/screening.js";
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

/** A screened adult (YPT, Background and CORI current), for a sheet row. */
export function isCleared(p: SheetPerson, asOf: IsoDate): boolean {
  return p.mentor !== null && uncleared(p.mentor, asOf).length === 0;
}

export const GROUPS = [
  "grp-mentors",
  "grp-volunteers",
  "grp-students",
  "grp-alumni",
  "grp-parents",
  "grp-mentor-leads",
  "grp-student-leads",
  "grp-ra",
  "grp-all-team",
] as const;

export type GroupName = (typeof GROUPS)[number];

/**
 * Red Hawk's Google Groups, by their permanent Directory ID — never by name
 * or address, the same rule as Slack channels (CLAUDE.md, "Settings"). A
 * group's name and address can both be changed in the Admin console; its ID
 * cannot. hawk-mod reads and edits each group only by this ID, and shows the
 * group's current name and address beside it.
 *
 * The name still matters once: the ID for `grp-mentors` must lead to a group
 * named `grp-mentors`. If it does not — an ID pasted into the wrong line — the
 * dry run says so and nothing is applied to that group. A group deleted and
 * recreated gets a new ID, and this line changes with it.
 *
 * An empty string is a group with no ID yet; it is reported and skipped.
 */
export const GOOGLE_GROUP_IDS: Record<GroupName, string> = {
  "grp-mentors": "04anzqyu2b5mt66",
  "grp-volunteers": "04h042r0189xw6i",
  "grp-students": "00rjefff1w131pu",
  "grp-alumni": "02grqrue3e1x45w",
  "grp-parents": "0319y80a4kk4xus",
  "grp-mentor-leads": "036ei31r18inez4",
  "grp-student-leads": "03cqmetx0ytbzr4",
  "grp-ra": "02nusc193nukp6h",
  "grp-all-team": "014ykbeg1jvwjuy",
};

/** Every group but grp-parents holds sheet people; parents are contacts. */
export type PersonGroup = Exclude<GroupName, "grp-parents">;

export const PERSON_GROUPS = GROUPS.filter(
  (g): g is PersonGroup => g !== "grp-parents"
);

/** Who belongs in each computed person group, as sheet people. */
export type IntendedGroups = Record<PersonGroup, SheetPerson[]>;

function has(p: SheetPerson, role: SheetRole): boolean {
  return p.roles.includes(role);
}

/**
 * **May have access** (CORI current), for a sheet row. A mentor with no
 * Mentor_Details row has no CORI date, so none.
 */
export function hasAccess(p: SheetPerson, asOf: IsoDate): boolean {
  return (
    p.mentor !== null &&
    mayHaveAccess({ cori_expires_on: p.mentor.coriExpiry }, asOf)
  );
}

/**
 * Whether a person belongs in a group — to join it (`joining`), or to stay in
 * it once there. The two differ only for grp-ra: joining needs a screened
 * adult, but a lapse removes nobody (decided 2026-09-28) — FIRST's 1 August
 * rollover lapses every RA's training on the same day, and it raises the
 * ordinary screening reminder, not a removal.
 *
 * Only `active` people belong: an `unknown` status is out for access, the
 * cautious reading of that cell for groups (the roster reads it the other way,
 * for monitoring). Mentors belong only once they may have access — CORI
 * current — in every group that reaches students.
 */
export function belongs(
  group: PersonGroup,
  p: SheetPerson,
  asOf: IsoDate,
  joining: boolean
): boolean {
  if (p.status !== "active") return false;
  const mentor = has(p, "Mentor") && hasAccess(p, asOf);
  const student = has(p, "Student");
  switch (group) {
    case "grp-mentors":
      return mentor;
    case "grp-students":
      return student;
    case "grp-volunteers":
      return has(p, "Volunteer");
    case "grp-alumni":
      return has(p, "Alumni");
    case "grp-mentor-leads":
      return mentor && Boolean(p.mentor?.lead);
    case "grp-student-leads":
      return student && Boolean(p.student?.lead);
    case "grp-ra":
      return (
        mentor && Boolean(p.mentor?.ra) && (!joining || isCleared(p, asOf))
      );
    case "grp-all-team":
      // Every Active student and every Active mentor with CORI current — not
      // volunteers, parents or alumni (decided 2026-09-27).
      return mentor || student;
  }
}

/**
 * Who the sheet says should join each person group. Pure; the Google side
 * diffs this against actual membership (`groupPlan.ts`).
 */
export function intendedGroups(
  people: readonly SheetPerson[],
  asOf: IsoDate
): IntendedGroups {
  return Object.fromEntries(
    PERSON_GROUPS.map((g) => [
      g,
      people.filter((p) => belongs(g, p, asOf, true)),
    ])
  ) as IntendedGroups;
}

/**
 * grp-parents: every Parent/Guardian address of every Active student, with
 * the students who list it. Recomputed from scratch each run, so a parent a
 * younger sibling still lists simply stays — no special case for siblings.
 */
export function intendedParents(
  people: readonly SheetPerson[]
): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const p of people) {
    if (p.status !== "active" || !has(p, "Student")) continue;
    for (const address of p.parentEmails) {
      parents.set(address, [...(parents.get(address) ?? []), p.personId]);
    }
  }
  return parents;
}

/**
 * Every group that sits inside another, as [subset, superset]. Google Groups
 * are kept flat — each holds its people directly, never another group —
 * because nested groups behave inconsistently across Drive, Calendar and
 * Slack. So "a lead is also a mentor" is not something Google enforces; it is
 * this list, and a test that checks every subset member is in its superset.
 * Adding a group that belongs inside another means adding it here.
 */
export const SUBSETS: readonly (readonly [PersonGroup, PersonGroup])[] = [
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
