import { config } from "../config.js";
import { getFinding, setFindingAlertTs } from "../db/repo.js";
import type { Finding } from "../domain/findings.js";
import { severityEmoji } from "../domain/findings.js";
import { log } from "../logger.js";
import { botClient } from "./tokens.js";

export const ACK_ACTION = "hawkmod_finding_ack";
export const RESOLVE_ACTION = "hawkmod_finding_resolve";

/**
 * One renderer for both the first post and every later update, so a finding
 * that has been closed never keeps offering buttons that no longer apply.
 *
 * Alerts name participants and conversations. They never carry message text —
 * the alert channel is a place to be told something needs a look, not a feed
 * of students' messages. Content stays in the database, behind the CLI.
 */
export function findingBlocks(f: Finding): {
  text: string;
  blocks: unknown[];
} {
  const headline = `${severityEmoji(f.severity)} *${f.kind}* — ${f.summary}`;
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text: headline } },
  ];

  if (f.status === "open") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: RESOLVE_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Resolve" },
          value: String(f.id),
        },
        {
          type: "button",
          action_id: ACK_ACTION,
          text: { type: "plain_text", text: "Acknowledge" },
          value: String(f.id),
        },
      ],
    });
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `finding #${f.id}` +
            (f.subject_ref ? ` · \`${f.subject_ref}\`` : "") +
            " · both ask for a reason, which the quarterly audit reads",
        },
      ],
    });
  } else {
    const verb = f.status === "resolved" ? "Resolved" : "Acknowledged";
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `finding #${f.id} · *${verb}* by ${f.resolved_by ?? "unknown"}` +
            (f.resolved_at ? ` on ${f.resolved_at.slice(0, 10)}` : "") +
            (f.resolution_note ? ` — _${f.resolution_note}_` : ""),
        },
      ],
    });
  }

  return { text: headline, blocks };
}

export async function postFinding(findingId: number): Promise<void> {
  const finding = getFinding(findingId);
  if (!finding) return;
  const { text, blocks } = findingBlocks(finding);
  try {
    const res = await botClient().chat.postMessage({
      channel: config().ALERT_CHANNEL_ID,
      text,
      blocks: blocks as never,
    });
    if (res.ts) setFindingAlertTs(findingId, res.ts);
  } catch (err) {
    // A failed alert must not abort the sweep; the finding is already durable.
    log.error("could not post finding", { findingId, error: String(err) });
  }
}

/** Redraws a finding's message in place — used after it is closed. */
export async function refreshFinding(findingId: number): Promise<void> {
  const finding = getFinding(findingId);
  if (!finding?.alert_ts) return;
  const { text, blocks } = findingBlocks(finding);
  try {
    await botClient().chat.update({
      channel: config().ALERT_CHANNEL_ID,
      ts: finding.alert_ts,
      text,
      blocks: blocks as never,
    });
  } catch (err) {
    log.warn("could not update finding message", {
      findingId,
      error: String(err),
    });
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
