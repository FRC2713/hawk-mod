import { WebClient } from "@slack/web-api";
import { APP_NAME } from "../brand.js";
import {
  anyBotInstallation,
  getInstallation,
  listUserInstallations,
  markInstallationRevoked,
} from "../db/repo.js";
import { log } from "../logger.js";

type InstallationPayload = {
  bot?: { token?: string };
  user?: { id: string; token?: string };
};

export function botToken(): string | null {
  const install = anyBotInstallation();
  const payload = install?.payload as InstallationPayload | undefined;
  return payload?.bot?.token ?? null;
}

export function botClient(): WebClient {
  const token = botToken();
  if (!token) {
    throw new Error(
      `${APP_NAME} is not installed in any workspace yet — visit /slack/install`
    );
  }
  return new WebClient(token);
}

export function userToken(teamId: string, slackUserId: string): string | null {
  const install = getInstallation(teamId, "user", slackUserId);
  if (!install || install.revokedAt) return null;
  const payload = install.payload as InstallationPayload;
  return payload.user?.token ?? null;
}

export function userClient(
  teamId: string,
  slackUserId: string
): WebClient | null {
  const token = userToken(teamId, slackUserId);
  return token ? new WebClient(token) : null;
}

/**
 * Kills a user token at Slack, not just in our database — used when someone
 * who should never have been enrolled turns out to be.
 */
export async function revokeUserToken(
  teamId: string,
  slackUserId: string
): Promise<boolean> {
  const token = userToken(teamId, slackUserId);
  if (!token) return false;
  try {
    await new WebClient(token).auth.revoke();
    return true;
  } catch (err) {
    log.warn("could not revoke token at Slack", {
      user: slackUserId,
      error: String(err),
    });
    return false;
  }
}

export type Enrollment = {
  teamId: string;
  slackUserId: string;
  client: WebClient;
};

/** Every adult whose token still works, which is the monitored population. */
export function enrolledAdults(): Enrollment[] {
  const out: Enrollment[] = [];
  for (const install of listUserInstallations()) {
    const payload = install.payload as InstallationPayload;
    const token = payload.user?.token;
    if (!token) continue;
    out.push({
      teamId: install.teamId,
      slackUserId: install.slackUserId,
      client: new WebClient(token),
    });
  }
  return out;
}

/**
 * A token that no longer authenticates is a hole in coverage, not a transient
 * error — mark it so the sweep raises `enrollment_revoked` instead of silently
 * monitoring nobody.
 */
export async function verifyEnrollment(e: Enrollment): Promise<boolean> {
  try {
    await e.client.auth.test();
    return true;
  } catch (err) {
    log.warn("adult token failed auth.test", {
      user: e.slackUserId,
      error: String(err),
    });
    markInstallationRevoked(e.teamId, "user", e.slackUserId);
    return false;
  }
}
