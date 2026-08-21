import { App, type InstallURLOptions } from "@slack/bolt";
import { APP_NAME, BRAND, ICON_SVG } from "../brand.js";
import { config } from "../config.js";
import { healthHandler } from "../health.js";
import { log } from "../logger.js";
import { registerActions } from "./actions.js";
import { registerCommands } from "./commands.js";
import { registerEvents } from "./events.js";
import { registerViews } from "./modals.js";
import { GROUP_ADMIN_METADATA, installationStore } from "./installStore.js";

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
  // Reads the @students / @mentors groups that declare roles.
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

/**
 * Scopes for the group-editing grant, and deliberately nothing else.
 *
 * Slack issues one token per authorization carrying only what that
 * authorization asked for, so this list is exactly what an administrator hands
 * over: permission to edit user groups. It asks for no DM access, because an
 * administrator is not necessarily a monitored mentor and the two consents
 * should never be bundled — enrolment is a deliberate, named act, and burying
 * it inside "let me edit user groups" would be a trick.
 */
export const GROUP_ADMIN_USER_SCOPES = ["usergroups:write"];

export function createApp(): App {
  const cfg = config();

  /**
   * Bolt builds an `InstallProvider` inside its receiver but does not put
   * either on `App`'s public type, so reaching the URL generator needs this
   * shape. `receiver` is private, hence the double assertion; keeping the
   * target structural rather than `any` still means a Bolt upgrade that changes
   * `generateInstallUrl` breaks here at compile time rather than at an
   * administrator's first click.
   */
  type WithInstaller = {
    receiver?: {
      installer?: {
        generateInstallUrl(options: InstallURLOptions): Promise<string>;
      };
    };
  };

  // Assigned immediately after construction; the route handler below only runs
  // once a request arrives, long after that.
  let self: App;

  /**
   * Sends an administrator to Slack to grant group-editing permission.
   *
   * A second authorization route rather than a wider `/slack/install`, because
   * the two grants must land in different rows. `metadata` is what tells the
   * callback which one came back.
   */
  const authorizeGroups = async (
    _req: import("http").IncomingMessage,
    res: import("http").ServerResponse
  ): Promise<void> => {
    try {
      const installer = (self as unknown as WithInstaller).receiver?.installer;
      if (!installer) throw new Error("no install provider on the receiver");
      const url = await installer.generateInstallUrl({
        // No bot scopes: this authorization adds a permission to one person's
        // token and must not re-grant or alter the workspace installation.
        scopes: [],
        userScopes: GROUP_ADMIN_USER_SCOPES,
        metadata: GROUP_ADMIN_METADATA,
      });
      res.writeHead(302, { location: url });
      res.end();
    } catch (err) {
      log.error("could not build group authorization url", {
        error: String(err),
      });
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Could not start authorization. Tell a coach.");
    }
  };

  const app = new App({
    signingSecret: cfg.SLACK_SIGNING_SECRET,
    clientId: cfg.SLACK_CLIENT_ID,
    clientSecret: cfg.SLACK_CLIENT_SECRET,
    stateSecret: cfg.SLACK_STATE_SECRET,
    scopes: BOT_SCOPES,
    installationStore,
    customRoutes: [
      { path: "/health", method: ["GET"], handler: healthHandler },
      {
        path: "/slack/authorize-groups",
        method: ["GET"],
        handler: authorizeGroups,
      },
    ],
    redirectUri: `${cfg.PUBLIC_URL}/slack/oauth_redirect`,
    installerOptions: {
      userScopes: USER_SCOPES,
      redirectUriPath: "/slack/oauth_redirect",
      installPath: "/slack/install",
      directInstall: true,
      callbackOptions: {
        success: (installation, _options, _req, res) => {
          const groupAdmin = installation.metadata === GROUP_ADMIN_METADATA;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            groupAdmin
              ? `<!doctype html><meta charset="utf-8">
             <meta name="viewport" content="width=device-width,initial-scale=1">
             <title>${APP_NAME}</title>
             <div style="font:16px/1.6 system-ui,sans-serif;color:#1f2023;max-width:34rem;margin:4rem auto;padding:0 1.25rem">
               ${ICON_SVG}
               <h1 style="font-size:1.6rem;margin:1.25rem 0 .25rem">You can manage user groups.</h1>
               <p style="margin:0 0 1.5rem;color:${BRAND.red};font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:.8rem">${APP_NAME}</p>
               <p>${APP_NAME} can now edit Slack user groups on your behalf when
               you run <code>/hawkmod group</code>. Changes will show in Slack as
               made by you, which is the point &mdash; every roster change has a
               name against it.</p>
               <p>This grants no access to your messages. If you are also an
               enrolled mentor, that is a separate permission and this has not
               touched it.</p>
             </div>`
              : `<!doctype html><meta charset="utf-8">
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

  self = app;

  registerEvents(app);
  registerCommands(app);
  registerViews(app);
  registerActions(app);

  app.error(async (error) => {
    log.error("bolt error", { error: String(error) });
  });

  return app;
}
