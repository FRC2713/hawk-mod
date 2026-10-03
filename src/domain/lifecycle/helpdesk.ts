import type { IsoDate } from "../dates.js";
import { addressKey } from "./address.js";
import { hasAccess } from "./groups.js";
import {
  rhrEmailProblem,
  type DirectoryAccount,
  type RhrEmailProblem,
} from "./onboarding.js";
import type { AdminRole, SheetPerson } from "./sheet.js";

/**
 * Step 8 of the lifecycle sync (capability G): who should be able to reset
 * passwords, and who else holds an admin role. Pure — the sheet, Google's
 * accounts and grp-helpdesk's members in, a plan out — so every rule is a
 * test with plain objects (docs/lifecycle-sync.md, step 8).
 *
 * Help Desk Admin is carried by a group: a Super Admin assigned the role to
 * the security group grp-helpdesk once, and whoever is in it holds the role.
 * So hawk-mod never reads or changes an admin role. It compares the group
 * with the sheet, and **every change to the group is a click** — by an RA or
 * a Super Admin, checked at the click — because joining this group is
 * joining the people who can sign in as any mentor.
 *
 * The group holds Active Mentors with a Help Desk Admin row on
 * `Mentor_Admin_Roles` and CORI current (`hasAccess`, the mentor groups'
 * gate), by RHR Email. Anyone else in it is removed by Apply — a row
 * deleted, a CORI lapse, an account the sheet does not account for — except
 * someone **leaving the team**, who is held: their own leaving alert's
 * Remove from groups already reaches every group in the Workspace, and two
 * buttons removing one person would be one too many.
 *
 * Separately, `planAdmins` lists every account Google flags as an admin that
 * the group does not explain: the Super Admins, and any delegated admin a
 * Super Admin gave a role to directly.
 */

export const HELPDESK_ROLE: AdminRole = "Help Desk Admin";

/**
 * grp-helpdesk by its permanent Directory ID, like `GOOGLE_GROUP_IDS`: never
 * by name or address. The name is what the ID must lead to; an ID that leads
 * to a group with another name is the wrong group, and nothing is applied to
 * it. An empty ID is a group not set up yet.
 */
export const HELPDESK_GROUP = { name: "grp-helpdesk", id: "" } as const;

/** An address in grp-helpdesk, and whose it is on the sheet, if anyone's. */
export type HelpdeskMember = { address: string; personId: string | null };

/** Why Apply removes someone from grp-helpdesk. */
export type HelpdeskRemoveReason =
  /** An Active Mentor whose Help Desk Admin row is gone. */
  | "no_row"
  /** An Active Mentor whose CORI is not current. */
  | "no_access"
  /** An address that is no sheet person's RHR Email. */
  | "not_on_sheet";

/** Why someone is leaving the team; their own leaving alert removes them. */
export type HelpdeskLeavingReason = "inactive" | "status_unknown" | "role_gone";

/** Why someone the sheet gives the role cannot be added yet. */
export type HelpdeskWait =
  "no_rhr_email" | "no_access" | RhrEmailProblem["kind"];

export type HelpdeskPlan = {
  /** Added by Apply. The address is the sheet's RHR Email. */
  add: (HelpdeskMember & { personId: string })[];
  /** Removed by Apply. The address is the group's own spelling. */
  remove: (HelpdeskMember & { reason: HelpdeskRemoveReason })[];
  /** Kept for their own leaving alert's Remove from groups. */
  held: (HelpdeskMember & {
    personId: string;
    reason: HelpdeskLeavingReason;
  })[];
  /** Given the role on the sheet, but not addable yet; nothing to apply. */
  waiting: { personId: string; why: HelpdeskWait }[];
  /**
   * A Help Desk Admin row on someone leaving the team. Harmless while they
   * are gone, but if they come back the row brings the role back with them
   * (on a click), so it is worth deleting.
   */
  staleRows: { personId: string; reason: HelpdeskLeavingReason }[];
};

const lower = (a: string) => a.trim().toLowerCase();

/** Why a person is leaving the team, for this group; null if they are not. */
function leavingTeam(p: SheetPerson): HelpdeskLeavingReason | null {
  if (p.status === "inactive") return "inactive";
  if (p.status === "unknown") return "status_unknown";
  if (!p.roles.includes("Mentor")) return "role_gone";
  return null;
}

