/**
 * §4.1 gives the way out of a 1:1: "Anything that starts in a DM moves to a
 * channel or gets a second adult added." Slack cannot add anyone to an
 * existing 1:1 — it makes a new group DM and leaves the original alone — so
 * remediation looks like a *new* conversation containing the same two people
 * plus a second screened adult.
 */

export type OneOnOneFinding = {
  id: number;
  /**
   * The most recent 1:1 message the finding covers — not the first. A finding
   * that was acknowledged and then recurred is about the new message, and
   * anchoring on the original would let the group DM that answered the first
   * one answer the second one too.
   */
  lastOccurredAt: string;
  /** Slack ids recorded on the finding when it was raised. */
  students: string[];
  adults: string[];
};

export type GroupConversation = {
  id: string;
  /**
   * The message that has just landed in the group — not when the group was
   * created. Moving into a group chat that already existed is the ordinary way
   * to comply, and often the best one, so creation time says nothing useful.
   * Activity does: a conversation that moved here has a message here.
   */
  lastMessageAt: string;
  participants: string[];
  studentIds: string[];
  screenedAdultIds: string[];
};

/**
 * Whether `group` is the adult's compliant re-do of the conversation the
 * finding is about.
 *
 * The load-bearing condition is the last one: the group must have been *spoken
 * in* after the most recent 1:1 message. Comparing against when the group was
 * created would reject the ordinary remedy — carrying on in a group chat the
 * team already had — while comparing against nothing at all would let a dormant
 * old thread launder a fresh violation. Activity after the fact is the only
 * thing that distinguishes the two.
 *
 * It follows that an adult who keeps DMing privately loses the excuse each time:
 * the next 1:1 message moves the anchor past the group's last message, and the
 * group has to be used again to answer for it.
 */
export function remediates(
  finding: OneOnOneFinding,
  group: GroupConversation
): boolean {
  if (group.screenedAdultIds.length < 2) return false;
  if (group.studentIds.length === 0) return false;

  const present = new Set(group.participants);
  const everyoneCarriedOver = [...finding.students, ...finding.adults].every(
    (id) => present.has(id)
  );
  if (!everyoneCarriedOver) return false;

  return group.lastMessageAt > finding.lastOccurredAt;
}

export function describeRemediation(group: GroupConversation): string {
  return (
    `Moved to a group DM (${group.id}) with ` +
    `${group.screenedAdultIds.length} screened adults present.`
  );
}
