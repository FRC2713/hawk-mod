import type { WebClient } from "@slack/web-api";
import { getConversation, setBackfillCursor } from "../db/repo.js";
import { log } from "../logger.js";
import {
  enrolledAdults,
  verifyEnrollment,
  type Enrollment,
} from "../slack/tokens.js";
import { ensureConversation } from "./conversations.js";
import { recordMessage, type ObservedFile } from "./record.js";

type SlackMessage = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  files?: ObservedFile[];
  reply_count?: number;
};

export type BackfillStats = {
  adultsChecked: number;
  adultsUnavailable: number;
  conversationsSeen: number;
  conversationsMonitored: number;
  messagesRecorded: number;
};

/**
 * Slack's WebClient retries 429s on its own, so these loops do not pace
 * themselves; they will simply take as long as the rate limit says.
 */
async function listDmConversations(
  client: WebClient
): Promise<{ id: string; isMpim: boolean }[]> {
  const out: { id: string; isMpim: boolean }[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.conversations.list({
      types: "im,mpim",
      limit: 200,
      exclude_archived: false,
      cursor,
    });
    for (const c of page.channels ?? []) {
      if (c.id) out.push({ id: c.id, isMpim: Boolean(c.is_mpim) });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

async function ingest(
  e: Enrollment,
  conversationId: string,
  messages: SlackMessage[],
  source: "backfill"
): Promise<number> {
  let recorded = 0;
  for (const m of messages) {
    if (!m.ts) continue;
    // Slackbot and app messages have no user; attribute them to the bot id so
    // the row still exists rather than being dropped.
    const author = m.user ?? m.bot_id ?? "unknown";
    const isNew = await recordMessage(e.client, {
      teamId: e.teamId,
      conversationId,
      observedVia: e.slackUserId,
      ts: m.ts,
      threadTs: m.thread_ts ?? null,
      authorSlackId: author,
      text: m.text ?? null,
      files: m.files,
      subtype: m.subtype ?? null,
      source,
    });
    if (isNew) recorded += 1;
  }
  return recorded;
}

async function backfillConversation(
  e: Enrollment,
  conversationId: string,
  oldest: string | null
): Promise<number> {
  let recorded = 0;
  let latestTs = oldest ?? "0";
  let cursor: string | undefined;

  do {
    const page = await e.client.conversations.history({
      channel: conversationId,
      oldest: oldest ?? undefined,
      inclusive: false,
      limit: 200,
      cursor,
    });
    const messages = (page.messages ?? []) as SlackMessage[];
    recorded += await ingest(e, conversationId, messages, "backfill");

    for (const m of messages) {
      if (m.ts && m.ts > latestTs) latestTs = m.ts;
      // `conversations.history` returns thread parents but not their replies,
      // which is exactly where a conversation would continue unnoticed.
      if (m.ts && (m.reply_count ?? 0) > 0) {
        const replies = await e.client.conversations.replies({
          channel: conversationId,
          ts: m.ts,
          limit: 200,
        });
        const replyMessages = (
          (replies.messages ?? []) as SlackMessage[]
        ).filter((r) => r.ts !== m.ts);
        recorded += await ingest(e, conversationId, replyMessages, "backfill");
        for (const r of replyMessages) {
          if (r.ts && r.ts > latestTs) latestTs = r.ts;
        }
      }
    }

    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  if (latestTs !== (oldest ?? "0")) setBackfillCursor(conversationId, latestTs);
  return recorded;
}

/**
 * Walks every enrolled adult's DM list. This is what catches conversations
 * that predate enrollment and anything that arrived while the process was down
 * — events alone would leave both invisible.
 */
export async function backfillAll(): Promise<BackfillStats> {
  const stats: BackfillStats = {
    adultsChecked: 0,
    adultsUnavailable: 0,
    conversationsSeen: 0,
    conversationsMonitored: 0,
    messagesRecorded: 0,
  };

  for (const adult of enrolledAdults()) {
    if (!(await verifyEnrollment(adult))) {
      stats.adultsUnavailable += 1;
      continue;
    }
    stats.adultsChecked += 1;

    let conversations: { id: string; isMpim: boolean }[];
    try {
      conversations = await listDmConversations(adult.client);
    } catch (err) {
      log.error("could not list conversations", {
        user: adult.slackUserId,
        error: String(err),
      });
      stats.adultsUnavailable += 1;
      continue;
    }

    for (const conversation of conversations) {
      stats.conversationsSeen += 1;
      try {
        const resolved = await ensureConversation(
          adult.client,
          adult.teamId,
          conversation.id,
          adult.slackUserId
        );
        if (!resolved?.verdict.monitored) continue;
        stats.conversationsMonitored += 1;
        stats.messagesRecorded += await backfillConversation(
          adult,
          resolved.id,
          getConversation(resolved.id)?.last_backfill_ts ?? null
        );
      } catch (err) {
        log.error("backfill failed for conversation", {
          conversation: conversation.id,
          error: String(err),
        });
      }
    }
  }

  log.info("backfill complete", { ...stats });
  return stats;
}
