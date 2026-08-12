import { resolveFinding } from "./db/repo.js";
import type { FindingStatus } from "./domain/findings.js";
import { refreshFinding } from "./slack/alerts.js";

/**
 * The single path a finding takes out of `open`, mirroring `raise()` on the way
 * in: change the row, then redraw the alert. Closing without the redraw leaves
 * a message in the channel still offering buttons for something already dealt
 * with — which is how people stop trusting what the channel says.
 */
export async function closeFinding(
  id: number,
  by: string,
  note: string,
  status: Exclude<FindingStatus, "open"> = "resolved"
): Promise<boolean> {
  const changed = resolveFinding(id, by, note, status);
  if (changed) await refreshFinding(id);
  return changed;
}
