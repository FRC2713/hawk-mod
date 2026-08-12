import type { WebClient } from "@slack/web-api";
import { logMode } from "../config.js";
import {
  applyEdit,
  insertMessage,
  markMessageDeleted,
  personBySlackId,
} from "../db/repo.js";
import { log } from "../logger.js";
import {
  ensureConversation,
  raiseDmViolation,
  remediateFromMessage,
} from "./conversations.js";

export type ObservedFile = {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
};

export type ObservedMessage = {
  teamId: string;
  conversationId: string;
  /** Slack id of the adult whose token surfaced this message. */
  observedVia: string;
  ts: string;
  threadTs?: string | null;
  authorSlackId: string;
  text?: string | null;
  files?: ObservedFile[];
  subtype?: string | null;
  source: "event" | "backfill";
};

function bodyToStore(text: string | null | undefined): {
  text: string | null;
  charCount: number;
} {
  const raw = text ?? "";
  return {
    text: logMode() === "full" ? raw : null,
    charCount: raw.length,
  };
}

function fileMeta(files: ObservedFile[] | undefined) {
  if (!files?.length) return undefined;
  // Names and types only. Downloading a student's DM attachments would put that
  // content on this host; the file ids are enough to retrieve one later if an
  // investigation actually needs it.
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    mimetype: f.mimetype,
    size: f.size,
  }));
}

/**
 * Persists a message from a monitored conversation. Conversations without a
 * student in them are classified and then dropped on the floor — hawk-mod is
 * not a general archive of the adults' Slack.
 */
export async function recordMessage(
  client: WebClient,
  msg: ObservedMessage
): Promise<boolean> {
  const conversation = await ensureConversation(
    client,
    msg.teamId,
    msg.conversationId,
    msg.observedVia
  );
  if (!conversation?.verdict.monitored) return false;

  const { text, charCount } = bodyToStore(msg.text);
  const inserted = insertMessage({
    conversationId: msg.conversationId,
    ts: msg.ts,
    threadTs: msg.threadTs ?? null,
    authorSlackId: msg.authorSlackId,
    authorPersonId: personBySlackId(msg.authorSlackId)?.id ?? null,
    text,
    charCount,
    files: fileMeta(msg.files),
    subtype: msg.subtype ?? null,
    source: msg.source,
    observedVia: msg.observedVia,
  });

  if (inserted) {
    // Only for a message we had not already recorded. The backfill re-walks
    // conversations that have not changed, and both adults in a group DM deliver
    // the same event twice; neither is a new violation to report.
    await raiseDmViolation(conversation, msg.ts);
    await remediateFromMessage(conversation, msg.ts);
    log.debug("recorded monitored message", {
      conversation: msg.conversationId,
      ts: msg.ts,
      source: msg.source,
    });
  }
  return inserted;
}

/** False when the original was never observed; the caller should record it. */
export function recordEdit(
  conversationId: string,
  ts: string,
  newText: string | null | undefined
): boolean {
  const { text, charCount } = bodyToStore(newText);
  return applyEdit(conversationId, ts, text, charCount);
}

export function recordDeletion(conversationId: string, ts: string): void {
  markMessageDeleted(conversationId, ts);
}
