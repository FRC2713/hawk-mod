import type { JWT } from "google-auth-library";
import type {
  DomainGroup,
  GroupRole,
  OffboardingAccount,
} from "../domain/lifecycle/offboarding.js";

/**
 * Google's Directory API, for group membership — and, in this step, only for
 * reading it.
 *
 * The two scopes are the ones delegated in the Admin console
 * (docs/google-setup.md, Part 2), and deliberately not the broad
 * `admin.directory.group`, which could also create and delete groups: reading
 * groups, and reading or changing their members, is all hawk-mod ever does.
 */
export const DIRECTORY_GROUP_READONLY =
  "https://www.googleapis.com/auth/admin.directory.group.readonly";
export const DIRECTORY_GROUP_MEMBER =
  "https://www.googleapis.com/auth/admin.directory.group.member";

const API = "https://admin.googleapis.com/admin/directory/v1";

export type MembersPage = {
  members?: { email?: string; type?: string }[];
  nextPageToken?: string;
};

/** One page of members as lower-cased addresses; blank entries dropped. */
export function pageAddresses(page: MembersPage): string[] {
  return (page.members ?? [])
    .map((m) => m.email?.toLowerCase())
    .filter((a): a is string => Boolean(a));
}

/**
 * Google's own reason, from its JSON error body — "Not Authorized to access
 * this resource/api", say. It names a setting or a rule, never the key, and
 * any address in it is blanked.
 */
