import type { FindingKind, NewFinding } from "../findings.js";
import type { OnboardingRequest, RhrEmailProblem } from "./onboarding.js";

/**
 * Onboarding requests as findings: one per person per task, posted to the
 * `onboarding-channel` (or the alert channel while that is unset), closed by
 * the lifecycle run once the sheet or Slack shows the task done. Pure, so the
 * words are tested.
 *
 * A student's School Email is the address to invite them by, and it appears
 * only on the posted request, never in the summary: summaries are also
 * printed by `/hawkmod findings`, in whatever channel that is run, and the
 * morning report only ever counts these.
 */

export const ONBOARDING_KINDS = [
  "onboarding_google_account",
  "onboarding_rhr_email",
  "onboarding_slack_invite",
] as const satisfies readonly FindingKind[];

export type OnboardingKind = (typeof ONBOARDING_KINDS)[number];

export function isOnboardingKind(kind: string): kind is OnboardingKind {
  return (ONBOARDING_KINDS as readonly string[]).includes(kind);
}

const KIND: Record<OnboardingRequest["kind"], OnboardingKind> = {
  google_account: "onboarding_google_account",
  rhr_email: "onboarding_rhr_email",
  slack_invite: "onboarding_slack_invite",
  // One finding per person for getting into Slack, whichever way it is done:
  // if their old account turns up deactivated, the request changes its words
  // rather than becoming a second one.
  slack_reactivate: "onboarding_slack_invite",
};

/** Every onboarding finding's dedupe key starts with its kind and a colon. */
export function onboardingPrefixes(directoryChecked: boolean): string[] {
  // An RHR Email request can only be closed by a run that read Google: one
  // that could not, cannot say the address has been fixed.
  return ONBOARDING_KINDS.filter(
    (k) => directoryChecked || k !== "onboarding_rhr_email"
  ).map((k) => `${k}:`);
}

function rhrSummary(who: string, problem: RhrEmailProblem): string {
  switch (problem.kind) {
    case "not_an_account":
      return (
        `${who}'s RHR Email on the lifecycle sheet is not a Google account. ` +
        "Check it for a typo: until it is right, they join no mentor group " +
        "and cannot be invited to Slack."
      );
    case "suspended":
      return (
        `${who}'s RHR Email belongs to a suspended Google account. Restore ` +
        "the account, or put their current address on the lifecycle sheet."
      );
    case "alias":
      return (
        `${who}'s RHR Email is an alias. Replace it on the lifecycle sheet ` +
        `with the account's primary address, ${problem.primaryEmail}.`
      );
  }
}

export function onboardingFinding(r: OnboardingRequest): NewFinding {
  const who = `${r.personId} ${r.name}`;
  const base = {
    kind: KIND[r.kind],
    dedupeKey: `${KIND[r.kind]}:${r.personId}`,
    subjectRef: r.personId,
  };
  switch (r.kind) {
    case "google_account":
      return {
        ...base,
        severity: "info",
        summary:
          `Create a Google account for ${who}, then type the address into ` +
          "their RHR Email on the lifecycle sheet.",
      };
    case "rhr_email":
      return {
        ...base,
        severity: "warn",
        summary: rhrSummary(who, r.problem),
        detail: { problem: r.problem },
      };
    case "slack_invite":
      return {
        ...base,
        severity: "info",
        summary: `Invite ${who} (${r.role}) to Slack, at the address below.`,
        detail: { role: r.role, address: r.address },
      };
    case "slack_reactivate":
      return {
        ...base,
        severity: "info",
        summary:
          `Reactivate ${who}'s Slack account (${r.role}): it is ` +
          "deactivated, so an invite would not reach them.",
        detail: { role: r.role, slackUserId: r.slackUserId },
      };
  }
}

/**
 * The line only the posted request carries: the address to invite, set
 * apart so it can be copied. `null` for every other request.
 */
export function inviteAddressLine(f: {
  kind: string;
  detail: string | null;
}): string | null {
  if (f.kind !== "onboarding_slack_invite" || !f.detail) return null;
  const detail = JSON.parse(f.detail) as { address?: string };
  return detail.address ? `Address to invite: \`${detail.address}\`` : null;
}

/** Why the lifecycle run closed a request: it saw the task done. */
export const ONBOARDING_DONE_NOTE =
  "Done: the lifecycle sheet or Slack now shows it, or the person no longer needs it.";
