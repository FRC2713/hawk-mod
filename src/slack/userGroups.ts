import type { WebClient } from "@slack/web-api";
import { log } from "../logger.js";

export type ResolvedGroup = {
  id: string;
  handle: string;
  name: string;
  members: Set<string>;
};

/**
 * Resolves a user group by its @handle. Handles are what people actually type
 * and see, so they are what the config names; ids are opaque.
 *
 * Requires the `usergroups:read` bot scope, and User Groups themselves require
 * a Standard/Business+ plan — they do not exist on the free tier.
 */
export async function resolveGroup(
  client: WebClient,
  handle: string
): Promise<ResolvedGroup | null> {
  const wanted = handle.replace(/^@/, "").toLowerCase();
  const list = await client.usergroups.list({ include_disabled: false });
  const group = (list.usergroups ?? []).find(
    (g) => (g.handle ?? "").toLowerCase() === wanted
  );
  if (!group?.id) {
    log.warn("user group not found", { handle });
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