export function googleReason(err: unknown): string {
  const e = err as {
    response?: { data?: { error?: { message?: string } | string } };
    message?: unknown;
  };
  const body = e.response?.data?.error;
  const reason = typeof body === "string" ? body : body?.message;
  // These messages can reach Slack. Google does not normally quote the member
  // it refused, but if it ever does, it is a minor's or a parent's address.
  return (reason || String(e.message ?? err)).replace(
    /[^\s@<>()"']+@[^\s@<>()"']+/g,
    "<address>"
  );
}

/**
 * Turns Google's refusals into something an administrator can act on, with
 * Google's own reason after it. The messages name settings, never the key.
 */
function explain(err: unknown, group: string): Error {
  const status = (err as { status?: number }).status;
  const text = String((err as { message?: unknown }).message ?? err);
  const google = ` (Google said: ${googleReason(err)})`;
  if (text.includes("unauthorized_client")) {
    return new Error(
      "Google refused to let the service account act as hawk-mod@. Check the " +
        "domain-wide delegation entry for its client ID lists both group scopes " +
        "(docs/google-setup.md, Part 2)." +
        google
    );
  }
  if (status === 403) {
    return new Error(
      `Google refused to read ${group}. Check that hawk-mod@ holds the ` +
        `"hawk-mod group membership" admin role with Groups → Read.` +
        google
    );
  }
  return new Error(`${text}${google}`);
}

/** A group as Google has it now: what the report shows beside its ID. */
export type GroupInfo = {
  id: string;
  name: string;
  email: string;
  members: string[];
};

/**
 * A group, read by its permanent ID: its current name and address, and every
 * direct member. `null` if no group has that ID any more.
 */
export async function readGroup(
  client: JWT,
  id: string
): Promise<GroupInfo | null> {
  let group: { id?: string; name?: string; email?: string };
  try {
    const res = await client.request<typeof group>({
      url: `${API}/groups/${encodeURIComponent(id)}?fields=id,name,email`,
    });
    group = res.data;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw explain(err, `the group with ID ${id}`);
  }
  const members = await readGroupMembers(client, id);
  if (members === null) return null;
  return {
    id,
    name: group.name ?? "",
    email: (group.email ?? "").toLowerCase(),
    members,
  };
}

/**
 * Every direct member of one group, as lower-cased addresses, or `null` if
 * the group does not exist. Groups are kept flat, so a member that is itself
 * a group is read as an address like any other — and, since no one on the
 * sheet is added by a group's address, the planner holds it for a person.
 */
export async function readGroupMembers(
  client: JWT,
  groupKey: string
): Promise<string[] | null> {
  const members: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      maxResults: "200",
      fields: "members(email,type),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    });
    let page: MembersPage;
    try {
      const res = await client.request<MembersPage>({
        url: `${API}/groups/${encodeURIComponent(groupKey)}/members?${params}`,
      });
      page = res.data;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw explain(err, groupKey);
    }
    members.push(...pageAddresses(page));
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return members;
}

export type GroupsPage = {
  groups?: { id?: string; name?: string }[];
  nextPageToken?: string;
};

export type RolesPage = {
  members?: { email?: string; role?: string }[];
  nextPageToken?: string;
};

/**
 * One page of members with the role each holds, addresses lower-cased and
 * blank entries (a whole-domain member has no address) dropped. Anything
 * Google calls neither owner nor manager is a member.
 */
export function pageMembersWithRoles(page: RolesPage): DomainGroup["members"] {
  return (page.members ?? []).flatMap((m) => {
    if (!m.email) return [];
    const role: GroupRole =
      m.role === "OWNER" || m.role === "MANAGER" ? m.role : "MEMBER";
    return [{ address: m.email.toLowerCase(), role }];
  });
}

/**
 * Every group in the Workspace — not just the nine the sheet computes — with
 * each direct member and the role they hold there (step 7: Remove from groups
 * reaches all of them). Groups → Read and the group scopes already cover it.
 * One request for the list, and one per group for its members.
 */
export async function listDomainGroups(client: JWT): Promise<DomainGroup[]> {
  const listed: { id: string; name: string }[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      customer: "my_customer",
      maxResults: "200",
      fields: "groups(id,name),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    });
    let page: GroupsPage;
    try {
      const res = await client.request<GroupsPage>({
        url: `${API}/groups?${params}`,
      });
      page = res.data;
    } catch (err) {
      throw explain(err, "the list of groups");
    }
    for (const g of page.groups ?? []) {
      if (g.id) listed.push({ id: g.id, name: g.name ?? "" });
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);

  const groups: DomainGroup[] = [];
  for (const g of listed) {
    const members: DomainGroup["members"][number][] = [];
    let token: string | undefined;
    let gone = false;
    do {
      const params = new URLSearchParams({
        maxResults: "200",
        fields: "members(email,role),nextPageToken",
        ...(token ? { pageToken: token } : {}),
      });
      let page: RolesPage;
      try {
        const res = await client.request<RolesPage>({
          url: `${API}/groups/${encodeURIComponent(g.id)}/members?${params}`,
        });
        page = res.data;
      } catch (err) {
        // Deleted between the list and now: not a group any more.
        if ((err as { status?: number }).status === 404) {
          gone = true;
          break;
        }
        throw explain(err, g.name || `the group with ID ${g.id}`);
      }
      members.push(...pageMembersWithRoles(page));
      token = page.nextPageToken || undefined;
    } while (token);
    if (!gone) groups.push({ ...g, members });
  }
  return groups;
}

/**
 * Adds one address to a group as a plain member. Already a member is success:
 * the plan was read moments ago, and someone may have added them meanwhile.
 */
export async function addMember(
  client: JWT,
  groupId: string,
  email: string
): Promise<void> {
  try {
    await client.request({
      url: `${API}/groups/${encodeURIComponent(groupId)}/members`,
      method: "POST",
      data: { email, role: "MEMBER" },
    });
  } catch (err) {
    if ((err as { status?: number }).status === 409) return;
    throw new Error(googleReason(err));
  }
}

/** Removes one address from a group. Already gone is success. */
export async function removeMember(
  client: JWT,
  groupId: string,
  email: string
): Promise<void> {
  try {
    await client.request({
      url: `${API}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(email)}`,
      method: "DELETE",
    });
  } catch (err) {
    if ((err as { status?: number }).status === 404) return;
    throw new Error(googleReason(err));
  }
}

/**
 * Reading user accounts, for step 6: is each mentor's RHR Email a real,
 * working account? And for step 7: does a leaver's account hold an admin
 * role, which only a Super Admin can change? Read-only, and delegated on its own line
 * (docs/google-setup.md), with Users → Read added to hawk-mod@'s role.
 * Asked for in a client of its own, so a refusal names exactly the setting
 * that is missing rather than failing the groups run too.
 */
export const DIRECTORY_USER_READONLY =
  "https://www.googleapis.com/auth/admin.directory.user.readonly";

export type UsersPage = {
  users?: {
    primaryEmail?: string;
    aliases?: string[];
    nonEditableAliases?: string[];
    suspended?: boolean;
    isAdmin?: boolean;
    isDelegatedAdmin?: boolean;
  }[];
  nextPageToken?: string;
};

/**
 * One page of users as directory accounts, addresses lower-cased. `admin`
 * is a Super Admin or any delegated admin role, Help Desk included: Google
 * lets only a Super Admin change such an account.
 */
export function pageUsers(page: UsersPage): OffboardingAccount[] {
  return (page.users ?? []).flatMap((u) =>
    u.primaryEmail
      ? [
          {
            primaryEmail: u.primaryEmail.toLowerCase(),
            aliases: [
              ...(u.aliases ?? []),
              ...(u.nonEditableAliases ?? []),
            ].map((a) => a.toLowerCase()),
            suspended: Boolean(u.suspended),
            admin: Boolean(u.isAdmin || u.isDelegatedAdmin),
          },
        ]
      : []
  );
}

/**
 * Every user account in the Workspace: its primary address, its aliases,
 * whether it is suspended, and whether it holds an admin role. Nothing else
 * is requested — not names, not phone numbers, not the org unit.
 */
export async function listDomainUsers(
  client: JWT
): Promise<OffboardingAccount[]> {
  const accounts: OffboardingAccount[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      customer: "my_customer",
      maxResults: "500",
      fields:
        "users(primaryEmail,aliases,nonEditableAliases,suspended,isAdmin,isDelegatedAdmin),nextPageToken",
      ...(pageToken ? { pageToken } : {}),
    });
    let page: UsersPage;
    try {
      const res = await client.request<UsersPage>({
        url: `${API}/users?${params}`,
      });
      page = res.data;
    } catch (err) {
      throw explainUsers(err);
    }
    accounts.push(...pageUsers(page));
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return accounts;
}

/** The two things Rachel set up for this, each named by its refusal. */
function explainUsers(err: unknown): Error {
  const status = (err as { status?: number }).status;
  const text = String((err as { message?: unknown }).message ?? err);
  const google = ` (Google said: ${googleReason(err)})`;
  if (text.includes("unauthorized_client")) {
    return new Error(
      "Google refused to let the service account read user accounts as " +
        "hawk-mod@. Check the domain-wide delegation entry for its client ID " +
        "also lists admin.directory.user.readonly (docs/google-setup.md, " +
        "Part 3)." +
        google
    );
  }
  if (status === 403) {
    return new Error(
      "Google refused to list user accounts. Check that hawk-mod@'s " +
        '"hawk-mod group membership" admin role has Users → Read ' +
        "(docs/google-setup.md, Part 3)." +
        google
    );
  }
  return new Error(`${text}${google}`);
}
