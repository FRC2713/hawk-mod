import { findingByKey, upsertFinding } from "./db/repo.js";
import type { NewFinding } from "./domain/findings.js";
import { recurs } from "./domain/rules/recurrence.js";
import { postFinding } from "./slack/alerts.js";

/**
 * When the thing being reported happened, for findings that describe an event
 * rather than a state — an ISO instant. Supplying it switches `raise` from
 * condition semantics to occurrence semantics; see `domain/rules/recurrence.ts`
 * for why the two differ.
 */
export type Occurrence = { at: string };

/**
 * The single path a finding takes: persist first, then alert. A finding that
 * exists only as a Slack message is one an audit cannot count, and re-detecting
 * something already open must not re-notify — that is how alert channels become
 * background noise.
 *
 * Whether a *closed* finding re-notifies is the other half of that, and depends
 * on which kind it is:
 *
 *   - condition (no `occurrence`): re-detection means the problem is back, so a
 *     resolved one reopens. An acknowledged one does not — someone has said
 *     they are on it, and the sweep will notice again tomorrow regardless.
 *   - occurrence (`occurrence` given): the finding reopens only if the event is
 *     newer than the closure. Re-walking a conversation that was already dealt
 *     with says nothing; a new message in it says everything.
 */
export async function raise(
  f: NewFinding,
  occurrence?: Occurrence
): Promise<{ id: number; alerted: boolean }> {
  const existing = findingByKey(f.dedupeKey);
  const reopen = occurrence
    ? recurs(
        existing && {
          status: existing.status,
          closedAt: existing.resolved_at,
        },
        occurrence.at
      )
    : existing?.status === "resolved";

  const { id, isNew } = upsertFinding(f, { reopen });
  if (isNew) await postFinding(id);
  // `alerted` is what anything advisory should hang off — guidance to the people
  // involved, for instance — so it arrives once per occurrence rather than once
  // per message.
  return { id, alerted: isNew };
}
