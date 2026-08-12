import type { FindingStatus } from "../findings.js";

/**
 * Findings come in two shapes, and re-detection means opposite things for them.
 *
 * A *condition* finding — lapsed screening, an unenrolled adult, a channel one
 * adult short — describes something that is currently true. The sweep notices it
 * again every night, and that is not news: it is the same problem, still there.
 * Acknowledging one means "seen, not finished with", so it stays acknowledged.
 *
 * An *occurrence* finding describes something that happened. A prohibited DM is
 * a fact about a moment, not a condition, and re-walking the conversation later
 * does not make it happen again — but another message does. So the trigger for
 * an occurrence finding is a new occurrence, never a re-evaluation.
 *
 * Getting this backwards fails in both directions at once, and both failures are
 * the same failure: the alert channel stops meaning anything. Re-alerting a
 * closed finding hourly because the DM still exists trains people to ignore it;
 * staying silent when an acknowledged 1:1 starts up again is worse, because the
 * silence reads as compliance.
 */

/** What `recurs` needs to know about a finding already on record. */
export type ClosableFinding = {
  status: FindingStatus;
  /** When it was last closed, acknowledged or resolved alike. */
  closedAt: string | null;
};

/**
 * Whether an occurrence at `occurredAt` (an ISO instant) is a *recurrence* of
 * `existing` — something that happened after a human closed it, and so needs
 * saying again.
 *
 * False for a finding that does not exist yet: that is a new finding, not a
 * recurrence, and it alerts on its own. False for one still open: it is already
 * saying so.
 */
export function recurs(
  existing: ClosableFinding | undefined,
  occurredAt: string
): boolean {
  if (!existing) return false;
  if (existing.status === "open") return false;

  // A closed finding with no closure time should not be possible. If it happens,
  // alert: a spurious repeat costs someone a glance, and the other way round
  // costs the silence this whole system exists to prevent.
  if (!existing.closedAt) return true;

  return occurredAt > existing.closedAt;
}
