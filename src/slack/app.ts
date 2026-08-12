import { App } from "@slack/bolt";
import { config } from "../config.js";
import { healthHandler } from "../health.js";
import { log } from "../logger.js";
import { registerCommands } from "./commands.js";
import { registerEvents } from "./events.js";
import { installationStore } from "./installStore.js";

/** Read-only apart from posting alerts. hawk-mod never needs to act as a user. */
export const BOT_SCOPES = [
  "chat:write",
  "commands",
  "channels:read",
  "groups:read",
  "team:read",
  "users:read",
  "users:read.email",
  // Reads the @students / @mentors groups that declare roles.
  "usergroups:read",
];

/**
 * Granted per mentor, by that mentor, at an authorization screen that names
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
             <title>hawk-mod</title>
             <div style="font:16px/1.5 system-ui;max-width:34rem;margin:4rem auto">
               <h1>You're enrolled.</h1>
               <p>hawk-mod can now see direct messages you are part of that
               include a student, and records them for youth-protection audit.
               Conversations with no student in them are not recorded.</p>
               <p>You can revoke this at any time from Slack &rarr; Settings
               &rarr; Manage apps. Revoking is reported to the Lead Coaches,
               because unmonitored is not the same as compliant.</p>
             </div>`
          );
        },
        failure: (error, _options, _req, res) => {
          log.error("oauth failure", { error: String(error) });
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("Authorization failed. Tell a Lead Coach.");
        },
      },
    },
  });

  registerEvents(app);
  registerCommands(app);

  app.error(async (error) => {
    log.error("bolt error", { error: String(error) });
  });

  return app;
}
