import { getSetting } from "./db/repo.js";

/**
 * Settings a Slack admin can change from Slack.
 *
 * Deliberately reads `process.env` directly rather than going through
 * `config()`. `config()` is an all-or-nothing parse of the whole Slack
 * environment, and this module is reachable from the CLI, which runs
 * `import-roster` and `findings` with no Slack credentials present. Touching
 * `config()` from here would break those commands at import time.
 *
 * The environment is no longer the source of truth for these — it is the seed.
 * A value set in Slack wins; the env var is what a fresh install starts from,
 * so nothing breaks for a host that already has one and there is no flag day.
 */

export type SettingKind = "usergroup" | "usergroup_list" | "channel";

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
  "student-group": {
    env: "STUDENT_USERGROUP",
    label: "Student user group",
    kind: "usergroup",
    hint: "the group whose members are monitored as students",
  },
  "mentor-group": {
    env: "ADULT_USERGROUP",
    label: "Mentor user group",
    kind: "usergroup",
    hint: "the group whose members are rostered as adults",
  },
  "managed-groups": {
    env: "MANAGED_USERGROUPS",
    label: "Other editable groups",
    kind: "usergroup_list",
    hint: "comma separated; the two role groups are always editable",
  },
  "alert-channel": {
    env: "ALERT_CHANNEL_ID",
    label: "Alert channel",
    kind: "channel",
    hint: "where findings are posted",
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
 * Handles `/hawkmod group` is permitted to edit.
 *
 * The two role groups are always editable — they are the ones hawk-mod is for.
 * Everything else has to be named, because `usergroups.users.update` replaces a
 * group's whole membership, so a bad plan does not corrupt a group, it empties
 * one. This bounds how many groups a single bug can reach.
 */
export function managedGroupHandles(): Set<string> {
  return new Set([
    ...parseHandles(settingValue("student-group")),
    ...parseHandles(settingValue("mentor-group")),
    ...parseHandles(settingValue("managed-groups")),
  ]);
}
