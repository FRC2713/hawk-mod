import type { IsoDate } from "../dates.js";
import { maskAddress } from "./heldMembers.js";
import type {
  DomainGroup,
  Leaver,
  OffboardingPlan,
  OffboardingReason,
  Unaccounted,
} from "./offboarding.js";

/**
 * The offboarding dry run, as `/hawkmod lifecycle offboarding` posts it.
 * Person IDs, reasons and group names only — never a name, and never an
 * address anyone might have given as their own: it can be run in any
 * channel, and some of the people leaving are minors. Two exceptions, both
 * for things the sheet cannot name: a Google account nobody accounts for is
 * shown by its address, since every one is a Red Hawk team account, and an
 * outsider in a group is shown partly hidden (`k…@gmail.com`), as held
 * members are.
 */

export function reasonText(r: OffboardingReason): string {
  switch (r.kind) {
    case "inactive":
      return "Inactive";
    case "status_unknown":
      return "blank or unknown Active/Inactive";
    case "role":
      return r.roles.length
        ? `now ${r.roles.join(", ")}`
        : "no role on the sheet";
    case "gone":
      return "Person ID no longer on the sheet";
  }
}

const ROLE: Record<DomainGroup["members"][number]["role"], string> = {
  OWNER: " (owner)",
  MANAGER: " (manager)",
  MEMBER: "",
};

function groupsOf(l: Leaver): string {
  // One entry per group: someone in a group under two addresses is still
  // one place to be removed from.
  const seen = new Map<string, string>();
  for (const g of l.groups) {
    if (!seen.has(g.groupId) || g.role !== "MEMBER") {
      seen.set(g.groupId, `${g.groupName}${ROLE[g.role]}`);
    }
  }
  return [...seen.values()].join(", ");
}

export function formatOffboarding(opts: {
  plan: OffboardingPlan;
  asOf: IsoDate;
  slackAccounts: number;
  /** How many Google accounts were read and how many are admins, or why not. */
  directory: { count: number; admins: number } | { error: string };
  /** The groups the sheet does not compute, as read, or why they were not. */
  groups: { untracked: DomainGroup[]; total: number } | { error: string };
  /** What nobody on the sheet accounts for; parts not read are left out. */
  unaccounted?: Unaccounted;
}): string {
  const { leavers } = opts.plan;
  const google = leavers.filter((l) => l.google);
  const slack = leavers.filter((l) => l.slack);
  const grouped = leavers.filter((l) => l.groups.length);

  const lines = [
    `Offboarding as of ${opts.asOf} (dry run: nothing posted, nothing changed)`,
    "",
  ];

  if ("error" in opts.directory) {
    lines.push(
      "Google accounts: NOT checked. Google's user accounts could not be read:",
      `  ${opts.directory.error}`
    );
  } else {
    lines.push(`Google accounts to suspend: ${google.length}`);
    for (const l of google) {
      lines.push(
        `  ${l.personId}: ${reasonText(l.reason)}` +
          (l.google!.admin
            ? " — holds a Google admin role, so a Super Admin must remove " +
              "it before hawk-mod can suspend the account"
            : "")
      );
    }
  }

  lines.push("", `Slack accounts to deactivate (by hand): ${slack.length}`);
  for (const l of slack) {
    lines.push(`  ${l.personId}: ${reasonText(l.reason)}`);
  }

  lines.push("");
  if ("error" in opts.groups) {
    lines.push(
      "Other groups: NOT checked. The Workspace's groups could not be read:",
      `  ${opts.groups.error}`
    );
  } else {
    lines.push(`Still in groups the sheet does not compute: ${grouped.length}`);
    for (const l of grouped) {
      lines.push(`  ${l.personId} (${reasonText(l.reason)}): ${groupsOf(l)}`);
    }
  }

  lines.push(
    "",
    "Once alerts are on, each person with a Google or Slack account left " +
      "gets one accounts alert, and anyone still in a group gets Remove from " +
      "groups, which will cover the groups above as well as the nine the " +
      "sheet computes."
  );

  const un = opts.unaccounted;
  if (un && !("error" in opts.directory)) {
    lines.push(
      "",
      `Active Google accounts the lifecycle sheet does not account for ` +
        `(no one's RHR Email): ${un.accounts.length}`
    );
    for (const a of un.accounts) {
      lines.push(`  ${a.account}${a.admin ? " (holds an admin role)" : ""}`);
    }
    if (un.suspended) {
      lines.push(`  and ${un.suspended} suspended, not listed`);
    }
  }
  if (un && !("error" in opts.groups)) {
    lines.push(
      "",
      `Members of groups the sheet does not compute who are not on the ` +
        `lifecycle sheet: ${un.outsiders.length} (once alerts are on, each ` +
        `is a warning; nobody is removed)`
    );
    for (const o of un.outsiders) {
      lines.push(`  ${o.groupName}: ${maskAddress(o.address)}${ROLE[o.role]}`);
    }
  }

  if (!("error" in opts.groups)) {
    const { untracked, total } = opts.groups;
    lines.push(
      "",
      `Groups the sheet does not compute: ${untracked.length} of the ` +
        `${total} in the Workspace`
    );
    for (const g of [...untracked].sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      lines.push(
        `  ${g.name || "(no name)"} (${g.id}): ${g.members.length} member(s)`
      );
    }
  }

  lines.push(
    "",
    "Read " +
      ("error" in opts.directory
        ? ""
        : `${opts.directory.count} Google accounts ` +
          `(${opts.directory.admins} hold an admin role) and `) +
      `${opts.slackAccounts} Slack accounts.`
  );
  return lines.join("\n");
}
