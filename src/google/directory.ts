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
 * Turns Google's refusals into something an administrator can act on. The
 * messages name settings, never an address or the key.
 */
function explain(err: unknown, group: string): Error {
  const status = (err as { status?: number }).status;
  const text = String((err as { message?: unknown }).message ?? err);
  if (text.includes("unauthorized_client")) {
    return new Error(
      "Google refused to let the service account act as hawk-mod@. Check the " +
        "domain-wide delegation entry for its client ID lists both group scopes " +
        "(docs/google-setup.md, Part 2)."
    );
  }
  if (status === 403) {
    return new Error(
      `Google refused to read ${group}. Check that hawk-mod@ holds the ` +
        `"hawk-mod group membership" admin role with Groups → Read.`
    );
  }
  return err instanceof Error ? err : new Error(text);
}

/**
 * Every direct member of one group, as lower-cased addresses, or `null` if
 * the group does not exist. Groups are kept flat, so a member that is itself
 * a group is read as an address like any other — and, since no one on the
 * sheet is added by a group's address, the planner holds it for a person.
 */
export async function readGroupMembers(
  client: JWT,
  groupEmail: string
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
        url: `${API}/groups/${encodeURIComponent(groupEmail)}/members?${params}`,
      });
      page = res.data;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw explain(err, groupEmail);
    }
    members.push(...pageAddresses(page));
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
  return members;
}
