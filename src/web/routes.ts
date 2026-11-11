import type { IncomingMessage, ServerResponse } from "node:http";
import { WebClient } from "@slack/web-api";
import type { CustomRoute } from "@slack/bolt";
import { config } from "../config.js";
import { anyBotInstallation, setSetting } from "../db/repo.js";
import { rescheduleReports } from "../jobs/schedule.js";
import { log } from "../logger.js";
import { isSettingKey, SETTING_KEYS, SETTINGS, setting } from "../settings.js";
import { administrator, NOT_PERMITTED, type Actor } from "../slack/authz.js";
import { describeValue, validateSetting } from "../slack/settingsAdmin.js";
import { botClient } from "../slack/tokens.js";
import { installedWorkspaceAddress } from "../slack/workspace.js";
import {
  configPage,
  landingPage,
  messagePage,
  type SettingRow,
} from "./pages.js";
import { readSuiteHeaders } from "./suiteSession.js";

/**
 * The browser-facing routes: a landing page anyone may read, and a
 * configuration page for administrators.
 *
 * Who is asking comes from hawk_suite's sign-in gateway and nothing else:
 * Caddy verifies the suite session and passes the Slack identity in trusted
 * headers (web/suiteSession.ts). hawk-mod runs no sign-in of its own and sets
 * no cookies. Whether that person may configure anything is then the same
 * question every Slack entry point asks, answered by the same
 * `administrator()` — Workspace Owners and Admins, read live on every request,
 * so losing Slack admin locks this page within a minute.
 */

function html(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to });
  res.end();
}

/**
 * The signed-in administrator, or `null` after this has already answered the
 * request — with a redirect to the suite portal when the gateway's identity is
 * missing, or a refusal when its holder is not an Owner/Admin.
 */
async function requireAdministrator(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Actor | null> {
  const cfg = config();
  if (!cfg.HAWK_SUITE_TRUST_PROXY) {
    html(
      res,
      200,
      messagePage(
        "Use Slack to configure",
        "<p>Web sign-in comes from Hawk Suite, which this server is not " +
          "behind. <code>/hawkmod config</code> in Slack shows and edits the " +
          "same settings.</p>"
      )
    );
    return null;
  }
  const suite = readSuiteHeaders(
    req.headersDistinct ?? req.headers,
    cfg.HAWK_SUITE_TEAM_ID!
  );
  if (!suite) {
    redirect(res, new URL("auth/", cfg.HAWK_SUITE_ISSUER!).href);
    return null;
  }
  const installedTeam = anyBotInstallation()?.teamId;
  if (!installedTeam) {
    html(res, 503, messagePage("Not installed yet", `<p>${APPROVAL_HINT}</p>`));
    return null;
  }
  // The gateway admits its configured team; that must also be the team this
  // app is installed in, or the sign-in proves nothing here.
  if (suite.teamId !== installedTeam) {
    html(
      res,
      403,
      messagePage(
        "Wrong workspace",
        "<p>Sign in with the installed Slack workspace.</p>"
      )
    );
    return null;
  }

  let actor: Actor | null;
  try {
    actor = await administrator(botClient(), suite.userId);
  } catch (err) {
    // botClient() throws until the app is installed somewhere; there is
    // nothing to configure yet either way.
    html(res, 503, messagePage("Not installed yet", `<p>${APPROVAL_HINT}</p>`));
    log.warn("config page before installation", { error: String(err) });
    return null;
  }
  if (!actor) {
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
      signOutUrl: new URL("auth/logout", config().HAWK_SUITE_ISSUER!).href,
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
  // Sibling suite subdomains are same-site and share a gateway cookie. Require
  // this exact origin before accepting a settings write.
  const origin = req.headers.origin;
  if (origin !== new URL(config().PUBLIC_URL).origin) {
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

  // The new time takes effect now, not at whatever the old time happened to
  // be: leaving it would mean the setting looked applied and was not.
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

export const webRoutes: CustomRoute[] = [
  {
    path: "/",
    method: ["GET"],
    handler: async (_req, res) =>
      html(res, 200, landingPage(await installedWorkspaceAddress())),
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
];
