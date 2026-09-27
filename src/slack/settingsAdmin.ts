import type { WebClient } from "@slack/web-api";
import {
  parseHandles,
  parseReportTime,
  SETTINGS,
  type SettingKey,
} from "../settings.js";
import { resolveGroup } from "./userGroups.js";

/**
 * The write path for settings, shared by the two doors that change them: the
 * `/hawkmod config` slash command and the web configuration page. One
 * implementation, so a value the command would refuse cannot be slipped in
 * from a browser, and vice versa.
 */

/**
 * Renders a stored value the way a person wrote it.
 *
 * Channels are stored by id, deliberately — an id survives the channel being
 * renamed, and a stored `#name` would quietly stop resolving the day somebody
 * tidied it up. But `C0BPAV78LKZ` tells a reader nothing, so both are shown:
 * the current name, and the id that is actually stored. Falls back to the raw
 * value if Slack cannot be asked: a settings listing that throws is worse than one that is
 * briefly ugly. Plain text — the caller decides what Slack mrkdwn or HTML to
 * wrap it in.
 */
export async function describeValue(
  client: WebClient,
  key: SettingKey,
  value: string
): Promise<string> {
  if (SETTINGS[key].kind === "channel") {
    try {
      const info = await client.conversations.info({ channel: value });
      return info.channel?.name ? `#${info.channel.name} (${value})` : value;
    } catch {
      return value;
    }
  }
  if (SETTINGS[key].kind === "time") return value;
  const handles = parseHandles(value);
  return handles.length ? handles.map((h) => `@${h}`).join(", ") : value;
}

/**
 * Checks a value against Slack before storing it.
 *
 * A user group handle that does not resolve is a typo, and a stored typo reads
 * exactly like an empty group: nobody rostered, nobody monitored, no complaint.
 * The sweep would raise that eventually; refusing it here turns tomorrow's
 * finding into an error message the person who caused it is still reading.
 */
export async function validateSetting(
  client: WebClient,
  key: SettingKey,
  raw: string
): Promise<{ value: string } | { error: string }> {
  const kind = SETTINGS[key].kind;

  if (kind === "time") {
    // Normalized to two-digit form so `7:30` and `07:30` store identically and
    // the settings listing never shows two spellings of one time.
    const time = parseReportTime(raw);
    if (!time) {
      return {
        error: `\`${raw}\` is not a time. Use 24-hour \`HH:MM\`, e.g. \`08:00\`.`,
      };
    }
    return {
      value: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`,
    };
  }

  if (kind === "channel") {
    // `<#C123|name>` when escaping is on, a bare id or #name when it is not.
    const id = raw.match(/^<#([A-Z0-9]+)/i)?.[1] ?? raw.replace(/^#/, "");
    try {
      const info = await client.conversations.info({ channel: id });
      if (!info.channel?.id) return { error: `No channel \`${raw}\`.` };
      return { value: info.channel.id };
    } catch (err) {
      return {
        error:
          `Couldn't read \`${raw}\`: ${String(err)}\n` +
          `hawk-mod must be a member of the channel it posts findings to.`,
      };
    }
  }

  const handles = raw
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => h.match(/^<!subteam\^[A-Z0-9]+\|@?([^>]+)>$/i)?.[1] ?? h)
    .map((h) => h.replace(/^@/, ""));

  if (kind === "usergroup" && handles.length !== 1) {
    return { error: `\`${key}\` takes exactly one user group.` };
  }

  for (const handle of handles) {
    const group = await resolveGroup(client, handle);
    if (!group) {
      return {
        error:
          `No user group @${handle} in this workspace. Nothing was changed — ` +
          `a stored typo looks exactly like an empty group, which is why this ` +
          `is checked before saving.`,
      };
    }
  }

  return { value: handles.join(",") };
}
