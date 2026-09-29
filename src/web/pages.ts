import { APP_NAME, BRAND, ICON_SVG } from "../brand.js";
import { SETTINGS, type SettingKey } from "../settings.js";

/**
 * The handful of pages hawk-mod serves to a browser: a landing page for
 * whoever follows mod.redhawkrobotics.org, and the configuration page behind
 * Sign in with Slack. String templates rather than a template engine — this is
 * four pages, and a dependency would outweigh them.
 *
 * Everything interpolated from outside this file goes through `esc()`. Setting
 * values, Slack display names, and error messages are all attacker-adjacent:
 * a display name is whatever its owner typed.
 */

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, width: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; color: #1f2023; margin: 0;
         background: #fff; }
  main { max-width: ${width}; margin: 3.5rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.6rem; margin: 1.25rem 0 .25rem; }
  .brand { margin: 0 0 1.5rem; color: ${BRAND.red}; font-weight: 600;
           letter-spacing: .04em; text-transform: uppercase; font-size: .8rem; }
  a { color: ${BRAND.red}; }
  code { background: #f4f2ef; padding: .1rem .3rem; border-radius: 4px;
         font-size: .9em; }
  .setting { border: 1px solid #e4e0da; border-radius: 8px; padding: 1rem 1.25rem;
             margin: 1rem 0; }
  .setting h2 { font-size: 1.05rem; margin: 0; }
  .setting .meta { color: #6b665e; font-size: .85rem; margin: .1rem 0 .6rem; }
  .setting form { display: flex; gap: .5rem; margin-top: .6rem; }
  .setting input[type=text] { flex: 1; font: inherit; padding: .35rem .5rem;
             border: 1px solid #c9c4bc; border-radius: 6px; }
  button { font: inherit; font-weight: 600; color: ${BRAND.cream};
           background: ${BRAND.red}; border: 0; border-radius: 6px;
           padding: .35rem .9rem; cursor: pointer; }
  .notice { border-radius: 8px; padding: .6rem 1rem; margin: 1rem 0; }
  .notice.ok { background: #edf6ee; border: 1px solid #b9dcbd; }
  .notice.err { background: #fbeeee; border: 1px solid #e8b9b9; }
  .muted { color: #6b665e; font-size: .9rem; }
  footer { margin-top: 2.5rem; }
</style>
<main>
${ICON_SVG}
${body}
</main>
</html>`;
}

/**
 * `workspace` is the installed workspace's address (`frc2713.slack.com`), or
 * `null` when it is not known, in which case the line is left out.
 */
export function landingPage(workspace: string | null): string {
  const whichWorkspace = workspace
    ? ` If Slack asks which workspace, enter
  <strong>${esc(workspace)}</strong>.`
    : "";
  return page(
    APP_NAME,
    "34rem",
    `
  <h1>${APP_NAME}</h1>
  <p class="brand">Red Hawk Robotics</p>
  <p>${APP_NAME} records direct messages between adults and students in the
  team Slack, so the team can meet its youth-protection obligations. Slack
  cannot block those conversations on our plan; recording them for audit is
  the control. Conversations with no student in them are never recorded.</p>
  <p><strong>Mentors:</strong> enrolling is what makes your DMs visible, and
  it is a personal, named authorization —
  <a href="/slack/install">enroll here</a>.${whichWorkspace} You can revoke it
  at any time from Slack &rarr; Settings &rarr; Manage apps.</p>
  <p><strong>Coaches and admins:</strong> the
  <a href="/config">configuration page</a> shows and changes where findings
  are posted, when the morning report arrives, and which other user groups
  <code>/hawkmod group</code> may edit. It asks you to sign in with
  Slack, and is limited to workspace Owners and Admins &mdash; the same rule as
  <code>/hawkmod</code>.</p>
  <footer class="muted">Day to day, ${APP_NAME} lives in Slack:
  <code>/hawkmod</code> shows coverage, findings, and settings.</footer>`
  );
}

export type SettingRow = {
  key: SettingKey;
  /** Human-readable current value (`#alerts`, `@students`) or null if unset. */
  shown: string | null;
  /** The raw stored value, prefilled into the edit box. */
  raw: string | null;
  source: "slack" | "env" | "unset";
};

export function configPage(args: {
  rows: SettingRow[];
  signedInAs: string;
  notice?: { ok: boolean; text: string };
}): string {
  const sections = args.rows
    .map((row) => {
      const spec = SETTINGS[row.key];
      const where =
        row.source === "slack"
          ? "set from Slack"
          : row.source === "env"
            ? `seeded from ${spec.env}`
            : "not set";
      return `
  <section class="setting">
    <h2>${esc(spec.label)}
      ${row.shown ? `&mdash; ${esc(row.shown)}` : "&mdash; <em>not set</em>"}</h2>
    <p class="meta"><code>${row.key}</code> &middot; ${esc(where)} &middot;
      ${esc(spec.hint)}</p>
    <form method="post" action="/config">
      <input type="hidden" name="key" value="${row.key}">
      <input type="text" name="value" value="${esc(row.raw ?? "")}"
             placeholder="${
               spec.kind === "channel"
                 ? "#channel"
                 : spec.kind === "time"
                   ? "08:00"
                   : "@group"
             }"
             autocomplete="off">
      <button>Save</button>
    </form>
  </section>`;
    })
    .join("\n");

  const notice = args.notice
    ? `<p class="notice ${args.notice.ok ? "ok" : "err"}">${esc(args.notice.text)}</p>`
    : "";

  return page(
    `Configuration — ${APP_NAME}`,
    "44rem",
    `
  <h1>Configuration</h1>
  <p class="brand">${APP_NAME}</p>
  ${notice}
  <p>Every change is validated against Slack before it is stored and recorded
  in the audit trail under your name. <code>/hawkmod config</code> in Slack
  shows and edits the same settings.</p>
  ${sections}
  <p class="muted">Slack credentials and the token encryption key stay in the
  environment and cannot be changed from here.</p>
  <footer class="muted">Signed in as ${esc(args.signedInAs)} &middot;
  <a href="/auth/signout">sign out</a> &middot; <a href="/">home</a></footer>`
  );
}

/** Errors, refusals, and the occasional plain statement. */
export function messagePage(title: string, bodyHtml: string): string {
  return page(
    `${title} — ${APP_NAME}`,
    "34rem",
    `
  <h1>${esc(title)}</h1>
  <p class="brand">${APP_NAME}</p>
  ${bodyHtml}
  <footer class="muted"><a href="/">Back to the landing page</a></footer>`
  );
}
