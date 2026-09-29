import { addressKey } from "./address.js";
import { GOOGLE_GROUP_IDS, intendedParents } from "./groups.js";
import type { DirectoryAccount, OnboardingSlackAccount } from "./onboarding.js";
import { groupAddress, type SheetPerson, type SheetRole } from "./sheet.js";

/**
 * Step 7 of the lifecycle sync (capability I): what is left behind when
 * someone leaves, for a person to take away with a click. Pure — the sheet,
 * hawk-mod's roster, Google's accounts and groups, and Slack's accounts in;
 * the leftovers out — so every rule is a test with plain objects
 * (docs/lifecycle-sync.md, "Leaving the team").
 *
 * hawk-mod takes nothing away here. For each person leaving it finds:
 *
 * - a Google account still active, which a person may suspend with a click —
 *   unless it holds an admin role, which only a Super Admin can touch;
 * - a Slack account still live, which a person must deactivate by hand
 *   (Slack Pro has no API for it);
 * - the groups the sheet does not compute (`grp-orders` and the like) that
 *   still hold one of their addresses, for Remove from groups to cover.
 *
 * Nothing is ever deleted, and a lapsed CORI is not leaving: that is
 * `cori_lapsed`, which takes someone out of the mentor groups and nothing
 * else.
 *
 * **Leaving is decided per address**, because an address is what an account
 * or a group holds. A mentor's RHR Email is theirs while they are an Active
 * Mentor; a student's School Email while they are an Active Student; a
 * volunteer's or alumnus's Personal Email while they are Active. Any other
 * address on their row is left behind — so a graduate who is now an Active
 * Alumnus leaves their School Email behind and keeps their Personal Email.
 * A mentor's or student's Personal Email is never looked for: it is not how
 * anyone is added, and it may be a parent's place in a group of its own.
 *
 * **An address someone still uses is never left behind**, whoever it came
 * from: another Active person's address, or a parent address an Active
 * student lists. Two people sharing an address is a sheet problem; it is not
 * a reason to suspend an account someone is using.
 */

/** A Google account, with whether it holds an admin role of any kind. */
export type OffboardingAccount = DirectoryAccount & {
  /**
   * A Super Admin or any delegated admin (Help Desk Admin, a custom role).
   * Google lets only a Super Admin change another admin's account, so
   * hawk-mod@ cannot suspend it until the role is taken away.
   */
  admin: boolean;
};

export type GroupRole = "OWNER" | "MANAGER" | "MEMBER";

/** A Google Group in the Workspace, as the directory lists it. */
export type DomainGroup = {
  /** The group's permanent Directory ID. */
  id: string;
  name: string;
  members: readonly { address: string; role: GroupRole }[];
};

/** A roster row, for someone whose Person ID is no longer on the sheet. */
export type RosterEntry = {
  personId: string;
  name: string;
  /** The identity email: RHR Email for an adult, School Email for a student. */
  email: string | null;
  slackUserId: string | null;
};

export type OffboardingReason =
  | { kind: "inactive" }
  | { kind: "status_unknown" }
  /**
   * Active, but no longer the role an address or account was for — a
   * graduate now Alumni, say — or, for a Slack account, neither a Mentor nor
   * a Student. `roles` is what the sheet says they are now.
   */
  | { kind: "role"; roles: SheetRole[] }
  /** Their Person ID is not on the sheet any more; hawk-mod's roster has it. */
  | { kind: "gone" };

/** Why someone is leaving, as the middle of a sentence. */
export function leavingWhy(r: OffboardingReason): string {
  switch (r.kind) {
    case "inactive":
      return "is Inactive on the lifecycle sheet";
    case "status_unknown":
      return "has a blank or unknown Active/Inactive on the lifecycle sheet";
    case "role":
      return r.roles.length
        ? `is now ${r.roles.join(", ")} on the lifecycle sheet, not a Mentor or Student`
        : "holds no role on the lifecycle sheet";
    case "gone":
      return "is no longer on the lifecycle sheet";
  }
}

/** An untracked group that still holds one of a leaver's addresses. */
export type UntrackedMembership = {
  groupId: string;
  groupName: string;
  /** Which of their addresses. Never printed for a student; the click needs it. */
  address: string;
  role: GroupRole;
};

export type Leaver = {
  personId: string;
  name: string;
  reason: OffboardingReason;
  /** Their Google account, still active; null if none, or already suspended. */
  google: { account: string; admin: boolean } | null;
  /** Their Slack account, still live; null if none, or already deactivated. */
  slack: { slackUserId: string } | null;
  /** Groups the sheet does not compute that still hold them. */
  groups: UntrackedMembership[];
};

export type OffboardingPlan = {
  /** Only those with something left behind, by Person ID. */
  leavers: Leaver[];
  /**
   * Whether Google's accounts were read. `false` means nobody's `google` is
   * known — not that nobody has one — so no account alert may close on the
   * strength of this plan.
   */
  directoryChecked: boolean;
  /** Whether every group in the Workspace was read; the same caution. */
  groupsChecked: boolean;
};

