/**
 * §4.1 gives the way out of a 1:1: "Anything that starts in a DM moves to a
 * channel or gets a second adult added." Slack cannot add anyone to an
 * existing 1:1 — it makes a new group DM and leaves the original alone — so
 * remediation looks like a *new* conversation containing the same two people
 * plus a second screened adult.
 */

export type OneOnOneFinding = {
  id: number;
  firstSeenAt: string;
  /** Slack ids recorded on the finding when it was raised. */
  students: string[];
  adults: string[];
};

export type GroupConversation = {
  id: string;
  firstSeenAt: string;
  participants: string[];
  studentIds: string[];
  screenedAdultIds: string[];
};

/**
 * Whether `group` is the adult's compliant re-do of the conversation the
 * finding is about.
 *
 * The load-bearing condition is the last one: the group DM must be *newer*
 * than the finding. Without it, a group DM that already existed would clear a
 * 1:1 that happened afterwards — which is backwards, and would let someone
 * launder a fresh violation with an old thread.
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

  return group.firstSeenAt > finding.firstSeenAt;
}

export function describeRemediation(group: GroupConversation): string {
  return (
    `Moved to a group DM (${group.id}) with ` +
    `${group.screenedAdultIds.length} screened adults present.`
  );
}
