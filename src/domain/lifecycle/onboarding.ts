import type { IsoDate } from "../dates.js";
import { consentStatus, mayHoldAccount } from "../rules/consent.js";
import { hasAccess } from "./groups.js";
import type { SheetPerson } from "./sheet.js";

/**
 * Step 6 of the lifecycle sync (capability H): what hawk-mod asks a person to
 * do so that someone the sheet declares can get into Google and Slack. Pure —
 * sheet people, Slack accounts and Google accounts in, requests out — so
 * every rule is a test with plain objects (docs/lifecycle-sync.md, "What
 * hawk-mod asks a human to do").
 *
 * hawk-mod creates nothing here. Slack Pro has no invite API, and Google
 * accounts are made by a Super Admin (decided 2026-09-29). A request is the
 * whole of it: posted once, and gone when the sheet or Slack shows it done.
 * Nothing in this file decides how often anyone is told; the caller keeps one
 * finding per request, so a request that is still true is not news.
 *
 * Addresses: a Slack invite carries the one address the person may be invited
 * by — RHR Email for a mentor, School Email for a student, and never a
 * personal one (`groupAddress`'s rule). Everything else names a Person ID.
 */

/** A Slack account, as far as onboarding needs one. The caller leaves out bots. */
export type OnboardingSlackAccount = {
  id: string;
  email: string | null;
  /** Deactivated in Slack: the person is invited back by reactivating it. */
  deactivated: boolean;
};

/** A Google account in the Workspace directory. */
export type DirectoryAccount = {
  primaryEmail: string;
  aliases: readonly string[];
  suspended: boolean;
};

/** Why an RHR Email on the sheet will not work. */
export type RhrEmailProblem =
  /** No Google account has this address: a typo, or never created. */
  | { kind: "not_an_account" }
  /** The account exists and is suspended. */
  | { kind: "suspended" }
  /**
   * The address is another account's alias. Google adds the account behind
   * it to a group under its primary address, so the groups run would add the
   * alias every hour and hold the primary as unknown.
   */
  | { kind: "alias"; primaryEmail: string };

export type OnboardingRole = "mentor" | "student";

export type OnboardingRequest =
  /** An Active mentor with no RHR Email: a Super Admin creates the account. */
  | { kind: "google_account"; personId: string; name: string }
  /** An Active mentor's RHR Email is not a working Google account. */
  | {
      kind: "rhr_email";
      personId: string;
      name: string;
      problem: RhrEmailProblem;
    }
  /** Ready, with no Slack account: an admin invites this address. */
  | {
      kind: "slack_invite";
      personId: string;
      name: string;
      role: OnboardingRole;
      address: string;
    }
  /** Ready, with a deactivated Slack account: an admin reactivates it. */
  | {
      kind: "slack_reactivate";
      personId: string;
      name: string;
      role: OnboardingRole;
      slackUserId: string;
    };

export type OnboardingKind = OnboardingRequest["kind"];

/** Someone not in Slack and not yet ready to be, and why — for the dry run. */
export type NotReady = {
  personId: string;
  role: OnboardingRole;
  reason: string;
};

export type OnboardingPlan = {
  requests: OnboardingRequest[];
  notReady: NotReady[];
  /**
   * Whether RHR Emails were checked against Google. `false` when the
   * directory could not be read: no RHR Email request is made, and so none
   * that is open may be closed on the strength of this plan.
   */
  directoryChecked: boolean;
};

/**
 * Who onboarding looks at, and as what. Only Active people: `unknown` is the
 * cautious reading, as for groups. A student who is also a mentor is onboarded
 * as a student — one address per person, and for a student it is the School
 * Email. Volunteers and alumni are never in Slack.
 */
function onboardingRole(p: SheetPerson): OnboardingRole | null {
  if (p.status !== "active") return null;
  if (p.roles.includes("Student")) return "student";
  if (p.roles.includes("Mentor")) return "mentor";
  return null;
}

const lower = (s: string) => s.toLowerCase();

/**
 * Whether an RHR Email is a working Google account, or `null` if it is.
 * Directory addresses are compared lower-cased, as Google does.
 */
