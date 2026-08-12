import { config } from "../config.js";
import { setFindingAlertTs } from "../db/repo.js";
import { severityEmoji, type NewFinding } from "../domain/findings.js";
import { log } from "../logger.js";
import { botClient } from "./tokens.js";

/**
 * Alerts name participants and conversations. They never carry message text —
 * the alert channel is a place to be told something needs a look, not a feed of
 * students' messages. Content stays in the database, behind the export CLI.
 */
export async function postFinding(
  findingId: number,
  f: NewFinding
): Promise<void> {
  const text = `${severityEmoji(f.severity)} *${f.kind}* — ${f.summary}`;
  try {
    const res = await botClient().chat.postMessage({
      channel: config().ALERT_CHANNEL_ID,
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text:
                `finding #${findingId}` +
                (f.subjectRef ? ` · \`${f.subjectRef}\`` : "") +
                ` · resolve with \`/hawkmod resolve ${findingId} <note>\``,
            },
          ],
        },
      ],
    });
    if (res.ts) setFindingAlertTs(findingId, res.ts);
  } catch (err) {
    // A failed alert must not abort the sweep; the finding is already durable.
    log.error("could not post finding", { findingId, error: String(err) });
  }
}

export async function postToAlertChannel(text: string): Promise<void> {
  try {
    await botClient().chat.postMessage({
      channel: config().ALERT_CHANNEL_ID,
      text,
    });
  } catch (err) {
    log.error("could not post to alert channel", { error: String(err) });
  }
}
