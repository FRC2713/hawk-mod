import { WebClient } from "@slack/web-api";
import { config, managedGroupHandles } from "../config.js";
import { getInstallation, insertGroupChange } from "../db/repo.js";
import type { Person } from "../domain/people.js";
import {
  planAdd,
  planRemove,
  reducesMonitoring,
  type GroupPlan,
} from "../domain/rules/groupMembership.js";
import { log } from "../logger.js";
import type { Actor } from "./authz.js";
import { resolveGroup, setGroupMembership } from "./userGroups.js";

export type GroupEditOutcome =
  | {
      ok: true;
      plan: GroupPlan;
      handle: string;
      noop: boolean;
      /** This edit ended someone's monitoring as a student. */
      reducedMonitoring: boolean;
    }
  | { ok: false; reason: string; needsAuthorization?: boolean }
  /**
   * Refused for want of a reason. Raised here rather than in the command
   * handler because only this side knows the group's handle: an escaped
   * mention arrives as an opaque id.
   */
  | { ok: false; needsReason: true; handle: string; reason: string };

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
 * Deliberately does not touch the roster. Slack fires `subteam_members_changed`
 * on a successful write, and the existing sync reconciles from that — so there
 * is still exactly one path from a group to a role, whether the group was
 * edited here or by hand in Slack. Writing the roster here as well would give
 * that fact two doors, and they would disagree the first time one of them
 * failed.
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

    // Moving a student into the mentors group ends their monitoring as a
    // student. Allowed — refusing would only push the same act into Slack's own
    // UI, where hawk-mod learns of it from an event with no author and no
    // reason — but never silently, and never by typo.
    const reduces =
      "role" in req.subject &&
      reducesMonitoring({
        action: req.action,
        subjectRole: req.subject.role,
        handle: group.handle,
        adultHandle: config().ADULT_USERGROUP ?? "mentors",
      });

    if (reduces && !req.reason) {
      return {
        ok: false as const,
        needsReason: true as const,
        handle: group.handle,
        reason:
          `Adding a student to @${group.handle} ends their monitoring as a ` +
          `student, so this one needs a reason.`,
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
        reducedMonitoring: false,
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
      reducedMonitoring: reduces,
    };
  });
}
