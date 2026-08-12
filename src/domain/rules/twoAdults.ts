import type { IsoDate } from "../dates.js";
import {
  isAdult,
  isKnown,
  isStudent,
  slackIdOf,
  type Member,
} from "../people.js";
import { isScreenedAdult } from "./screening.js";

export type ChannelMembership = {
  channelId: string;
  channelName: string;
  isPrivate: boolean;
  members: Member[];
};

export type TwoAdultResult = {
  studentCount: number;
  screenedAdultIds: string[];
  unscreenedAdultIds: string[];
  unknownIds: string[];
  ok: boolean;
  summary: string;
};

/**
 * "Two screened adults in every channel students are in" (§4.2). A channel with
 * no students is out of scope; one screened adult is the case that matters,
 * because it is how a 1:1 conversation reappears in channel form.
 */
export function evaluateTwoAdultRule(
  channel: ChannelMembership,
  asOf: IsoDate
): TwoAdultResult {
  const ids = (list: Member[]) =>
    list.map(slackIdOf).filter((id): id is string => id !== null);

  const students = channel.members.filter(isStudent);
  const screened = channel.members.filter((m) => isScreenedAdult(m, asOf));
  const unscreened = channel.members.filter(
    (m) => isAdult(m) && !isScreenedAdult(m, asOf)
  );
  const unknown = channel.members.filter((m) => !isKnown(m));

  const ok = students.length === 0 || screened.length >= 2;
  const summary =
    students.length === 0
      ? "No students in channel."
      : ok
        ? `${students.length} student(s), ${screened.length} screened adults.`
        : `#${channel.channelName} has ${students.length} student(s) but only ` +
          `${screened.length} screened adult(s).`;

  return {
    studentCount: students.length,
    screenedAdultIds: ids(screened),
    unscreenedAdultIds: ids(unscreened),
    unknownIds: ids(unknown),
    ok,
    summary,
  };
}