/** Whether the sheet puts this person in grp-helpdesk. */
function entitled(p: SheetPerson, asOf: IsoDate): boolean {
  return (
    leavingTeam(p) === null &&
    p.adminRoles.includes(HELPDESK_ROLE) &&
    hasAccess(p, asOf)
  );
}

/**
 * Sheet people by every address that reaches them: their RHR Email, and the
 * other addresses of the Google account it belongs to — the group stores an
 * account's primary address, whichever one was added.
 */
function ownersByAddress(
  people: readonly SheetPerson[],
  directory: readonly DirectoryAccount[]
): Map<string, SheetPerson> {
  const accountOf = new Map<string, DirectoryAccount>();
  for (const a of directory) {
    for (const x of [a.primaryEmail, ...a.aliases]) accountOf.set(lower(x), a);
  }
  const owner = new Map<string, SheetPerson>();
  for (const p of people) {
    const rhr = p.mentor?.rhrEmail;
    if (!rhr) continue;
    owner.set(addressKey(rhr), p);
    const account = accountOf.get(lower(rhr));
    for (const x of account ? [account.primaryEmail, ...account.aliases] : []) {
      owner.set(addressKey(x), p);
    }
  }
  return owner;
}

/**
 * What Apply would do to grp-helpdesk. `members` is the group's membership
 * as Google lists it; `directory` is every user account, to tell an RHR
 * Email that reaches nobody from one Google can add.
 */
export function planHelpdesk(args: {
  people: readonly SheetPerson[];
  directory: readonly DirectoryAccount[];
  members: Iterable<string>;
  asOf: IsoDate;
}): HelpdeskPlan {
  const { people, directory, asOf } = args;
  const owner = ownersByAddress(people, directory);
  const current = new Map<string, string>();
  for (const m of args.members) current.set(addressKey(m), lower(m));
  const present = new Set<string>();
  for (const key of current.keys()) {
    const p = owner.get(key);
    if (p) present.add(p.personId);
  }

  const plan: HelpdeskPlan = {
    add: [],
    remove: [],
    held: [],
    waiting: [],
    staleRows: [],
  };

  for (const p of people) {
    if (!p.adminRoles.includes(HELPDESK_ROLE)) continue;
    const leaving = leavingTeam(p);
    if (leaving) {
      plan.staleRows.push({ personId: p.personId, reason: leaving });
      continue;
    }
    // Someone already in the group is Apply's to remove, below; waiting is
    // for those it cannot add.
    if (present.has(p.personId)) continue;
    if (!hasAccess(p, asOf)) {
      plan.waiting.push({ personId: p.personId, why: "no_access" });
      continue;
    }
    const rhr = p.mentor?.rhrEmail;
    if (!rhr) {
      plan.waiting.push({ personId: p.personId, why: "no_rhr_email" });
      continue;
    }
    const problem = rhrEmailProblem(rhr, directory);
    if (problem) {
      plan.waiting.push({ personId: p.personId, why: problem.kind });
      continue;
    }
    plan.add.push({ address: lower(rhr), personId: p.personId });
  }

  for (const [key, address] of current) {
    const p = owner.get(key);
    if (!p) {
      plan.remove.push({ address, personId: null, reason: "not_on_sheet" });
      continue;
    }
    if (entitled(p, asOf)) continue;
    const leaving = leavingTeam(p);
    if (leaving) {
      plan.held.push({ address, personId: p.personId, reason: leaving });
      continue;
    }
    plan.remove.push({
      address,
      personId: p.personId,
      reason: p.adminRoles.includes(HELPDESK_ROLE) ? "no_access" : "no_row",
    });
  }

  const byAddress = (x: HelpdeskMember, y: HelpdeskMember) =>
    x.address.localeCompare(y.address);
  const byPerson = (x: { personId: string }, y: { personId: string }) =>
    x.personId.localeCompare(y.personId);
  plan.add.sort(byAddress);
  plan.remove.sort(byAddress);
  plan.held.sort(byAddress);
  plan.waiting.sort(byPerson);
  plan.staleRows.sort(byPerson);
  return plan;
}

/** grp-helpdesk as Google has it now, looked up by its ID. */
export type FoundGroup = { id: string; name: string };

export type HelpdeskDecision =
  | {
      kind: "apply";
      groupId: string;
      add: HelpdeskPlan["add"];
      remove: HelpdeskPlan["remove"];
    }
  | { kind: "held"; why: "wrong_group" | "missing"; message: string }
  | { kind: "nothing" };

