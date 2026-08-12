import { guidanceFor } from "../domain/guidance.js";
import type { DmVerdict } from "../domain/rules/dmPolicy.js";
import { log } from "../logger.js";
import { botClient } from "./tokens.js";

/**
 * Sends the nudge to each adult in a conversation that has just raised a
 * finding — privately, from hawk-mod's own DM with them.
 *
 * It cannot go in the offending conversation itself: hawk-mod is not a member
 * of the adults' DMs and Slack offers no way for an app to join one. That turns
 * out to be the better shape anyway, since it keeps the message away from the
 * student.
 *
 * Advisory only. A nudge that failed to send must never affect the finding,
 * which is already durable and already in the alert channel — this is guidance,
 * not the control.
 */
export async function nudgeAdults(verdict: DmVerdict): Promise<number> {
  const text = guidanceFor(verdict);
  if (!text) return 0;

  // `adultIds` is roster-derived and excludes students by construction, which
  // is what keeps this from ever reaching one.
  if (verdict.adultIds.length === 0) return 0;

  const client = botClient();
  let sent = 0;

  for (const adultId of verdict.adultIds) {
    try {
      const im = await client.conversations.open({ users: adultId });
      const channel = im.channel?.id;
      if (!channel) continue;
      await client.chat.postMessage({ channel, text });
      sent += 1;
    } catch (err) {
      log.warn("could not send guidance to an adult", {
        adult: adultId,
        error: String(err),
      });
    }
  }

  if (sent > 0) log.info("guidance sent", { adults: sent });
  return sent;
}
