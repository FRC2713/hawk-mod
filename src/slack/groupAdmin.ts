import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { getInstallation, insertGroupChange } from "../db/repo.js";
import type { Person } from "../domain/people.js";
import {
  planAdd,
  planRemove,
  type GroupPlan,
} from "../domain/rules/groupMembership.js";
import { log } from "../logger.js";
import { managedGroupHandles, settingValue } from "../settings.js";
import type { Actor } from "./authz.js";
import { resolveGroup, setGroupMembership } from "./userGroups.js";

export type GroupEditOutcome =
  | {
      ok: true;
      plan: GroupPlan;
      handle: string;
      noop: boolean;
    }
  | { ok: false; reason: string; needsAuthorization?: boolean };

/**
 * Serializes group writes within this process.
 *
 * Every edit is a read-modify-write against an endpoint that replaces the whole
 * member list, so two overlapping edits lose one of them. hawk-mod is a single
 * container, so one lock genuinely closes the door on hawk-mod racing itself —
 * a command running while an event-driven resync or a sheet sync is in flight.
 *
 * It cannot close the door on hawk-mod racing a human in Slack's own UI; Slack
 * offers no compare-and-swap on this endpoint. Re-reading membership inside the
 * lock, immediately before writing, keeps that window to about one round trip.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The administrator's own Slack client for group edits.
 *
 * Not the bot's. Slack accepts a bot token for `usergroups.users.update` only
 * when the workspace lets everyone edit user groups, which §6 forbids — so the
 * write goes out as the administrator who asked for it, which also means Slack
 * attributes the change to a real person.
 */
function adminClient(teamId: string, slackUserId: string): WebClient | null {
  const row = getInstallation(teamId, "admin", slackUserId);
  if (!row || row.revokedAt) return null;
  const payload = row.payload as { user?: { token?: string } };
  const token = payload.user?.token;
  return token ? new WebClient(token) : null;
}

/**
 * Runs `fn` with an administrator's own group-editing client, inside the same
 * lock as every other group write, or says they must authorize first. For the
 * lifecycle Slack copies (step 5), which re-read the sheet and the groups
 * inside `fn` so what is applied is what differs at the click.
 */
export async function withGroupEditor<T>(
  teamId: string,
  slackUserId: string,
  fn: (editor: WebClient) => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const client = adminClient(teamId, slackUserId);
  if (!client) {
    return {
      ok: false,
      reason:
        `hawk-mod needs your permission to edit user groups on your behalf. ` +
        `Authorize once here, then click again: ${authorizeUrl()}`,
    };
  }
  return serialize(async () => ({
    ok: true as const,
    value: await fn(client),
  }));
}

/** Where an administrator goes to grant group-editing permission. */
export function authorizeUrl(): string {
  return `${config().PUBLIC_URL}/slack/authorize-groups`;
}

export type GroupEditRequest = {
  teamId: string;
  actor: Actor;
  /** `@handle`, a raw handle, or a Slack group id from an escaped mention. */
  groupRef: string;
  action: "add" | "remove";
  subject: Person | { slackUserId: string };
  /** Required only when the edit reduces someone's monitoring. */
  reason: string | null;
  source: "command" | "sheet_sync";
};

function subjectId(s: GroupEditRequest["subject"]): string {
  return "id" in s ? (s.slack_user_id ?? "") : s.slackUserId;
}

function subjectPersonId(s: GroupEditRequest["subject"]): number | null {
  return "id" in s ? s.id : null;
}

/**
 * Applies one membership edit, or explains why it did not.
 *
 * Deliberately does not touch the roster, and no longer changes anyone's
 * role at all: roles come from the lifecycle sheet, and a user group is for
 * mentions and channel access. Adding a student to @mentors makes them
 * mentionable as a mentor and nothing else — so the reason this used to demand
 * for that edit went with the role sync.
 */
export async function applyGroupEdit(
  req: GroupEditRequest
): Promise<GroupEditOutcome> {
  const target = subjectId(req.subject);
  if (!target) {
    return { ok: false, reason: "That person has no linked Slack account." };
  }

  const client = adminClient(req.teamId, req.actor.slackUserId);
  if (!client) {
    return {
      ok: false,
      needsAuthorization: true,
      reason:
        `hawk-mod needs your permission to edit user groups on your behalf. ` +
        `Slack will not let it do this as itself while group editing is ` +
        `restricted to admins, which is the correct setting.\n` +
        `Authorize once here: ${authorizeUrl()}`,
    };
  }

  return serialize(async () => {
    // Read inside the lock so the plan reflects membership as it is now, not
    // as it was when the command was typed.
    const group = await resolveGroup(client, req.groupRef);
    if (!group) {
      return {
        ok: false as const,
        reason: `No user group \`${req.groupRef}\`.`,
      };
    }

    if (!managedGroupHandles().has(group.handle.toLowerCase())) {
      return {
        ok: false as const,
        reason:
          `hawk-mod is not configured to edit @${group.handle}. Add it to ` +
          `MANAGED_USERGROUPS if it should be manageable here, or edit it in ` +
          `Slack directly.`,
      };
    }

    const plan =
      req.action === "add"
        ? planAdd(group.members, target)
        : planRemove(group.members, target);

    if (plan.refusal) {
      return { ok: false as const, reason: plan.refusal };
    }

    if (plan.add.length === 0 && plan.remove.length === 0) {
      return {
        ok: true as const,
        plan,
        handle: group.handle,
        noop: true,
      };
    }

    await setGroupMembership(client, group.id, plan.result);

    insertGroupChange({
      usergroupId: group.id,
      handle: group.handle,
      action: req.action,
      subject: target,
      personId: subjectPersonId(req.subject),
      actor: req.actor.slackUserId,
      actorName: req.actor.name,
      reason: req.reason,
      source: req.source,
    });

    log.info("user group edited", {
      handle: group.handle,
      action: req.action,
      subject: target,
      actor: req.actor.slackUserId,
    });

    return {
      ok: true as const,
      plan,
      handle: group.handle,
      noop: false,
    };
  });
}
