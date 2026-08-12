import type { WebClient } from "@slack/web-api";
import {
  linkSlackAccount,
  listPeople,
  personByEmail,
  peopleBySlackId,
} from "../db/repo.js";
import type { Member } from "../domain/people.js";
import type { ChannelMembership } from "../domain/rules/twoAdults.js";
import { log } from "../logger.js";

export type SlackUser = {
  id: string;
  name: string;
  realName: string;
  email: string | null;
  isBot: boolean;
  isDeleted: boolean;
  isOwner: boolean;
  isAdmin: boolean;
};

export async function fetchWorkspaceUsers(
  client: WebClient
): Promise<SlackUser[]> {
  const users: SlackUser[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.users.list({ limit: 200, cursor });
    for (const m of page.members ?? []) {
      if (!m.id) continue;
      users.push({
        id: m.id,
        name: m.name ?? m.id,
        realName: m.profile?.real_name ?? m.real_name ?? m.name ?? m.id,
        email: m.profile?.email ?? null,
        isBot: Boolean(m.is_bot) || m.id === "USLACKBOT",
        isDeleted: Boolean(m.deleted),
        isOwner: Boolean(m.is_owner) || Boolean(m.is_primary_owner),
        isAdmin: Boolean(m.is_admin),
      });
    }
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return users;
}

export type RosterSync = {
  linked: number;
  /** Live human accounts with no roster row — nobody knows who these are. */
  unknown: SlackUser[];
  /** Roster people who have no Slack account yet. */
  withoutAccounts: string[];
};

/**
 * Email is the join key: the roster is maintained off-Slack (signed forms,
 * screening records) and Slack ids only exist once someone actually signs up.
 */
export async function syncSlackAccounts(
  client: WebClient
): Promise<{ sync: RosterSync; users: SlackUser[] }> {
  const users = await fetchWorkspaceUsers(client);
  const sync: RosterSync = { linked: 0, unknown: [], withoutAccounts: [] };

  for (const u of users) {
    if (u.isBot || u.isDeleted) continue;
    const person = u.email ? personByEmail(u.email) : undefined;
    if (!person) {
      sync.unknown.push(u);
      continue;
    }
    if (person.slack_user_id !== u.id) {
      linkSlackAccount(person.id, u.id);
      sync.linked += 1;
      log.info("linked slack account", { person: person.email, slackId: u.id });
    }
  }

  for (const p of listPeople(true)) {
    if (!p.slack_user_id) sync.withoutAccounts.push(p.email);
  }

  return { sync, users };
}

/**
 * Public channels are listed whether or not hawk-mod is a member; private ones
 * are only visible once it is invited. `channelsNotVisible` is therefore the
 * honest count of what this check could not see.
 */
export async function channelMemberships(
  client: WebClient,
  skipIds: ReadonlySet<string> = new Set()
): Promise<ChannelMembership[]> {
  const roster = peopleBySlackId();
  const channels: ChannelMembership[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    for (const c of page.channels ?? []) {
      if (!c.id) continue;
      const members: Member[] = [];
      let memberCursor: string | undefined;
      try {
        do {
          const mp = await client.conversations.members({
            channel: c.id,
            limit: 200,
            cursor: memberCursor,
          });
          for (const id of mp.members ?? []) {
            // Bots and hawk-mod itself are not people; counting them as
            // unidentified accounts would bury the real ones.
            if (skipIds.has(id)) continue;
            members.push(roster.get(id) ?? { slackUserId: id });
          }
          memberCursor = mp.response_metadata?.next_cursor || undefined;
        } while (memberCursor);
      } catch (err) {
        log.warn("could not read channel members", {
          channel: c.name,
          error: String(err),
        });
        continue;
      }

      channels.push({
        channelId: c.id,
        channelName: c.name ?? c.id,
        isPrivate: Boolean(c.is_private),
        members,
      });
    }

    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return channels;
}
