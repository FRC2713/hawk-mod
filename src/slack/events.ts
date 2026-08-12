import type { App } from "@slack/bolt";
import {
  listConsents,
  markInstallationRevoked,
  personBySlackId,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import { dedupeKey } from "../domain/findings.js";
import { consentStatus, mayHoldAccount } from "../domain/rules/consent.js";
import { log } from "../logger.js";
import { evaluateChannel } from "../monitor/channels.js";
import {
  recordDeletion,
  recordEdit,
  recordMessage,
  type ObservedFile,
} from "../monitor/record.js";
import { syncRolesFromUserGroups } from "../jobs/syncRoles.js";
import { raise } from "../raise.js";
import { botClient, userClient } from "./tokens.js";

type MessageLike = {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  files?: ObservedFile[];
};

type MessageEvent = MessageLike & {
  channel?: string;
  channel_type?: string;
  deleted_ts?: string;
  message?: MessageLike;
  previous_message?: MessageLike;
};

type EventBody = {
  team_id?: string;
  authorizations?: { user_id?: string; is_bot?: boolean }[];
};

/**
 * Which adult's token surfaced this event. Slack delivers one copy per
 * authorization, so two enrolled adults in the same group DM produce two
 * events; the (conversation, ts) uniqueness in the log absorbs the duplicate.
 */
function observerOf(body: EventBody): string | null {
  const auth =
    body.authorizations?.find((a) => !a.is_bot) ?? body.authorizations?.[0];
  return auth?.user_id ?? null;
}

export function registerEvents(app: App): void {
  app.event("message", async ({ event, body }) => {
    const e = event as MessageEvent;
    const channelType = e.channel_type;
    if (channelType !== "im" && channelType !== "mpim") return;
    if (!e.channel) return;

    const teamId = (body as EventBody).team_id;
    const observer = observerOf(body as EventBody);
    if (!teamId || !observer) return;

    // DMs are only readable with the observing adult's own token; the bot
    // token cannot see them at all.
    const asUser = userClient(teamId, observer);
    if (!asUser) {
      log.warn("event for a adult with no usable token", { observer });
      return;
    }

    try {
      if (e.subtype === "message_deleted") {
        const ts = e.deleted_ts;
        if (!ts) return;
        const previous = e.previous_message;
        if (previous?.ts) {
          // Record what was deleted before tombstoning it, so a message that
          // arrived and vanished between sweeps still leaves a trace.
          await recordMessage(asUser, {
            teamId,
            conversationId: e.channel,
            observedVia: observer,
            ts: previous.ts,
            threadTs: previous.thread_ts ?? null,
            authorSlackId: previous.user ?? previous.bot_id ?? "unknown",
            text: previous.text ?? null,
            files: previous.files,
            subtype: previous.subtype ?? null,
            source: "event",
          });
        }
        recordDeletion(e.channel, ts);
        return;
      }

      if (e.subtype === "message_changed") {
        const changed = e.message;
        if (!changed?.ts) return;
        const updated = recordEdit(e.channel, changed.ts, changed.text);
        if (!updated) {
          await recordMessage(asUser, {
            teamId,
            conversationId: e.channel,
            observedVia: observer,
            ts: changed.ts,
            threadTs: changed.thread_ts ?? null,
            authorSlackId: changed.user ?? changed.bot_id ?? "unknown",
            text: changed.text ?? null,
            files: changed.files,
            subtype: "message_changed",
            source: "event",
          });
        }
        return;
      }

      if (!e.ts) return;
      await recordMessage(asUser, {
        teamId,
        conversationId: e.channel,
        observedVia: observer,
        ts: e.ts,
        threadTs: e.thread_ts ?? null,
        authorSlackId: e.user ?? e.bot_id ?? "unknown",
        text: e.text ?? null,
        files: e.files,
        subtype: e.subtype ?? null,
        source: "event",
      });
    } catch (err) {
      log.error("failed to handle DM event", {
        conversation: e.channel,
        error: String(err),
      });
    }
  });

  app.event("member_joined_channel", async ({ event, client }) => {
    await evaluateChannel(client, event.channel);
  });

  app.event("member_left_channel", async ({ event, client }) => {
    await evaluateChannel(client, event.channel);
  });

  /**
   * The consent gate, at the only moment it can still be enforced cheaply: a
   * student account that exists without a signed form on file is a finding the
   * instant it appears, not at the next quarterly audit.
   */
  app.event("team_join", async ({ event }) => {
    const user = event.user as { id?: string; is_bot?: boolean; name?: string };
    if (!user.id || user.is_bot) return;
    const person = personBySlackId(user.id);
    if (!person) {
      await raise({
        kind: "unknown_account",
        dedupeKey: dedupeKey("unknown_account", user.id),
        severity: "violation",
        summary: `New Slack account <@${user.id}> is not on the roster.`,
        subjectRef: user.id,
      });
      return;
    }
    const status = consentStatus(person, listConsents(), today());
    if (!mayHoldAccount(status)) {
      await raise({
        kind: "unconsented_account",
        dedupeKey: dedupeKey("unconsented_account", String(person.id)),
        severity: "violation",
        summary: `${person.full_name} joined the workspace but consent is ${status.state}.`,
        subjectPersonId: person.id,
        subjectRef: user.id,
        detail: { state: status.state },
      });
    }
  });

  /**
   * Editing a user group is how someone joins the roster, so it has to take
   * effect when they edit it — not at 3am. Slack sends several of these for a
   * single edit; the sync is idempotent, so re-running is harmless.
   */
  for (const name of [
    "subteam_members_changed",
    "subteam_updated",
    "subteam_created",
  ] as const) {
    app.event(name, async () => {
      try {
        const stats = await syncRolesFromUserGroups(botClient());
        log.info("roles resynced after a user group changed", { ...stats });
      } catch (err) {
        log.error("user group resync failed", { error: String(err) });
      }
    });
  }

  app.event("tokens_revoked", async ({ event, body }) => {
    const teamId = (body as EventBody).team_id;
    const revoked = event.tokens as { oauth?: string[]; bot?: string[] };
    if (!teamId) return;
    for (const userId of revoked.oauth ?? []) {
      markInstallationRevoked(teamId, "user", userId);
      const person = personBySlackId(userId);
      await raise({
        kind: "enrollment_revoked",
        dedupeKey: dedupeKey(
          "enrollment_revoked",
          person ? String(person.id) : userId
        ),
        severity: "violation",
        summary: `${person?.full_name ?? `<@${userId}>`} revoked hawk-mod. Their DMs are no longer monitored.`,
        subjectPersonId: person?.id ?? null,
        subjectRef: userId,
      });
    }
  });
}
