import { APP_NAME } from "../brand.js";
import type { DmVerdict } from "./rules/dmPolicy.js";

/**
 * What hawk-mod says to an adult whose conversation has just raised a finding.
 *
 * The audience is someone who almost certainly did not know the rule, so the
 * tone is a colleague's, not a compliance system's: name the rule, give the
 * concrete fix, say plainly that a Lead Coach can see it, and do not imply
 * anyone is in trouble. An adult who feels accused moves the conversation
 * somewhere nobody can see it, which is the opposite of what this is for.
 *
 * Pure, and content-blind like everything else: the guidance is composed from
 * the verdict alone and never quotes a word anyone said.
 *
 * This text goes to the *adults* in a conversation and never to the student.
 * Youth protection governs adult conduct toward youth; the student has done
 * nothing wrong, and putting a policy notice in front of a minor is the one
 * message here guaranteed to frighten somebody.
 */

const OPENING = ":wave: Hi — a quick heads-up, not a telling-off.";

const CLOSING =
  "Conversations that include a student are recorded for youth-protection " +
  "audit, and a Lead Coach has been notified as usual. Nothing here is an " +
  "accusation — if you are not sure what to do, just ask a Lead Coach.";

function mentions(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(", ");
}

/**
 * Slack cannot add anyone to an existing 1:1 — it starts a new conversation
 * instead — so the fix looks like abandoning the thread. Saying so up front
 * stops it reading as a workaround someone has invented.
 */
const NEW_GROUP_NOTE =
  "Slack cannot add someone to an existing direct message, so you will need " +
  "to start a *new* group message. That is expected, not a workaround.";

export function guidanceFor(verdict: DmVerdict): string | null {
  const body = (() => {
    switch (verdict.violation) {
      case "one_to_one_adult_student":
        return [
          "Team policy asks that adults do not message students one to one. " +
            "It protects you as much as them, and it is the rule in the " +
            "conduct agreement with no exceptions.",
          `*To put it right:* start a group message with ` +
            `${mentions(verdict.studentIds)} and a second screened adult, or ` +
            `move the conversation to a channel. ${NEW_GROUP_NOTE}`,
        ];

      case "group_without_second_adult":
        return [
          `This group message includes a student but only ` +
            `${verdict.screenedAdultIds.length} screened adult. Team policy ` +
            `asks for two, so that no adult is ever alone in a conversation ` +
            `with a student.`,
          `*To put it right:* add another screened adult, or move the ` +
            `conversation to a channel. ${NEW_GROUP_NOTE}`,
        ];

      case "unknown_participant_with_student":
        return [
          `This conversation includes a student and ` +
            `${verdict.unknownIds.length} account(s) that are not on the team ` +
            `roster, so ${APP_NAME} cannot tell whether they are a screened adult.`,
          "*To put it right:* ask a Lead Coach to add them to the roster, or " +
            "to the students or adults user group. Until then the " +
            "conversation counts as an exception.",
        ];

      case null:
        return null;
    }
  })();

  if (!body) return null;
  return [OPENING, ...body, CLOSING].join("\n\n");
}
