import { getSetting } from "./db/repo.js";

/**
 * Settings a Slack admin can change from Slack.
 *
 * Deliberately reads `process.env` directly rather than going through
 * `config()`. `config()` is an all-or-nothing parse of the whole Slack
 * environment, and this module is reachable from the CLI, which runs
 * `findings` and `lifecycle plan` with no Slack credentials present. Touching
 * `config()` from here would break those commands at import time.
 *
 * The environment is no longer the source of truth for these — it is the seed.
 * A value set in Slack wins; the env var is what a fresh install starts from,
 * so nothing breaks for a host that already has one and there is no flag day.
 */

export type SettingKind = "usergroup_list" | "channel" | "time";

export type SettingSpec = {
  /** The environment variable this used to live in, and still falls back to. */
  env: string;
  label: string;
  kind: SettingKind;
  /** Shown by `/hawkmod config` when nothing is set anywhere. */
  hint: string;
};

/**
 * The allowlist, and it is an allowlist on purpose. Slack credentials cannot be
 * here — you cannot configure from Slack the thing that lets hawk-mod reach
 * Slack — and `TOKEN_ENCRYPTION_KEY` must never be, because changing it makes
 * every stored token undecryptable and every enrolled adult silently invisible.
 */
export const SETTINGS = {
  // `student-group` and `mentor-group` were retired at lifecycle step 5: the
  // Slack groups they named are copies of the lifecycle sheet, found by ID in
  // SLACK_GROUP_IDS, and roles come from the sheet. A value still stored for
  // either is ignored.
  "managed-groups": {
    env: "MANAGED_USERGROUPS",
    label: "Groups /hawkmod group may edit",
    kind: "usergroup_list",
    hint: "comma separated; never the groups copied from the lifecycle sheet",
  },
  "alert-channel": {
    env: "ALERT_CHANNEL_ID",
    label: "Alert channel",
    kind: "channel",
    hint: "where findings are posted",
  },
  "onboarding-channel": {
    env: "ONBOARDING_CHANNEL_ID",
    label: "Onboarding request channel",
    kind: "channel",
    hint: "where onboarding requests are posted (Google accounts to create, Slack invites); while unset, they go to the alert channel",
  },
  "report-time": {
    env: "REPORT_TIME",
    label: "Morning report time",
    kind: "time",
    hint: "HH:MM (24-hour, workspace timezone) for the daily digest and the quarterly reminder",
  },
} as const satisfies Record<string, SettingSpec>;

export type SettingKey = keyof typeof SETTINGS;

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

export type Resolved = {
  value: string | undefined;
  /** Where the value came from — the thing that makes a wrong one debuggable. */
  source: "slack" | "env" | "unset";
};

/**
 * Pure so it can be tested without a database: the precedence rule is the whole
 * point of this module and is worth pinning down on its own.
 */
export function resolveSetting(
  fromDb: string | undefined,
  fromEnv: string | undefined
): Resolved {
  const db = fromDb?.trim();
  if (db) return { value: db, source: "slack" };
  const env = fromEnv?.trim();
  if (env) return { value: env, source: "env" };
  return { value: undefined, source: "unset" };
}

export const REPORT_TIME_DEFAULT = "08:00";

/**
 * "08:00" → `{ hour: 8, minute: 0 }`, or null for anything that is not a
 * 24-hour clock time. Pure, like `resolveSetting`: the scheduler and the
 * validator must agree on what a time is, so they share this.
 */
export function parseReportTime(
  raw: string | undefined
): { hour: number; minute: number } | null {
  const m = raw?.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** Splits a comma-separated setting into handles, without `@` and lowercased. */
export function parseHandles(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((h) => h.trim().replace(/^@/, "").toLowerCase())
    .filter(Boolean);
}

export function setting(key: SettingKey): Resolved {
  return resolveSetting(getSetting(key), process.env[SETTINGS[key].env]);
}

/** The value alone, for the many callers that do not care where it came from. */
export function settingValue(key: SettingKey): string | undefined {
  return setting(key).value;
}

/**
 * Where onboarding requests go: `onboarding-channel`, or the alert channel
 * while that is unset (decided 2026-09-29) — a request with nowhere to go is
 * a gap, and the alert channel is adult-only too. `fallback` says which.
 */
export function onboardingChannel(): {
  channel: string | undefined;
  fallback: boolean;
} {
  const own = settingValue("onboarding-channel");
  if (own) return { channel: own, fallback: false };
  return { channel: settingValue("alert-channel"), fallback: true };
}

/**
 * Handles `/hawkmod group` is permitted to edit.
 *
 * Every one has to be named, because `usergroups.users.update` replaces a
 * group's whole membership, so a bad plan does not corrupt a group, it empties
 * one. This bounds how many groups a single bug can reach. The groups copied
 * from the lifecycle sheet are refused whatever this says
 * (`slack/groupAdmin.ts`): they change only by Apply.
 */
export function managedGroupHandles(): Set<string> {
  return new Set(parseHandles(settingValue("managed-groups")));
}
