import { daysBetween, type IsoDate } from "../dates.js";

/**
 * The message hawk-mod sends an adult when they arrive in Slack, asking them
 * to enroll, and the one reminder a week later. Replaces the Workflow Builder
 * welcome, which fired on joining a channel and relied on an "I did it!"
 * click; hawk-mod sees the enrollment itself. Pure: who gets what, and the
 * words (decided 2026-09-29).
 *
 * Two messages, then silence. An adult not enrolled after that is already an
 * `adult_not_enrolled` alert for an administrator, and a bot that keeps
 * nagging is one people stop reading — and resent, which is worse for a
 * youth-protection tool than being ignored.
 */

/** When the one reminder goes, after the welcome. */
export const REMINDER_DAYS = 7;

/** Where the welcome sends questions: #admin-official, by ID, never name. */
export const QUESTIONS_CHANNEL_ID = "C71FBF5FG";

export type WelcomeKind = "baseline" | "welcome" | "reminder";

/** An adult who should be enrolled, with a live Slack account. */
export type AdultInSlack = {
  slackUserId: string;
  /** Has ever enrolled. A revoked enrollment is `enrollment_revoked`'s. */
  enrolled: boolean;
};

export type WelcomeAction = { slackUserId: string; kind: WelcomeKind };

/**
 * What to send (or record) now. `firstRun` is the first run after this
 * shipped: every adult already in Slack and not enrolled is recorded as
 * `baseline` and sent nothing (decided 2026-09-29) — a "welcome" to someone
 * who has been here a year reads oddly, and their alert already exists.
 *
 * `sent` maps a Slack user ID to the day each kind went, as calendar days.
 */
export function welcomeActions(
  adults: readonly AdultInSlack[],
  sent: ReadonlyMap<string, Partial<Record<WelcomeKind, IsoDate>>>,
  opts: { firstRun: boolean; today: IsoDate }
): WelcomeAction[] {
  const actions: WelcomeAction[] = [];
  for (const a of adults) {
    if (a.enrolled) continue;
    const record = sent.get(a.slackUserId) ?? {};
    if (record.baseline) continue;
    if (!record.welcome) {
      actions.push({
        slackUserId: a.slackUserId,
        kind: opts.firstRun ? "baseline" : "welcome",
      });
      continue;
    }
    if (
      !record.reminder &&
      daysBetween(record.welcome, opts.today) >= REMINDER_DAYS
    ) {
      actions.push({ slackUserId: a.slackUserId, kind: "reminder" });
    }
  }
  return actions;
}

/**
 * `landing` is the landing page (mod.redhawkrobotics.org); `workspace` its
 * workspace address, or null if unknown, in which case that sentence goes.
 */
export function welcomeText(landing: string, workspace: string | null): string {
  return [
    "Welcome to the Red Hawk Robotics Slack! :wave:",
    "",
    "One setup step for every adult on the team: authorize *Hawk Mod*, our " +
      "youth-protection app. It keeps a record of direct messages that " +
      "include a student, as the team's youth-protection rules require. " +
      "Conversations between adults are never recorded.",
    "",
    `:arrow_right: Go to ${landing} and click *enroll here*. It takes about a minute.` +
      (workspace
        ? ` If Slack asks which workspace, enter *${workspace}*.`
        : ""),
    "",
    `Questions? Ask in <#${QUESTIONS_CHANNEL_ID}>.`,
  ].join("\n");
}

export function reminderText(
  landing: string,
  workspace: string | null
): string {
  return (
    "A reminder from Hawk Mod: the one-minute setup step is still waiting. " +
    "Until it's done, your direct messages with students aren't recorded, " +
    "which the team's youth-protection rules require. " +
    `:arrow_right: ${landing}` +
    (workspace ? ` (workspace: *${workspace}*)` : "") +
    `\n\nQuestions? Ask in <#${QUESTIONS_CHANNEL_ID}>.`
  );
}
