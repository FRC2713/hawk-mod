import type { NewFinding } from "../findings.js";
import { maskAddress } from "./heldMembers.js";
import {
  leavingWhy,
  type Leaver,
  type OffboardingReason,
  type Outsider,
  type UnaccountedAccount,
} from "./offboarding.js";

/**
 * Step 7's alerts, worded purely from the plan (docs/lifecycle-sync.md,
 * "Leaving the team"). Three kinds, all in the alert channel:
 *
 * - `offboarding_accounts`: one per person leaving with an account left —
 *   **Suspend Google account** while their Google account is active and holds
 *   no admin role, and a line asking an admin to deactivate their Slack
 *   account, which Slack Pro gives hawk-mod no way to do. It closes on its
 *   own once Google and Slack show both done.
 * - `google_account_unknown`: an active Google account no one's RHR Email
 *   reaches. A warning: it may be a shared account, acknowledged once.
 * - `group_outsider`: an address the sheet does not have, in a group the
 *   sheet does not compute. A warning, never a removal: those groups can
 *   hold outside collaborators (decided 2026-09-29).
 *
 * A summary names a Person ID and name, and a Google account in full — every
 * one is an adult's team account — but an outsider's address only partly
 * hidden, and never a student's. `/hawkmod findings` and the morning report
 * print summaries wherever they are run.
 */

export const OFFBOARDING_ACCOUNTS = "offboarding_accounts" as const;
export const GOOGLE_ACCOUNT_UNKNOWN = "google_account_unknown" as const;
export const GROUP_OUTSIDER = "group_outsider" as const;

/** What an accounts alert records, for its button and for the click. */
export type AccountsDetail = {
  reason: OffboardingReason;
  google: { account: string; admin: boolean } | null;
  slackUserId: string | null;
};

/**
 * The accounts alert for one person leaving, or `null` if they have no
 * account left (their groups are Remove from groups' business).
 * `slackAdminUrl` is where an admin deactivates a Slack account —
 * `https://frc2713.slack.com/admin` — or null if the workspace is unknown.
 */
export function offboardingAccountsFinding(
  l: Leaver,
  slackAdminUrl: string | null
): NewFinding | null {
  if (!l.google && !l.slack) return null;
  const who = `${l.personId} ${l.name}`;
  const has = [
    l.google ? `an active Google account (${l.google.account})` : "",
    l.slack ? "a live Slack account" : "",
  ].filter(Boolean);

  const steps: string[] = [];
  if (l.google && !l.google.admin) {
    steps.push(
      "Suspend Google account suspends it — it is never deleted, and can be " +
        "restored if they come back."
    );
  } else if (l.google) {
    steps.push(
      "That Google account holds an admin role, which only a Super Admin can " +
        "change: a Super Admin removes the role first, and then this alert " +
        "offers Suspend."
    );
  }
  if (l.slack) {
    const where = slackAdminUrl
      ? `Slack's Manage members page (<${slackAdminUrl}|${slackAdminUrl.replace(/^https:\/\//, "")}>)`
      : "Slack's Manage members page";
    steps.push(
      `Slack Pro gives hawk-mod no way to deactivate anyone: an admin ` +
        `deactivates their account in ${where}.`
    );
  }

  const detail: AccountsDetail = {
    reason: l.reason,
    google: l.google,
    slackUserId: l.slack?.slackUserId ?? null,
  };
  return {
    kind: OFFBOARDING_ACCOUNTS,
    dedupeKey: `${OFFBOARDING_ACCOUNTS}:${l.personId}`,
    severity: "warn",
    subjectRef: l.personId,
    summary:
      `${who} ${leavingWhy(l.reason)}, and still has ${has.join(" and ")}. ` +
      `${steps.join(" ")} Nothing was changed.`,
    detail,
  };
}

/** Whether an accounts alert still offers Suspend: an account, no admin role. */
export function offersSuspend(detail: string | null | undefined): boolean {
  if (!detail) return false;
  const d = JSON.parse(detail) as Partial<AccountsDetail>;
  return Boolean(d.google && !d.google.admin);
}

export function unknownGoogleAccountFinding(a: UnaccountedAccount): NewFinding {
  return {
    kind: GOOGLE_ACCOUNT_UNKNOWN,
    dedupeKey: `${GOOGLE_ACCOUNT_UNKNOWN}:${a.account}`,
    severity: "warn",
    subjectRef: a.account,
    summary:
      `An active Google account the lifecycle sheet does not account for: ` +
      `${a.account}${a.admin ? ", which holds an admin role" : ""}. No one's ` +
      `RHR Email is this account. If it is a mentor's, put it on their row; ` +
      `if it is a shared account, acknowledge this. Nothing was changed.`,
    detail: { admin: a.admin },
  };
}

const ROLE: Record<Outsider["role"], string> = {
  OWNER: " (owner)",
  MANAGER: " (manager)",
  MEMBER: "",
};

/** One warning per address, naming every group it is in. */
export function groupOutsiderFindings(
  outsiders: readonly Outsider[]
): NewFinding[] {
  const byAddress = new Map<string, Outsider[]>();
  for (const o of outsiders) {
    byAddress.set(o.address, [...(byAddress.get(o.address) ?? []), o]);
  }
  return [...byAddress.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([address, where]) => {
      const groups = where.map((o) => `${o.groupName}${ROLE[o.role]}`);
      const list =
        groups.length === 1
          ? groups[0]
          : `${groups.slice(0, -1).join(", ")} and ${groups.at(-1)}`;
      return {
        kind: GROUP_OUTSIDER,
        // The whole address is the identity, as for an unplaceable held
        // member; only the summary and subject are what people read.
        dedupeKey: `${GROUP_OUTSIDER}:${address}`,
        severity: "warn" as const,
        subjectRef: maskAddress(address),
        summary:
          `An address the lifecycle sheet does not account for, ` +
          `${maskAddress(address)}, is in ${list}. If it is someone's, put ` +
          `it on their row; if it is an outside collaborator, acknowledge ` +
          `this. Nothing was removed.`,
        detail: {
          groups: where.map((o) => ({
            groupId: o.groupId,
            groupName: o.groupName,
            role: o.role,
          })),
        },
      };
    });
}

/** Why the offboarding run closed one of its alerts: it saw it done. */
export const OFFBOARDING_DONE_NOTE =
  "Done: Google, Slack or the lifecycle sheet now shows it.";
