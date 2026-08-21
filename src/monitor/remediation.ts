import { APP_ACTOR } from "../brand.js";
import { config } from "../config.js";
import { closeFinding } from "../close.js";
import {
  getConversation,
  listFindings,
  type ConversationRow,
} from "../db/repo.js";
import {
  describeRemediation,
  remediates,
  type GroupConversation,
  type OneOnOneFinding,
} from "../domain/rules/remediation.js";
import type { DmVerdict } from "../domain/rules/dmPolicy.js";
import { log } from "../logger.js";
import { settingValue } from "../settings.js";
import { botClient } from "../slack/tokens.js";

type FindingDetail = {
  violation?: string;
  students?: string[];
  adults?: string[];
};

/**
 * Closes out 1:1 findings that the adult has since put right by opening a
 * group DM with a second screened adult.
 *
 * Acknowledged, not resolved. The 1:1 still happened and its messages are
 * still on record; what changed is that it no longer needs chasing. A human
 * closing it means "I looked at this", and that distinction is worth keeping
 * for the quarterly review.
 */
export async function remediateOneOnOnes(
  conversationId: string,
  verdict: DmVerdict,
  occurredAt: string
): Promise<number> {
  if (!verdict.monitored || verdict.violation) return 0;
  if (verdict.screenedAdultIds.length < 2) return 0;

  const row: ConversationRow | undefined = getConversation(conversationId);
  if (!row) return 0;

  const group: GroupConversation = {
    id: conversationId,
    lastMessageAt: occurredAt,
    participants: JSON.parse(row.participants) as string[],
    studentIds: verdict.studentIds,
    screenedAdultIds: verdict.screenedAdultIds,
  };

  let closed = 0;
  for (const finding of listFindings("open")) {
    if (finding.kind !== "adult_student_dm") continue;
    let detail: FindingDetail;
    try {
      detail = JSON.parse(finding.detail ?? "{}") as FindingDetail;
    } catch {
      continue;
    }
    if (detail.violation !== "one_to_one_adult_student") continue;

    const candidate: OneOnOneFinding = {
      id: finding.id,
      lastOccurredAt: finding.last_seen_at,
      students: detail.students ?? [],
      adults: detail.adults ?? [],
    };
    if (!remediates(candidate, group)) continue;

    const note = describeRemediation(group);
    await closeFinding(finding.id, APP_ACTOR, note, "acknowledged");
    closed += 1;
    log.info("1:1 finding remediated", {
      finding: finding.id,
      group: group.id,
    });

    // Reply in the alert's own thread so the channel shows the outcome next
    // to the alarm, rather than leaving a violation that looks unanswered.
    if (finding.alert_ts) {
      try {
        const channel = settingValue("alert-channel");
        if (!channel) throw new Error("no alert channel configured");
        await botClient().chat.postMessage({
          channel,
          thread_ts: finding.alert_ts,
          text: `:white_check_mark: Put right — ${note} Acknowledged automatically; the 1:1 messages remain on record.`,
        });
      } catch (err) {
        log.warn("could not post remediation note", { error: String(err) });
      }
    }
  }
  return closed;
}
