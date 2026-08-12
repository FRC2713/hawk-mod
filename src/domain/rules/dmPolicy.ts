import type { IsoDate } from "../dates.js";
import {
  isAdult,
  isKnown,
  isStudent,
  label,
  slackIdOf,
  type Member,
} from "../people.js";
import { isScreenedAdult } from "./screening.js";

export type ConversationKind = "im" | "mpim";

export type DmVerdict = {
  /** Whether hawk-mod records this conversation at all. */
  monitored: boolean;
  violation:
    | "one_to_one_adult_student"
    | "group_without_second_adult"
    | "unknown_participant_with_student"
    | null;
  severity: "info" | "warn" | "violation";
  summary: string;
  studentIds: string[];
  adultIds: string[];
  unknownIds: string[];
};

/**
 * Classifies a DM or group DM against the adult conduct agreement (§4.1–4.2):
 *
 *   - no 1:1 adult–student DMs, ever;
 *   - anything involving a student needs two screened adults present;
 *   - an account we cannot identify is treated as unscreened.
 *
 * Pure and content-blind on purpose. Nothing here reads message text — the
 * participants alone decide whether a conversation is allowed to exist, so the
 * policy is enforceable without anyone reading a child's messages.
 */
export function classifyConversation(
  kind: ConversationKind,
  members: Member[],
  asOf: IsoDate
): DmVerdict {
  const students = members.filter(isStudent);
  const adults = members.filter(isAdult);
  const unknown = members.filter((m) => !isKnown(m));
  const screened = members.filter((m) => isScreenedAdult(m, asOf));

  const ids = (list: Member[]) =>
    list.map(slackIdOf).filter((id): id is string => id !== null);

  const base = {
    studentIds: ids(students),
    adultIds: ids(adults),
    unknownIds: ids(unknown),
  };

  if (students.length === 0) {
    return {
      monitored: false,
      violation: null,
      severity: "info",
      summary: "No student participants; not monitored.",
      ...base,
    };
  }

  if (kind === "im" && adults.length > 0) {
    const adult = adults[0]!;
    return {
      monitored: true,
      violation: "one_to_one_adult_student",
      severity: "violation",
      summary: `1:1 DM between ${label(adult)} and ${label(students[0]!)} — prohibited by the conduct agreement.`,
      ...base,
    };
  }

  if (unknown.length > 0) {
    return {
      monitored: true,
      violation: "unknown_participant_with_student",
      severity: "violation",
      summary: `Conversation includes a student and ${unknown.length} account(s) not on the roster.`,
      ...base,
    };
  }

  // Students talking among themselves is not recorded at all. FIRST YPP and
  // the conduct agreement govern ADULT conduct toward youth; neither asks the
  // team to surveil youth-to-youth conversation, and collecting it would be a
  // privacy harm with no control to justify it. Peer incidents are reachable
  // through a Corporate Export, which needs a Workspace Owner and a reason.
  if (adults.length === 0) {
    return {
      monitored: false,
      violation: null,
      severity: "info",
      summary: `Student-only conversation with ${students.length} participant(s); not recorded.`,
      ...base,
    };
  }

  if (screened.length < 2) {
    return {
      monitored: true,
      violation: "group_without_second_adult",
      severity: "violation",
      summary: `Group DM with ${students.length} student(s) but only ${screened.length} screened adult(s); two are required.`,
      ...base,
    };
  }

  return {
    monitored: true,
    violation: null,
    severity: "info",
    summary: `Group DM with ${screened.length} screened adults present.`,
    ...base,
  };
}
