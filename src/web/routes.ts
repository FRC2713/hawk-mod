import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { WebClient } from "@slack/web-api";
import type { CustomRoute } from "@slack/bolt";
import { APP_NAME } from "../brand.js";
import { config } from "../config.js";
import { anyBotInstallation, setSetting } from "../db/repo.js";
import { rescheduleReports } from "../jobs/schedule.js";
import { syncRolesFromUserGroups } from "../jobs/syncRoles.js";
import { log } from "../logger.js";
import { isSettingKey, SETTING_KEYS, SETTINGS, setting } from "../settings.js";
import { administrator, NOT_PERMITTED, type Actor } from "../slack/authz.js";
import { describeValue, validateSetting } from "../slack/settingsAdmin.js";
import { botClient } from "../slack/tokens.js";
import {
  configPage,
  landingPage,
  messagePage,
  type SettingRow,
} from "./pages.js";
import {
  parseCookies,
  SESSION_COOKIE,
  SESSION_PURPOSE,
  signToken,
  STATE_PURPOSE,
  verifyToken,
  type Session,
} from "./session.js";

/**
 * The browser-facing routes: a landing page anyone may read, and a
 * configuration page behind Sign in with Slack.
 *
 * The sign-in is OpenID Connect against the same Slack app — no new
 * credentials, no password, no user table. Slack says who is asking; whether
 * they may configure anything is then the same question every Slack entry
 * point asks, answered by the same `administrator()` — Workspace Owners and
 * Admins, read live. The cookie only carries identity; authority is re-checked
 * on every request, so losing Slack admin locks this page within a minute.
 */

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to });
  res.end();
}

