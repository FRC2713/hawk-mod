import type { IsoDate } from "../dates.js";
import { labelOf, type PersonLabels } from "./labels.js";
import type {
  NotReady,
  OnboardingPlan,
  OnboardingRequest,
  AccountProblem,
} from "./onboarding.js";

/**
 * The onboarding dry run, as `/hawkmod lifecycle onboarding` replies with it:
 * each person by Person ID, short name and role (`labels.ts`), and why. It is
 * an ephemeral reply to the administrator who ran it, wherever they ran it.
 * Never an address: most of the people in it are minors. The requests
 * themselves, with the address to invite, go only to the onboarding channel.
 */

const PROBLEM: Record<AccountProblem["kind"], string> = {
  suspended: "the Google account is suspended",
  alias:
    "it is an alias of another account; use that account's primary address",
};

function ids(requests: OnboardingRequest[], labels: PersonLabels): string {
  return requests.map((r) => labelOf(labels, r.personId)).join(", ");
}

export function formatOnboarding(opts: {
  plan: OnboardingPlan;
  /** Person ID → label, from the sheet (`personLabels`). */
  labels: PersonLabels;
  asOf: IsoDate;
  slackAccounts: number;
  /** How many Google accounts were read, or why they could not be. */
  directory: { count: number } | { error: string };
  /** Where requests would go, already described (`#name (C…)`). */
  channel: string;
  /** True when that is the alert channel because `onboarding-channel` is unset. */
  channelIsFallback: boolean;
  /** Active mentors in Slack without CORI current: each a `cori_lapsed` alert. */
  slackWithoutCori?: readonly string[];
}): string {
  const { plan, labels } = opts;
  const who = (personId: string) => labelOf(labels, personId);
  const of = <K extends OnboardingRequest["kind"]>(kind: K) =>
    plan.requests.filter(
      (r): r is Extract<OnboardingRequest, { kind: K }> => r.kind === kind
    );
  const google = of("google_account");
  const rhr = of("rhr_email");
  const invites = of("slack_invite");
  const reactivate = of("slack_reactivate");

  const lines = [
    `Onboarding as of ${opts.asOf} (dry run: nothing posted)`,
    "",
    `Google accounts to create (Active mentors with no account yet): ${google.length}`,
  ];
  for (const r of google) {
    lines.push(
      `  ${who(r.personId)}: ${r.address ? "at the RHR Email on the sheet" : "no RHR Email on the sheet yet"}`
    );
  }

  lines.push("");
  if ("error" in opts.directory) {
    lines.push(
      "RHR Emails: NOT checked against Google, so accounts still to create " +
        "at a filled-in address are not listed. Google's user accounts could " +
        "not be read:",
      `  ${opts.directory.error}`
    );
  } else {
    lines.push(
      `RHR Emails that are suspended or an alias: ${rhr.length}` +
        ` (checked against ${opts.directory.count} Google accounts)`
    );
    for (const r of rhr)
      lines.push(`  ${who(r.personId)}: ${PROBLEM[r.problem.kind]}`);
  }

  lines.push("", `Slack invites: ${invites.length}`);
  for (const role of ["mentor", "student"] as const) {
    const these = invites.filter((r) => r.role === role);
    if (these.length) lines.push(`  ${role}s: ${ids(these, labels)}`);
  }
  if (reactivate.length) {
    lines.push(
      "",
      `Deactivated Slack accounts to reactivate: ${reactivate.length}`
    );
    for (const r of reactivate) lines.push(`  ${who(r.personId)}`);
  }

  lines.push("", `Not ready for Slack yet: ${plan.notReady.length}`);
  for (const n of plan.notReady as NotReady[]) {
    lines.push(`  ${who(n.personId)}: ${n.reason}`);
  }

  const withoutCori = opts.slackWithoutCori ?? [];
  lines.push(
    "",
    `Mentors in Slack without CORI current (each a cori_lapsed alert in the ` +
      `alert channel): ${withoutCori.length}`
  );
  if (withoutCori.length) lines.push(`  ${withoutCori.map(who).join(", ")}`);

  lines.push(
    "",
    `Read ${opts.slackAccounts} Slack accounts.`,
    `Requests will go to ${opts.channel}` +
      (opts.channelIsFallback
        ? ", the alert channel, because `onboarding-channel` is not set."
        : ".")
  );
  return lines.join("\n");
}
