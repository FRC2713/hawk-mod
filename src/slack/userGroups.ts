import type { WebClient } from "@slack/web-api";
import { log } from "../logger.js";

export type ResolvedGroup = {
  id: string;
  handle: string;
  name: string;
  members: Set<string>;
};

/** Slack ids for user groups are `S` followed by uppercase alphanumerics. */
const GROUP_ID = /^S[A-Z0-9]{4,}$/;

export function isGroupId(ref: string): boolean {
  return GROUP_ID.test(ref.toUpperCase());
}

/**
 * Resolves a user group by its @handle or its id. Handles are what people
 * actually type and see, so they are what the config names; ids are opaque —
 * but an id is what Slack sends when a slash command has link escaping on and
 * somebody types `@students`, which arrives as `<!subteam^S123|students>`.
 *
 * Requires the `usergroups:read` bot scope, and User Groups themselves require
 * a Standard/Business+ plan — they do not exist on the free tier.
 */
export async function resolveGroup(
  client: WebClient,
  ref: string
): Promise<ResolvedGroup | null> {
  const raw = ref.replace(/^@/, "");
  const wanted = raw.toLowerCase();
  const byId = isGroupId(raw) ? raw.toUpperCase() : null;
  const list = await client.usergroups.list({ include_disabled: false });
  const group = (list.usergroups ?? []).find((g) =>
    byId ? g.id === byId : (g.handle ?? "").toLowerCase() === wanted
  );
  if (!group?.id) {
    log.warn("user group not found", { ref });
    return null;
  }

  const members = await client.usergroups.users.list({ usergroup: group.id });
  return {
    id: group.id,
    handle: group.handle ?? wanted,
    name: group.name ?? wanted,
    members: new Set(members.users ?? []),
  };
}

export type SlackProfile = {
  slackUserId: string;
  email: string | null;
  fullName: string;
};

/** Profile fields needed to create a roster row for a group member. */
export async function fetchProfiles(
  client: WebClient,
  slackIds: string[]
): Promise<Map<string, SlackProfile>> {
  const out = new Map<string, SlackProfile>();
  for (const id of slackIds) {
    try {
      const res = await client.users.info({ user: id });
      const u = res.user;
      if (!u) continue;
      out.set(id, {
        slackUserId: id,
        email: u.profile?.email ?? null,
        fullName: u.profile?.real_name ?? u.real_name ?? u.name ?? id,
      });
    } catch (err) {
      log.warn("could not read profile", { user: id, error: String(err) });
    }
  }
  return out;
}

/**
 * Replaces a user group's membership.
 *
 * `usergroups.users.update` takes the *complete* new member list — Slack sells
 * no add-one or remove-one endpoint — which is why every caller goes through a
 * plan rather than mutating a set in place.
 *
 * This must be called with an administrator's user token, not the bot token.
 * Slack accepts a bot token here only when the workspace lets *everyone* edit
 * user groups, and §6 requires that be restricted to Owners and Admins. The
 * restriction is the point, so the token is what changes.
 */
export async function setGroupMembership(
  client: WebClient,
  usergroupId: string,
  userIds: readonly string[]
): Promise<void> {
  if (userIds.length === 0) {
    throw new Error(
      "Refusing to send an empty membership; Slack rejects it and a plan " +
        "should have caught this."
    );
  }
  await client.usergroups.users.update({
    usergroup: usergroupId,
    users: userIds.join(","),
  });
}
