import type { WebClient } from "@slack/web-api";
import { APP_ACTOR } from "../brand.js";
import { findingByKey, peopleBySlackId } from "../db/repo.js";
import { closeFinding } from "../close.js";
import { today } from "../domain/dates.js";
import { dedupeKey } from "../domain/findings.js";
import type { Member } from "../domain/people.js";
import { evaluateTwoAdultRule } from "../domain/rules/twoAdults.js";
import { log } from "../logger.js";
import { raise } from "../raise.js";

/**
 * Re-checks one channel against the two-screened-adults rule. Called whenever
 * membership changes, so the gap between "the second adult left" and "somebody
 * notices" is seconds rather than a quarter.
 */
export async function evaluateChannel(
  client: WebClient,
  channelId: string,
  skipIds: ReadonlySet<string> = new Set()
): Promise<void> {
  const roster = peopleBySlackId();

  let name = channelId;
  let isPrivate = false;
  try {
    const info = await client.conversations.info({ channel: channelId });
    name = info.channel?.name ?? channelId;
    isPrivate = Boolean(info.channel?.is_private);
  } catch (err) {
    log.warn("could not read channel info", { channelId, error: String(err) });
    return;
  }

  const members: Member[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await client.conversations.members({
        channel: channelId,
        limit: 200,
        cursor,
      });
      for (const id of page.members ?? []) {
        if (skipIds.has(id)) continue;
        members.push(roster.get(id) ?? { slackUserId: id });
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (err) {
    log.warn("could not read channel members", {
      channelId,
      error: String(err),
    });
    return;
  }

  const result = evaluateTwoAdultRule(
    { channelId, channelName: name, isPrivate, members },
    today()
  );
  const key = dedupeKey("lone_adult_channel", channelId);

  if (result.ok) {
    // Someone fixed it by adding an adult or removing the students; close the
    // finding rather than waiting for the nightly sweep to notice.
    const existing = findingByKey(key);
    if (existing && existing.status !== "resolved") {
      await closeFinding(existing.id, APP_ACTOR, `Resolved: ${result.summary}`);
    }
    return;
  }

  await raise({
    kind: "lone_adult_channel",
    dedupeKey: key,
    severity: "violation",
    summary: result.summary,
    subjectRef: channelId,
    detail: result,
  });
}
