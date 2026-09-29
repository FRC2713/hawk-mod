import { log } from "../logger.js";
import { botClient } from "./tokens.js";

/**
 * The installed workspace's address — `frc2713.slack.com` — for the landing
 * page. On a phone, Slack's authorization screen can ask which workspace to
 * sign in to, and a mentor there has no other way to look it up (#43).
 */

/** What `team.info` says about the workspace, as far as this needs. */
export type TeamInfo = { url?: string; domain?: string };

/**
 * The workspace's host name, or `null` if Slack's answer does not look like
 * one. Prefers `url`, which Slack builds itself, over assembling one from
 * `domain`. A wrong address on the page is worse than none: it sends a mentor
 * to sign in somewhere else.
 */
export function workspaceAddress(team: TeamInfo): string | null {
  let host: string | null = null;
  if (team.url) {
    try {
      host = new URL(team.url).hostname;
    } catch {
      host = null;
    }
  }
  if (!host && team.domain) host = `${team.domain}.slack.com`;
  if (!host) return null;
  host = host.toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** An address rarely changes; a day is soon enough to notice a rename. */
const FRESH_MS = 24 * 60 * 60 * 1000;
/** After a failure, try Slack again this soon, not on every page view. */
const RETRY_MS = 5 * 60 * 1000;
/** The page is served without the line rather than kept waiting on Slack. */
const WAIT_MS = 2000;

let cached: { address: string | null; expires: number } | null = null;
let inFlight: Promise<string | null> | null = null;

async function fetchAddress(): Promise<string | null> {
  let address: string | null = null;
  try {
    const res = await botClient().team.info();
    address = workspaceAddress((res.team ?? {}) as TeamInfo);
  } catch (err) {
    // Before installation botClient() throws; that is expected, and the page
    // simply goes without the line.
    log.warn("could not read the workspace address", { error: String(err) });
  }
  cached = address
    ? { address, expires: Date.now() + FRESH_MS }
    : // Keep a known-good address through a failed refresh.
      { address: cached?.address ?? null, expires: Date.now() + RETRY_MS };
  return cached.address;
}

/**
 * The address, from a cache: the landing page is public, and must not call
 * Slack on every request. `null` when it is not known — the page leaves the
 * line out rather than guessing.
 */
export async function installedWorkspaceAddress(): Promise<string | null> {
  if (cached && Date.now() < cached.expires) return cached.address;
  inFlight ??= fetchAddress().finally(() => {
    inFlight = null;
  });
  const timeout = new Promise<null>((resolve) =>
    setTimeout(resolve, WAIT_MS, null).unref()
  );
  return (await Promise.race([inFlight, timeout])) ?? cached?.address ?? null;
}
