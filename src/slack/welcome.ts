import type { WebClient } from "@slack/web-api";
import {
  anyBotInstallation,
  finishAuditRun,
  forgetOnboardingMessage,
  getInstallation,
  listPeople,
  onboardingMessagesSent,
  recordOnboardingMessage,
  runEverFinished,
  startAuditRun,
} from "../db/repo.js";
import { today } from "../domain/dates.js";
import type { Person } from "../domain/people.js";
import { requiresEnrollment } from "../domain/people.js";
import {
  reminderText,
  welcomeActions,
  welcomeText,
  type AdultInSlack,
  type WelcomeKind,
} from "../domain/lifecycle/welcome.js";
import { log } from "../logger.js";
import { settingValue } from "../settings.js";
import { fetchWorkspaceUsers } from "./roster.js";
import { installedWorkspaceAddress } from "./workspace.js";

/**
 * Sends the welcome and the one reminder (`domain/lifecycle/welcome.ts`), and
 * announces an enrollment. The rules are pure; this is the Slack half.
 */

export const WELCOME_RUN = "onboarding_messages";

/**
 * The landing page, from `PUBLIC_URL`. Read from the environment directly,
 * not `config()`: this is reachable from the CLI's `lifecycle sync`.
 */
function landingPage(): string {
  return (process.env.PUBLIC_URL ?? "https://mod.redhawkrobotics.org").replace(
    /\/+$/,
    ""
  );
}

function everEnrolled(
  teamId: string | undefined,
  slackUserId: string
): boolean {
  return teamId ? Boolean(getInstallation(teamId, "user", slackUserId)) : false;
}

async function send(
  slack: WebClient,
  slackUserId: string,
  kind: Exclude<WelcomeKind, "baseline">
): Promise<void> {
  // Recorded first, so a second run cannot send it too; un-recorded if Slack
  // refuses, so the next run tries again.
  if (!recordOnboardingMessage(slackUserId, kind)) return;
  const workspace = await installedWorkspaceAddress();
  const text =
    kind === "welcome"
      ? welcomeText(landingPage(), workspace)
      : reminderText(landingPage(), workspace);
  try {
    await slack.chat.postMessage({ channel: slackUserId, text });
    log.info("sent enrollment message", { slackUserId, kind });
  } catch (err) {
    forgetOnboardingMessage(slackUserId, kind);
    log.warn("could not send enrollment message", {
      slackUserId,
      kind,
      error: String(err),
    });
  }
}

/**
 * The hourly pass: welcomes every adult who has arrived in Slack since the
 * last one, and reminds anyone welcomed a week ago who has still not
 * enrolled. The first pass ever records who was already here and sends them
 * nothing.
 */
export async function sendWelcomes(slack: WebClient): Promise<void> {
  const runId = startAuditRun(WELCOME_RUN);
  const firstRun = !runEverFinished(WELCOME_RUN);
  const teamId = anyBotInstallation()?.teamId;
  const live = new Set(
    (await fetchWorkspaceUsers(slack))
      .filter((u) => !u.isBot && !u.isDeleted)
      .map((u) => u.id)
  );
  const adults: AdultInSlack[] = listPeople(true)
    .filter((p) => requiresEnrollment(p) && p.slack_user_id)
    .filter((p) => live.has(p.slack_user_id!))
    .map((p) => ({
      slackUserId: p.slack_user_id!,
      enrolled: everEnrolled(teamId, p.slack_user_id!),
    }));
  const sent = new Map(
    [...onboardingMessagesSent()].map(([id, kinds]) => [
      id,
      Object.fromEntries(
        Object.entries(kinds).map(([k, at]) => [k, today(new Date(at))])
      ),
    ])
  );
  const actions = welcomeActions(adults, sent, { firstRun, today: today() });
  for (const a of actions) {
    if (a.kind === "baseline")
      recordOnboardingMessage(a.slackUserId, "baseline");
    else await send(slack, a.slackUserId, a.kind);
  }
  finishAuditRun(runId, {
    firstRun,
    baseline: actions.filter((a) => a.kind === "baseline").length,
    welcomed: actions.filter((a) => a.kind === "welcome").length,
    reminded: actions.filter((a) => a.kind === "reminder").length,
  });
}

/**
 * The welcome, the moment an adult joins Slack, rather than at the next
 * hourly pass. Always a welcome, never a baseline: someone joining now is new,
 * even on the day this ships.
 */
export async function welcomeOnJoin(
  slack: WebClient,
  person: Person
): Promise<void> {
  if (!requiresEnrollment(person) || !person.slack_user_id) return;
  if (everEnrolled(anyBotInstallation()?.teamId, person.slack_user_id)) return;
  const record = onboardingMessagesSent().get(person.slack_user_id);
  if (record?.baseline || record?.welcome) return;
  await send(slack, person.slack_user_id, "welcome");
}

/**
 * Says in `announcement-channel` that an adult has enrolled — what the old
 * workflow's "I did it!" said, except that this is the enrollment itself.
 * Unset means nobody is told; enrolling does not depend on it.
 */
export async function announceEnrollment(
  slack: WebClient,
  person: Pick<Person, "full_name" | "person_id">
): Promise<void> {
  const channel = settingValue("announcement-channel");
  if (!channel) return;
  const who = person.person_id
    ? `${person.full_name} (${person.person_id})`
    : person.full_name;
  try {
    await slack.chat.postMessage({
      channel,
      text: `:white_check_mark: ${who} enrolled in Hawk Mod.`,
    });
  } catch (err) {
    log.warn("could not announce an enrollment", { error: String(err) });
  }
}
