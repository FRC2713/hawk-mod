import {
  createPersonFromSheet,
  finishAuditRun,
  ROSTER_RUN,
  startAuditRun,
  updatePersonFromSheet,
} from "../db/repo.js";
import { db } from "../db/client.js";
import type { RosterChange, RosterPlan } from "../domain/lifecycle/roster.js";

export type RosterApplyStats = {
  created: number;
  matched: number;
  updated: number;
  toStudent: number;
  reactivated: number;
  findings: number;
};

/**
 * Writes a roster plan's changes, all or none, and records the run. The
 * database half of applying a plan — no Slack, no Google — so a test can
 * apply one against a real schema and check that planning again finds
 * nothing left to do.
 *
 * Refuses a refused plan: the refusal travels with the plan precisely so that
 * no caller can apply one by forgetting to check.
 */
export function applyRosterChanges(plan: RosterPlan): RosterApplyStats {
  if (plan.refused) throw new Error(plan.refused);
  const stats: RosterApplyStats = {
    created: 0,
    matched: 0,
    updated: 0,
    toStudent: 0,
    reactivated: 0,
    findings: plan.findings.length,
  };
  db().transaction(() => {
    const runId = startAuditRun(ROSTER_RUN);
    for (const c of plan.changes) applyOne(c, stats);
    // Finishing the run is what marks the cutover done, so it is inside the
    // same transaction as the changes it describes.
    finishAuditRun(runId, stats);
  })();
  return stats;
}

function applyOne(c: RosterChange, stats: RosterApplyStats): void {
  if (c.kind === "create") {
    createPersonFromSheet({
      personId: c.personId,
      role: c.role,
      fullName: c.fullName,
      email: c.email,
      slackUserId: c.slackUserId,
      dates: c.dates,
    });
    stats.created += 1;
    return;
  }
  const { set } = c;
  updatePersonFromSheet({
    id: c.rosterId,
    personId: set.person_id,
    fullName: set.full_name,
    email: set.email,
    slackUserId: set.slack_user_id,
    role: set.role,
    reactivate: set.reactivate,
    dates: set.dates,
  });
  stats.updated += 1;
  if (set.person_id) stats.matched += 1;
  if (set.role) stats.toStudent += 1;
  if (set.reactivate) stats.reactivated += 1;
}