const lower = (s: string) => s.toLowerCase();

/** The IDs of the groups the sheet computes; every other group is untracked. */
const TRACKED = new Set(Object.values(GOOGLE_GROUP_IDS).filter(Boolean));

/** Whether a group is one of the nine the sheet computes, by its ID. */
export function isTrackedGroup(id: string): boolean {
  return TRACKED.has(id);
}

type Addresses = { current: string[]; left: string[] };

/**
 * Which of a sheet person's addresses are theirs today, and which they have
 * left behind. See the file comment for the rule.
 */
function addressesOf(p: SheetPerson): Addresses {
  const active = p.status === "active";
  const out: Addresses = { current: [], left: [] };
  const put = (address: string | null | undefined, current: boolean) => {
    if (address) (current ? out.current : out.left).push(lower(address));
  };
  put(p.mentor?.rhrEmail, active && p.roles.includes("Mentor"));
  put(p.student?.schoolEmail, active && p.roles.includes("Student"));
  // Only when it is the address they are added by: a volunteer or alumnus.
  if (groupAddress(p) === p.personalEmail) put(p.personalEmail, active);
  return out;
}

function reasonFor(p: SheetPerson): OffboardingReason {
  if (p.status === "inactive") return { kind: "inactive" };
  if (p.status === "unknown") return { kind: "status_unknown" };
  return { kind: "role", roles: [...p.roles] };
}

/** Whether someone belongs in Slack at all: an Active Mentor or Student. */
function belongsInSlack(p: SheetPerson): boolean {
  return (
    p.status === "active" &&
    (p.roles.includes("Mentor") || p.roles.includes("Student"))
  );
}

/**
 * Their live Slack account, if any: by a Slack User ID hawk-mod has for them,
 * or by one of their addresses. A deactivated account is already done.
 */
function liveSlackAccount(
  ids: readonly (string | null | undefined)[],
  addresses: readonly string[],
  accounts: readonly OnboardingSlackAccount[]
): OnboardingSlackAccount | null {
  const want = new Set(addresses.map(lower));
  return (
    accounts.find(
      (a) =>
        !a.deactivated &&
        (ids.includes(a.id) || (a.email !== null && want.has(lower(a.email))))
    ) ?? null
  );
}

/** The active Google account behind an address, by primary or alias. */
function activeAccount(
  address: string,
  directory: readonly OffboardingAccount[]
): OffboardingAccount | null {
  const a =
    directory.find((x) => lower(x.primaryEmail) === address) ??
    directory.find((x) => x.aliases.some((y) => lower(y) === address));
  return a && !a.suspended ? a : null;
}

/**
 * Everyone leaving who has something left behind. Pass `directory` or
 * `groups` as `null` when Google could not be read: what can be said from
 * the rest is still said, and the plan says what it could not check.
 */
export function planOffboarding(args: {
  people: readonly SheetPerson[];
  /** Roster rows with a Person ID; those the sheet no longer has are gone. */
  roster: readonly RosterEntry[];
  slackAccounts: readonly OnboardingSlackAccount[];
  directory: readonly OffboardingAccount[] | null;
  groups: readonly DomainGroup[] | null;
}): OffboardingPlan {
  const { people, slackAccounts, directory, groups } = args;

  // Compared as Gmail compares addresses (`addressKey`).
  const inUse = new Set<string>(
    [...intendedParents(people).keys()].map(addressKey)
  );
  const inUseSlack = new Set<string>();
  for (const p of people) {
    for (const a of addressesOf(p).current) inUse.add(addressKey(a));
    if (belongsInSlack(p)) {
      for (const id of [p.mentor?.slackUserId, p.student?.slackUserId]) {
        if (id) inUseSlack.add(id);
      }
    }
  }
  // A Slack account someone who belongs in Slack is using is never theirs to
  // lose: the same account under a stale Slack User ID, or a shared address.
  const slackable = slackAccounts.filter(
    (a) =>
      !inUseSlack.has(a.id) &&
      !(a.email !== null && inUse.has(addressKey(a.email)))
  );
  const untracked = (groups ?? []).filter((g) => !TRACKED.has(g.id));

  const leftovers = (
    base: Pick<Leaver, "personId" | "name" | "reason">,
    left: readonly string[],
    /** Slack User IDs hawk-mod has for them; null if they belong in Slack. */
    slackIds: readonly (string | null | undefined)[] | null
  ): Leaver | null => {
    const addresses = [...new Set(left.map(lower))].filter(
      (a) => !inUse.has(addressKey(a))
    );
    const keys = new Set(addresses.map(addressKey));
    const slack = slackIds
      ? liveSlackAccount(slackIds, addresses, slackable)
      : null;
    let google: Leaver["google"] = null;
    for (const a of directory ? addresses : []) {
      const account = activeAccount(a, directory!);
      if (account) {
        google = { account: lower(account.primaryEmail), admin: account.admin };
        break;
      }
    }
    const memberships: UntrackedMembership[] = [];
    for (const g of untracked) {
      for (const m of g.members) {
        if (keys.has(addressKey(m.address))) {
          memberships.push({
            groupId: g.id,
            groupName: g.name,
            address: lower(m.address),
            role: m.role,
          });
        }
      }
    }
    memberships.sort(
      (x, y) =>
        x.groupName.localeCompare(y.groupName) ||
        x.address.localeCompare(y.address)
    );
    if (!google && !slack && !memberships.length) return null;
    return {
      ...base,
      google,
      slack: slack ? { slackUserId: slack.id } : null,
      groups: memberships,
    };
  };

  const leavers: Leaver[] = [];
  const onSheet = new Set(people.map((p) => p.personId));

  for (const p of people) {
    const l = leftovers(
      { personId: p.personId, name: p.name, reason: reasonFor(p) },
      addressesOf(p).left,
      belongsInSlack(p) ? null : [p.mentor?.slackUserId, p.student?.slackUserId]
    );
    if (l) leavers.push(l);
  }

  for (const r of args.roster) {
    if (onSheet.has(r.personId)) continue;
    const l = leftovers(
      { personId: r.personId, name: r.name, reason: { kind: "gone" } },
      r.email ? [r.email] : [],
      [r.slackUserId]
    );
    if (l) leavers.push(l);
  }

  leavers.sort((a, b) => a.personId.localeCompare(b.personId));
  return {
    leavers,
    directoryChecked: directory !== null,
    groupsChecked: groups !== null,
  };
}