/**
 * What Apply may do. The stops are the Google groups' ones: an ID that leads
 * to a group with another name is the **wrong group**, and a group with no
 * ID, or that Google does not have, is **missing**. There is no "refused"
 * plan to override: grp-helpdesk is a handful of people, emptying it is a
 * legitimate change, and every change is already a click.
 */
export function decideHelpdesk(args: {
  plan: HelpdeskPlan;
  found: FoundGroup | null;
}): HelpdeskDecision {
  const { plan, found } = args;
  if (!found) {
    return {
      kind: "held",
      why: "missing",
      message: HELPDESK_GROUP.id
        ? `Google has no group ${HELPDESK_GROUP.id}`
        : `no ID yet for ${HELPDESK_GROUP.name}`,
    };
  }
  if (lower(found.name) !== HELPDESK_GROUP.name) {
    return {
      kind: "held",
      why: "wrong_group",
      message: `its ID belongs to ${found.name}, not ${HELPDESK_GROUP.name}`,
    };
  }
  if (!plan.add.length && !plan.remove.length) return { kind: "nothing" };
  return {
    kind: "apply",
    groupId: found.id,
    add: plan.add,
    remove: plan.remove,
  };
}

/** A Google account with its two admin flags kept apart. */
export type AdminAccount = DirectoryAccount & {
  /** `isAdmin`: a Super Admin. */
  superAdmin: boolean;
  /** `isDelegatedAdmin`: holds some other admin role, not saying which. */
  delegatedAdmin: boolean;
};

export type AdminAccountLine = {
  account: string;
  suspended: boolean;
  /** Whose RHR Email reaches this account, if anyone's. */
  personId: string | null;
};

export type AdminReport = {
  /** Every Super Admin. Super Admin is not on the sheet, by design. */
  superAdmins: AdminAccountLine[];
  /**
   * A delegated admin grp-helpdesk does not explain, other than hawk-mod@
   * itself: a role a Super Admin gave someone directly. Null when the group
   * could not be read, because then nothing can be told apart.
   */
  unexpected: AdminAccountLine[] | null;
  /**
   * Members of grp-helpdesk Google does not flag as a delegated admin.
   * Expected to be empty once the role is on the group; if it is not, Google
   * does not flag a role that comes through a group, and the "unexpected"
   * list could not see one either. Null when the group could not be read.
   */
  unflagged: string[] | null;
};

/**
 * Every admin Google reports, against what explains it. A suspended account
 * is listed too, marked: it holds its role while suspended, and gets it back
 * with the account.
 */
export function planAdmins(args: {
  people: readonly SheetPerson[];
  directory: readonly AdminAccount[];
  /** grp-helpdesk's members, or null when it could not be read. */
  members: Iterable<string> | null;
  /** The account hawk-mod acts as; its own role is never reported. */
  actor: string;
}): AdminReport {
  const owner = ownersByAddress(args.people, args.directory);
  const listed = args.members === null ? null : [...args.members].map(lower);
  const members = listed && new Set(listed.map(addressKey));
  const keys = (a: AdminAccount) =>
    [a.primaryEmail, ...a.aliases].map((x) => addressKey(x));
  const line = (a: AdminAccount): AdminAccountLine => ({
    account: lower(a.primaryEmail),
    suspended: a.suspended,
    personId:
      keys(a)
        .map((k) => owner.get(k)?.personId)
        .find(Boolean) ?? null,
  });
  const actor = addressKey(args.actor);

  const superAdmins: AdminAccountLine[] = [];
  const unexpected: AdminAccountLine[] = [];
  const flagged = new Set<string>();
  for (const a of args.directory) {
    if (a.superAdmin || a.delegatedAdmin) {
      for (const k of keys(a)) flagged.add(k);
    }
    if (a.superAdmin) {
      superAdmins.push(line(a));
      continue;
    }
    if (!a.delegatedAdmin) continue;
    if (keys(a).includes(actor)) continue;
    if (members && keys(a).some((k) => members.has(k))) continue;
    unexpected.push(line(a));
  }

  const byAccount = (x: AdminAccountLine, y: AdminAccountLine) =>
    x.account.localeCompare(y.account);
  return {
    superAdmins: superAdmins.sort(byAccount),
    unexpected: members ? unexpected.sort(byAccount) : null,
    unflagged: listed
      ? listed.filter((m) => !flagged.has(addressKey(m))).sort()
      : null,
  };
}