export function rhrEmailProblem(
  email: string,
  directory: readonly DirectoryAccount[]
): RhrEmailProblem | null {
  const want = lower(email);
  const primary = directory.find((a) => lower(a.primaryEmail) === want);
  if (primary) return primary.suspended ? { kind: "suspended" } : null;
  const aliased = directory.find((a) =>
    a.aliases.some((x) => lower(x) === want)
  );
  if (aliased)
    return { kind: "alias", primaryEmail: lower(aliased.primaryEmail) };
  return { kind: "not_an_account" };
}

/**
 * The person's Slack account: the one their sheet row's Slack User ID names,
 * or one with their identity address. A live account wins over a deactivated
 * one, so someone who rejoined under a new account is simply in Slack.
 */
function slackAccountOf(
  slackUserId: string | null,
  address: string | null,
  accounts: readonly OnboardingSlackAccount[]
): OnboardingSlackAccount | null {
  const matches = accounts.filter(
    (a) =>
      (slackUserId !== null && a.id === slackUserId) ||
      (address !== null &&
        a.email !== null &&
        lower(a.email) === lower(address))
  );
  return matches.find((a) => !a.deactivated) ?? matches[0] ?? null;
}

/**
 * Every request the sheet, Slack and Google call for today, and everyone not
 * yet ready for Slack. Pass `directory` as `null` when Google could not be
 * read: Google account requests come from the sheet alone and are still made,
 * and Slack invites go ahead unchecked rather than wait on Google.
 */
export function planOnboarding(
  people: readonly SheetPerson[],
  slackAccounts: readonly OnboardingSlackAccount[],
  directory: readonly DirectoryAccount[] | null,
  asOf: IsoDate
): OnboardingPlan {
  const requests: OnboardingRequest[] = [];
  const notReady: NotReady[] = [];
  const sorted = [...people].sort((a, b) =>
    a.personId.localeCompare(b.personId)
  );

  for (const p of sorted) {
    const role = onboardingRole(p);
    if (!role) continue;
    const { personId, name } = p;

    if (role === "mentor") {
      const rhr = p.mentor?.rhrEmail ?? null;
      if (!rhr) {
        // Not waiting for CORI: the account may exist before CORI is done;
        // it joins no group and gets no Slack invite until then.
        requests.push({ kind: "google_account", personId, name });
        continue;
      }
      const problem = directory ? rhrEmailProblem(rhr, directory) : null;
      if (problem) {
        requests.push({ kind: "rhr_email", personId, name, problem });
      }
      const account = slackAccountOf(
        p.mentor?.slackUserId ?? null,
        rhr,
        slackAccounts
      );
      if (account && !account.deactivated) continue;
      if (!hasAccess(p, asOf)) {
        notReady.push({
          personId,
          role,
          reason: p.mentor?.coriExpiry
            ? "CORI has expired"
            : "no CORI Expiry on the sheet",
        });
        continue;
      }
      if (problem) {
        // Inviting an address that does not reach them helps nobody; the
        // rhr_email request above is what has to happen first.
        notReady.push({
          personId,
          role,
          reason: "their RHR Email needs fixing first",
        });
        continue;
      }
      requests.push(
        account
          ? {
              kind: "slack_reactivate",
              personId,
              name,
              role,
              slackUserId: account.id,
            }
          : { kind: "slack_invite", personId, name, role, address: rhr }
      );
      continue;
    }

    const school = p.student?.schoolEmail ?? null;
    const account = slackAccountOf(
      p.student?.slackUserId ?? null,
      school,
      slackAccounts
    );
    if (account && !account.deactivated) continue;
    const consent = consentStatus(
      {
        role: "student",
        slack_consent_expires_on: p.student?.slackConsentExpiry ?? null,
      },
      asOf
    );
    if (!mayHoldAccount(consent)) {
      notReady.push({
        personId,
        role,
        reason:
          consent.state === "expired"
            ? "Slack Consent has expired"
            : "no Slack Consent Expiry on the sheet",
      });
      continue;
    }
    if (account) {
      requests.push({
        kind: "slack_reactivate",
        personId,
        name,
        role,
        slackUserId: account.id,
      });
      continue;
    }
    if (!school) {
      // Never reached some other way: a student is invited by School Email
      // or not at all.
      notReady.push({ personId, role, reason: "no School Email on the sheet" });
      continue;
    }
    requests.push({
      kind: "slack_invite",
      personId,
      name,
      role,
      address: school,
    });
  }

  return { requests, notReady, directoryChecked: directory !== null };
}
