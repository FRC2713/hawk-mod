import { App } from "@slack/bolt";
import { APP_NAME, BRAND, ICON_SVG } from "../brand.js";
import { config } from "../config.js";
import { healthHandler } from "../health.js";
import { log } from "../logger.js";
import { registerActions } from "./actions.js";
import { registerCommands } from "./commands.js";
import { registerEvents } from "./events.js";
import { registerViews } from "./modals.js";
import { installationStore } from "./installStore.js";

/** Read-only apart from posting alerts. hawk-mod never needs to act as a user. */
export const BOT_SCOPES = [
  "chat:write",
  // Opens hawk-mod's own DM with an adult, to send guidance when their
  // conversation raises a finding. It cannot write into the conversation that
  // raised it — an app cannot join two people's DM — and would not want to:
  // that message must never reach the student.
  "im:write",
  "commands",
  "channels:read",
  "groups:read",
  "team:read",
  "users:read",
  "users:read.email",
  // Reads the @students / @adults groups that declare roles.
  "usergroups:read",
];

/**
 * Granted per adult, by that adult, at an authorization screen that names
 * them. These are the scopes that make DM monitoring possible at all — Slack
 * sells no way to read DMs below Enterprise Grid, so the alternative is not a
 * quieter tool, it is no visibility.
 */
export const USER_SCOPES = [
  "im:read",
  "im:history",
  "mpim:read",
  "mpim:history",
  "users:read",
];

export function createApp(): App {
  const cfg = config();

  const app = new App({
    signingSecret: cfg.SLACK_SIGNING_SECRET,
    clientId: cfg.SLACK_CLIENT_ID,
    clientSecret: cfg.SLACK_CLIENT_SECRET,
    stateSecret: cfg.SLACK_STATE_SECRET,
    scopes: BOT_SCOPES,
    installationStore,
    customRoutes: [
      { path: "/health", method: ["GET"], handler: healthHandler },
    ],
    redirectUri: `${cfg.PUBLIC_URL}/slack/oauth_redirect`,
    installerOptions: {
      userScopes: USER_SCOPES,
      redirectUriPath: "/slack/oauth_redirect",
      installPath: "/slack/install",
      directInstall: true,
      callbackOptions: {
        success: (_installation, _options, _req, res) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><meta charset="utf-8">
             <meta name="viewport" content="width=device-width,initial-scale=1">
             <title>${APP_NAME}</title>
             <div style="font:16px/1.6 system-ui,sans-serif;color:#1f2023;max-width:34rem;margin:4rem auto;padding:0 1.25rem">
               ${ICON_SVG}
               <h1 style="font-size:1.6rem;margin:1.25rem 0 .25rem">You're enrolled.</h1>
               <p style="margin:0 0 1.5rem;color:${BRAND.red};font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:.8rem">${APP_NAME}</p>
               <p>${APP_NAME} can now see direct messages you are part of that
               include a student, and records them for youth-protection audit.
               Conversations with no student in them are not recorded.</p>
               <p>You can revoke this at any time from Slack &rarr; Settings
               &rarr; Manage apps. Revoking is reported to the coaches,
               because unmonitored is not the same as compliant.</p>
             </div>`
          );
        },
        failure: (error, _options, _req, res) => {
          log.error("oauth failure", { error: String(error) });
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("Authorization failed. Tell a coach.");
        },
      },
    },
  });

  registerEvents(app);
  registerCommands(app);
  registerViews(app);
  registerActions(app);

  app.error(async (error) => {
    log.error("bolt error", { error: String(error) });
  });

  return app;
}
