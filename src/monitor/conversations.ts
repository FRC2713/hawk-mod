import type { WebClient } from "@slack/web-api";
import {
  getConversation,
  monitoredConversations,
  peopleBySlackId,
  upsertConversation,
  type ConversationRow,
} from "../db/repo.js";
import { today, tsToIso, type IsoDate } from "../domain/dates.js";
import { dedupeKey } from "../domain/findings.js";
import type { Member } from "../domain/people.js";
import {
  classifyConversation,
  type ConversationKind,
  type DmVerdict,
} from "../domain/rules/dmPolicy.js";
import { log } from "../logger.js";
import { raise } from "../raise.js";
import { nudgeAdults } from "../slack/guidance.js";
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
 * it, caching the answer.
 *
 * Deliberately raises nothing. This runs on every message and on every hourly
 * backfill pass over every DM the enrolled adults have, so "we evaluated it"
 * carries no information about whether anything happened. `raiseDmViolation`
 * is the half that reports, and it is driven by a message.
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

  return { id: conversationId, type, participants, verdict };
}

/**
 * Notes that a compliant conversation has just been spoken in, which may be an
 * adult putting an earlier 1:1 right.
 *
 * Driven by the message for the same reason the raise is: the group merely
 * existing proves nothing — teams have standing group chats — whereas a message
 * in it after the 1:1 is the conversation actually moving.
 */
export async function remediateFromMessage(
  conversation: ResolvedConversation,
  ts: string
): Promise<void> {
  const { id, verdict } = conversation;
  if (verdict.violation || !verdict.monitored) return;
  await remediateOneOnOnes(id, verdict, tsToIso(ts));
}

/**
 * Reports a prohibited conversation, on the strength of a message that has just
 * been recorded for the first time.
 *
 * The message is the trigger, not the evaluation: a DM stays in an adult's
 * conversation list forever, so re-walking one that was already dealt with must
 * not raise the alarm again, and a new message in one that was must. `occurredAt`
 * is the message's own Slack timestamp, so backfilled history that predates a
 * closure is correctly read as old news rather than as a fresh violation.
 */
export async function raiseDmViolation(
  conversation: ResolvedConversation,
  ts: string
): Promise<void> {
  const { id, type, verdict } = conversation;
  if (!verdict.violation) return;

  const { alerted } = await raise(
    {
      kind: "adult_student_dm",
      dedupeKey: dedupeKey("adult_student_dm", id, verdict.violation),
      severity: verdict.severity,
      summary: verdict.summary,
      subjectRef: id,
      detail: {
        type,
        violation: verdict.violation,
        students: verdict.studentIds,
        adults: verdict.adultIds,
        unknown: verdict.unknownIds,
      },
    },
    { at: tsToIso(ts) }
  );

  // Only when the Lead Coaches were told. Guidance rides on the alert rather
  // than on the message, so an adult gets one nudge per occurrence instead of
  // one per line they type — and it never quietly replaces the finding.
  if (alerted) await nudgeAdults(verdict);
}

/**
 * Re-runs the verdict over conversations already on record, using stored
 * membership and today's roles and screening dates.
 *
 * Nobody has to say anything for a group DM to become a violation: an adult's
 * screening lapsing is enough, and so is a participant being moved into the
 * students group. With the alarm otherwise tied to messages, a conversation that
 * has gone quiet would go unreported until someone next spoke — which is the
 * failure this whole system is against.
 *
 * Anchored to the newest message on record, so re-reading a conversation a
 * human has already closed off does not bring it back.
 */
export async function reevaluateRecorded(
  asOf: IsoDate = today()
): Promise<{ checked: number; violations: number }> {
  let checked = 0;
  let violations = 0;

  for (const row of monitoredConversations()) {
    // Nothing recorded yet means no conduct to report and nothing to anchor to;
    // the backfill will raise it when it walks the history.
    if (!row.lastMessageTs) continue;
    checked += 1;

    const participants = JSON.parse(row.participants) as string[];
    const verdict = classifyConversation(
      row.type,
      toMembers(participants),
      asOf
    );
    if (!verdict.violation) continue;

    violations += 1;
    await raiseDmViolation(
      { id: row.id, type: row.type, participants, verdict },
      row.lastMessageTs
    );
  }

  return { checked, violations };
}
