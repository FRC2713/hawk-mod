import type { JWT } from "google-auth-library";

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
