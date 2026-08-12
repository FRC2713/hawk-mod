import { upsertFinding } from "./db/repo.js";
import type { NewFinding } from "./domain/findings.js";
import { postFinding } from "./slack/alerts.js";

/**
 * The single path a finding takes: persist first, then alert. A finding that
 * exists only as a Slack message is one an audit cannot count, and re-detecting
 * something already open must not re-notify — that is how alert channels become
 * background noise.
 */
export async function raise(f: NewFinding): Promise<number> {
  const { id, isNew } = upsertFinding(f);
  if (isNew) await postFinding(id);
  return id;
}