function setSessionCookie(res: ServerResponse, token: string | null): void {
  const secure = config().PUBLIC_URL.startsWith("https:") ? "; Secure" : "";
  res.setHeader(
    "set-cookie",
    token
      ? `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax` +
          `; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
      : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

/**
 * The signed-in administrator, or `null` after this has already answered the
 * request — with a redirect into sign-in when there is no session, or a
 * refusal when there is one but its holder is not an Owner/Admin.
 */
async function requireAdministrator(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Actor | null> {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  const session = token
    ? verifyToken<Session>(
        SESSION_PURPOSE,
        token,
        config().SLACK_STATE_SECRET,
        Date.now()
      )
    : null;
  if (!session) {
    redirect(res, "/auth/slack");
    return null;
  }

  let actor: Actor | null;
  try {
    actor = await administrator(botClient(), session.slackUserId);
  } catch (err) {
    // botClient() throws until the app is installed somewhere; there is
    // nothing to configure yet either way.
    html(res, 503, messagePage("Not installed yet", `<p>${APPROVAL_HINT}</p>`));
    log.warn("config page before installation", { error: String(err) });
    return null;
  }
  if (!actor) {
    setSessionCookie(res, null);
    html(res, 403, messagePage("Not permitted", `<p>${NOT_PERMITTED}</p>`));
    return null;
  }
  return actor;
}

const APPROVAL_HINT =
  "Hawk Mod has not been installed in the workspace yet. A workspace Owner " +
  'or Admin installs it at <a href="/slack/install">/slack/install</a>; ' +
  "configuration comes after that.";

async function settingRows(client: WebClient): Promise<SettingRow[]> {
  return Promise.all(
    SETTING_KEYS.map(async (key) => {
      const { value, source } = setting(key);
      return {
        key,
        raw: value ?? null,
        shown: value ? await describeValue(client, key, value) : null,
        source,
      };
    })
  );
}

async function handleConfigGet(
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor
): Promise<void> {
  const url = new URL(req.url ?? "/", config().PUBLIC_URL);
  const ok = url.searchParams.get("ok");
  const err = url.searchParams.get("err");
  html(
    res,
    200,
    configPage({
      rows: await settingRows(botClient()),
      signedInAs: actor.name,
      notice: ok
        ? { ok: true, text: ok }
        : err
          ? { ok: false, text: err }
          : undefined,
    })
  );
}

/** Reads a small form body; anything over 8 KB is not a settings form. */
function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () =>
      resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))
    );
    req.on("error", () => resolve(null));
  });
}

async function handleConfigPost(
  req: IncomingMessage,
  res: ServerResponse,
  actor: Actor
): Promise<void> {
  // The cookie is SameSite=Lax, which modern browsers do not send on a
  // cross-site POST; the origin check catches the stragglers. Both matter:
  // this form changes who is monitored.
  const origin = req.headers.origin;
  if (origin && origin !== new URL(config().PUBLIC_URL).origin) {
    html(res, 403, messagePage("Refused", "<p>Cross-site request.</p>"));
    return;
  }

  const form = await readForm(req);
  const key = form?.get("key") ?? "";
  const raw = (form?.get("value") ?? "").trim();
  if (!form || !isSettingKey(key)) {
    html(res, 400, messagePage("Bad request", "<p>Unknown setting.</p>"));
    return;
  }
  if (!raw) {
    redirect(
      res,
      `/config?err=${encodeURIComponent(`Give ${key} a value — clearing a setting is not supported here.`)}`
    );
    return;
  }

  const client = botClient();
  const cleaned = await validateSetting(client, key, raw);
  if ("error" in cleaned) {
    redirect(res, `/config?err=${encodeURIComponent(cleaned.error)}`);
    return;
  }

  setSetting({
    key,
    value: cleaned.value,
    actor: actor.slackUserId,
    actorName: actor.name,
  });
  log.info("setting changed from web", { key, by: actor.slackUserId });

  let note =
    `${SETTINGS[key].label} is now ` +
    `${await describeValue(client, key, cleaned.value)}.`;

  // Roles are read from these groups by everything downstream, so leaving the
  // roster stale until 3am would mean the setting looked applied and was not.
  if (key === "student-group" || key === "mentor-group") {
    const stats = await syncRolesFromUserGroups(client);
    note +=
      ` Re-synced: ${stats.created} rostered, ${stats.changed} changed, ` +
      `${stats.reactivated} resumed.`;
  }

  // Same argument as the role groups: the new time takes effect now, not at
  // whatever the old time happened to be.
  if (key === "report-time") {
    const next = rescheduleReports();
    if (next) {
      note += ` Next daily report: ${next.toLocaleString("en-US", {
        timeZone: config().TZ,
      })}.`;
    }
  }

  redirect(res, `/config?ok=${encodeURIComponent(note)}`);
}

/** Sends the browser to Slack's OpenID authorize screen, with a signed state. */
function signinHandler(_req: IncomingMessage, res: ServerResponse): void {
  const cfg = config();
  const state = signToken(
    STATE_PURPOSE,
    {
      nonce: randomBytes(16).toString("base64url"),
      expiresAt: Date.now() + STATE_TTL_MS,
    },
    cfg.SLACK_STATE_SECRET
  );
  const url = new URL("https://slack.com/openid/connect/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.SLACK_CLIENT_ID);
  url.searchParams.set("scope", "openid");
  url.searchParams.set("redirect_uri", `${cfg.PUBLIC_URL}/auth/slack/callback`);
  url.searchParams.set("state", state);
  // Pins the consent screen to the installed workspace when there is one.
  const team = anyBotInstallation()?.teamId;
  if (team) url.searchParams.set("team", team);
  res.writeHead(302, { location: url.toString() });
  res.end();
}

async function callbackHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const cfg = config();
  const url = new URL(req.url ?? "/", cfg.PUBLIC_URL);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const stateOk =
    state &&
    verifyToken(STATE_PURPOSE, state, cfg.SLACK_STATE_SECRET, Date.now());
  if (!code || !stateOk) {
    // Ten-minute links expire; same answer the enrolment flow gives.
    html(
      res,
      400,
      messagePage(
        "That link expired",
        "<p>Sign-in links are good for ten minutes. " +
          '<a href="/auth/slack">Start again</a> — nothing was changed.</p>'
      )
    );
    return;
  }

  try {
    const exchange = await new WebClient().openid.connect.token({
      client_id: cfg.SLACK_CLIENT_ID,
      client_secret: cfg.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${cfg.PUBLIC_URL}/auth/slack/callback`,
    });
    const identity = await new WebClient(
      exchange.access_token
    ).openid.connect.userInfo();
    const slackUserId = identity["https://slack.com/user_id"];
    const teamId = identity["https://slack.com/team_id"];
    if (!slackUserId || !teamId) throw new Error("no identity in OIDC reply");

    // Sign-in from some other workspace is a stranger with a Slack account,
    // whatever flags their own workspace gives them.
    const installedTeam = anyBotInstallation()?.teamId;
    if (!installedTeam || teamId !== installedTeam) {
      html(
        res,
        403,
        messagePage(
          "Wrong workspace",
          `<p>That Slack account is not in the workspace ${APP_NAME} is ` +
            "installed in.</p>"
        )
      );
      return;
    }

    const actor = await administrator(botClient(), slackUserId);
    if (!actor) {
      html(res, 403, messagePage("Not permitted", `<p>${NOT_PERMITTED}</p>`));
      return;
    }

    const session: Session = {
      slackUserId,
      teamId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    setSessionCookie(
      res,
      signToken(SESSION_PURPOSE, session, cfg.SLACK_STATE_SECRET)
    );
    redirect(res, "/config");
    log.info("administrator signed in to web config", { slackUserId });
  } catch (err) {
    log.error("web sign-in failed", { error: String(err) });
    html(
      res,
      500,
      messagePage(
        "Sign-in failed",
        "<p>Nothing was changed. The server log has the detail; " +
          '<a href="/auth/slack">trying again</a> is safe.</p>'
      )
    );
  }
}

export const webRoutes: CustomRoute[] = [
  {
    path: "/",
    method: ["GET"],
    handler: (_req, res) => html(res, 200, landingPage()),
  },
  {
    path: "/config",
    method: ["GET", "POST"],
    handler: async (req, res) => {
      const actor = await requireAdministrator(req, res);
      if (!actor) return;
      if (req.method === "POST") await handleConfigPost(req, res, actor);
      else await handleConfigGet(req, res, actor);
    },
  },
  { path: "/auth/slack", method: ["GET"], handler: signinHandler },
  { path: "/auth/slack/callback", method: ["GET"], handler: callbackHandler },
  {
    path: "/auth/signout",
    method: ["GET"],
    handler: (_req, res) => {
      setSessionCookie(res, null);
      redirect(res, "/");
    },
  },
];
