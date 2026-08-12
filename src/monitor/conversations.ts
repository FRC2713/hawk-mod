import type { WebClient } from "@slack/web-api";
import {
  getConversation,
  peopleBySlackId,
  upsertConversation,
  type ConversationRow,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import { dedupeKey } from "../domain/findings.js";
import type { Member } from "../domain/people.js";
import {
  classifyConversation,
  type ConversationKind,
  type DmVerdict,
} from "../domain/rules/dmPolicy.js";
import { log } from "../logger.js";
import { raise } from "../raise.js";
import { remediateOneOnOnes } from "./remediation.js";

/** Re-resolve membership at most this often; group DM membership is immutable
 * in Slack, but roster roles and screening dates are not. */
const STALE_MS = 6 * 60 * 60 * 1000;

export type ResolvedConversation = {
  id: string;
  type: ConversationKind;
  participants: string[];
  verdict: DmVerdict;
};

async function fetchParticipants(
  client: WebClient,
  conversationId: string,
  observerId: string
): Promise<{ type: ConversationKind; participants: string[] } | null> {
  const info = await client.conversations.info({ channel: conversationId });
  const channel = info.channel as
    { is_im?: boolean; is_mpim?: boolean; user?: string } | undefined;
  if (!channel) return null;

  if (channel.is_im) {
    // A DM has exactly two parties and `conversations.members` is not available
    // for them; the counterpart comes back on the channel object itself.
    const other = channel.user;
    return {
      type: "im",
      participants: other ? [observerId, other] : [observerId],
    };
  }

  if (!channel.is_mpim) return null;

  const participants: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.members({
      channel: conversationId,
      limit: 200,
      cursor,
    });
    participants.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return { type: "mpim", participants };
}

function toMembers(slackIds: string[]): Member[] {
  const roster = peopleBySlackId();
  return slackIds.map((id) => roster.get(id) ?? { slackUserId: id });
}

function isFresh(row: ConversationRow | undefined): row is ConversationRow {
  if (!row) return false;
  const age = Date.now() - Date.parse(row.last_evaluated_at);
  return age < STALE_MS && row.participants !== "[]";
}

/**
 * Resolves who is in a conversation and what the conduct agreement says about
 * it, caching the answer. Raises a finding the first time a conversation turns
 * out to violate policy — and again if it is re-detected after being resolved.
 */
export async function ensureConversation(
  client: WebClient,
  teamId: string,
  conversationId: string,
  observerId: string,
  opts: { force?: boolean } = {}
): Promise<ResolvedConversation | null> {
  const cached = getConversation(conversationId);
  let type: ConversationKind;
  let participants: string[];

  if (!opts.force && isFresh(cached)) {
    type = cached.type;
    participants = JSON.parse(cached.participants) as string[];
  } else {
    const fetched = await fetchParticipants(client, conversationId, observerId);
    if (!fetched) {
      log.debug("not a DM conversation; ignoring", { conversationId });
      return null;
    }
    type = fetched.type;
    participants = fetched.participants;
  }

  const verdict = classifyConversation(type, toMembers(participants), today());
  upsertConversation({
    id: conversationId,
    teamId,
    type,
    participants,
    monitored: verdict.monitored,
    verdict,
  });

  if (verdict.violation) {
    await raise({
      kind: "adult_student_dm",
      dedupeKey: dedupeKey(
        "adult_student_dm",
        conversationId,
        verdict.violation
      ),
      severity: verdict.severity,
      summary: verdict.summary,
      subjectRef: conversationId,
      detail: {
        type,
        violation: verdict.violation,
        students: verdict.studentIds,
        adults: verdict.adultIds,
        unknown: verdict.unknownIds,
      },
    });
  }

  // A compliant group DM may be the fix for a 1:1 raised earlier.
  if (!verdict.violation && verdict.monitored) {
    await remediateOneOnOnes(conversationId, verdict);
  }

  return { id: conversationId, type, participants, verdict };
}