/** A Google account no one on the sheet or the roster accounts for. */
export type UnaccountedAccount = { account: string; admin: boolean };

/**
 * Someone in a group the sheet does not compute whose address the sheet does
 * not have. Warned about, never removed: Red Hawk's other groups can hold
 * outside collaborators (decided 2026-09-29).
 */
export type Outsider = UntrackedMembership;

export type Unaccounted = {
  /** Active accounts, by primary address. */
  accounts: UnaccountedAccount[];
  /** How many suspended accounts are unaccounted for too; not listed. */
  suspended: number;
  outsiders: Outsider[];
};

/**
 * What nobody on the sheet accounts for: Google accounts no RHR Email (or
 * roster address) reaches — an old mentor never put on the sheet, a shared
 * inbox, hawk-mod@ itself — and members of the groups the sheet does not
 * compute whose address the sheet does not have. Both are lists to read, not
 * leavers: nothing here is suspended or removed.
 *
 * An address is on the sheet if it is anyone's RHR Email, School Email or
 * Personal Email, whatever their status, or a parent address anyone lists —
 * except a current student's Personal Email, which is never a way into a
 * group, so finding one there is worth a warning. An address that is an
 * alias of a Google account counts as that account's primary, and the other
 * way round.
 */
export function planUnaccounted(args: {
  people: readonly SheetPerson[];
  roster: readonly RosterEntry[];
  directory: readonly OffboardingAccount[] | null;
  groups: readonly DomainGroup[] | null;
}): Unaccounted {
  const known = new Set<string>();
  const add = (a: string | null | undefined) => {
    if (a) known.add(addressKey(a));
  };
  for (const p of args.people) {
    add(p.mentor?.rhrEmail);
    add(p.student?.schoolEmail);
    if (!p.roles.includes("Student")) add(p.personalEmail);
    for (const a of p.parentEmails) add(a);
  }
  for (const r of args.roster) add(r.email);

  // Every address of a Google account, keyed to the whole account.
  const accountOf = new Map<string, OffboardingAccount>();
  for (const a of args.directory ?? []) {
    for (const x of [a.primaryEmail, ...a.aliases]) accountOf.set(lower(x), a);
  }
  const addressesOf = (a: OffboardingAccount) =>
    [a.primaryEmail, ...a.aliases].map(lower);
  const isKnown = (address: string) => {
    const account = accountOf.get(address);
    return account
      ? addressesOf(account).some((x) => known.has(addressKey(x)))
      : known.has(addressKey(address));
  };

  const accounts: UnaccountedAccount[] = [];
  let suspended = 0;
  for (const a of args.directory ?? []) {
    if (addressesOf(a).some((x) => known.has(addressKey(x)))) continue;
    if (a.suspended) suspended++;
    else accounts.push({ account: lower(a.primaryEmail), admin: a.admin });
  }
  accounts.sort((x, y) => x.account.localeCompare(y.account));

  const outsiders: Outsider[] = [];
  for (const g of args.groups ?? []) {
    if (TRACKED.has(g.id)) continue;
    for (const m of g.members) {
      const address = lower(m.address);
      if (isKnown(address)) continue;
      outsiders.push({
        groupId: g.id,
        groupName: g.name,
        address,
        role: m.role,
      });
    }
  }
  outsiders.sort(
    (x, y) =>
      x.groupName.localeCompare(y.groupName) ||
      x.address.localeCompare(y.address)
  );
  return { accounts, suspended, outsiders };
}
