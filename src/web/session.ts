import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, stateless tokens for the web pages: the OAuth `state` parameter and
 * the session cookie an administrator gets after signing in with Slack.
 *
 * Stateless on purpose — the alternative is a sessions table that exists to be
 * cleaned up. A token is `base64url(JSON payload) . HMAC(purpose + payload)`,
 * so the server keeps nothing and a restart signs everyone out of nothing.
 *
 * Pure: the secret and the clock come in as arguments, so the tests exercise
 * this without an environment. The signing key is `SLACK_STATE_SECRET`, which
 * already exists to sign OAuth state and is already required to be set.
 *
 * `purpose` is folded into the MAC so one kind of token can never be replayed
 * as another — a captured OAuth state parameter must not work as a session
 * cookie, however unlikely the swap.
 */

export type TokenPayload = {
  /** Unix milliseconds. Required — every token this app signs expires. */
  expiresAt: number;
  [key: string]: unknown;
};

export function signToken(
  purpose: string,
  payload: TokenPayload,
  secret: string
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret)
    .update(`${purpose}.${body}`)
    .digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken<T extends TokenPayload>(
  purpose: string,
  token: string,
  secret: string,
  now: number
): T | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret)
    .update(`${purpose}.${body}`)
    .digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.expiresAt !== "number" || payload.expiresAt <= now) {
    return null;
  }
  return payload;
}

/** What the session cookie carries. The admin check itself is re-run per
 * request against Slack (`administrator()`), so this only says who is asking —
 * losing Slack admin revokes access within a minute, cookie or no cookie. */
export type Session = TokenPayload & {
  slackUserId: string;
  teamId: string;
};

export const SESSION_COOKIE = "hawkmod_session";
export const SESSION_PURPOSE = "web-session";
export const STATE_PURPOSE = "web-oauth-state";

/** Minimal `Cookie:` header parser — two known cookies, no library. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}
