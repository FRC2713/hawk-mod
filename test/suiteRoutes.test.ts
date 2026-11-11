import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { after, before, beforeEach, it, mock } from "node:test";
import { scheduledJobs } from "croner";
import { WebClient } from "@slack/web-api";
import { saveInstallation, createPersonFromSheet } from "../src/db/repo.js";
import { forgetAuthorization } from "../src/slack/authz.js";
import { webRoutes } from "../src/web/routes.js";

const directory = mkdtempSync(join(tmpdir(), "hawk-mod-suite-"));
const issuer = "https://apps.suite.test/";
const secret = "test-state-secret-0123456789";
Object.assign(process.env, {
  DATA_DIR: directory,
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SLACK_SIGNING_SECRET: "test",
  SLACK_CLIENT_ID: "test",
  SLACK_CLIENT_SECRET: "test",
  SLACK_STATE_SECRET: secret,
  PUBLIC_URL: "https://mod.suite.test",
  HAWK_SUITE_ISSUER: issuer,
  HAWK_SUITE_TRUST_PROXY: "true",
  HAWK_SUITE_TEAM_ID: "TTEAM",
});
let isAdmin = true;
let slackFails = false;
let calls = 0;
const server = createServer(async (req, res) => {
  const route = webRoutes.find(
    (r) => r.path === new URL(req.url!, "http://test").pathname
  );
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    await route.handler(req, res);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
let base: string;
before(async () => {
  mock.method(WebClient.prototype, "apiCall", async (method: string) => {
    calls++;
    if (slackFails) throw new Error("Slack unavailable");
    assert.equal(method, "users.info");
    return {
      ok: true,
      user: { id: "UADMIN", is_admin: isAdmin, real_name: "Test Admin" },
    };
  });
  saveInstallation({
    teamId: "TTEAM",
    slackUserId: "UBOT",
    kind: "bot",
    payload: { bot: { token: "test" } },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  isAdmin = true;
  slackFails = false;
  calls = 0;
  forgetAuthorization();
});
after(async () => {
  for (const job of [...scheduledJobs]) job.stop();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  mock.restoreAll();
  rmSync(directory, { recursive: true, force: true });
});
function suite(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "x-token-subject": "slack:TTEAM:UADMIN",
    "x-hawk-slack-team": "TTEAM",
    "x-hawk-slack-user": "UADMIN",
    "x-token-user-roles": "suite/member",
    ...overrides,
  };
}
function request(
  headers: Record<string, string>,
  extra: RequestInit = {}
): Promise<Response> {
  return fetch(`${base}/config`, {
    redirect: "manual",
    ...extra,
    headers: { ...headers, ...extra.headers },
  });
}
it("opens config with the verified suite identity and live admin check", async () => {
  const res = await request(suite());
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Signed in as Test Admin/);
  assert.equal(calls, 1);
});
it("refuses a suite member without Slack admin rights", async () => {
  isAdmin = false;
  assert.equal((await request(suite())).status, 403);
  assert.equal(calls, 1);
});
it("fails closed when Slack cannot authorize the suite identity", async () => {
  slackFails = true;
  assert.equal((await request(suite())).status, 403);
});
it("refuses a foreign workspace before consulting Slack", async () => {
  assert.equal(
    (
      await request(
        suite({
          "x-token-subject": "slack:TOTHER:UADMIN",
          "x-hawk-slack-team": "TOTHER",
        })
      )
    ).status,
    303
  );
  assert.equal(calls, 0);
});
it("ignores identity headers and redirects invalid suite identity to the portal", async () => {
  const res = await request(suite({ "x-token-user-roles": "admin" }), {
    headers: { "x-hawk-identity": "slack:TTEAM:UADMIN" },
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), `${issuer}auth/`);
  assert.equal(calls, 0);
});
it("checks admin rights again for POST", async () => {
  isAdmin = false;
  assert.equal(
    (
      await request(suite(), {
        method: "POST",
        headers: { origin: "https://mod.suite.test" },
        body: "key=report-time&value=09:00",
      })
    ).status,
    403
  );
});
it("requires an exact Origin for POST, including sibling suite subdomains", async () => {
  for (const origin of [undefined, "https://eye.suite.test"]) {
    const headers: Record<string, string> = origin ? { origin } : {};
    const res = await request(suite(), {
      method: "POST",
      headers,
      body: "key=report-time&value=09:00",
    });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /Cross-site request/);
  }
});
it("allows an authenticated settings POST with the matching Origin", async () => {
  const res = await request(suite(), {
    method: "POST",
    headers: { origin: "https://mod.suite.test" },
    body: "key=report-time&value=09:00",
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /^\/config\?ok=/);
});
it("signs out at the gateway", async () => {
  const res = await request(suite());
  assert.ok((await res.text()).includes(`href="${issuer}auth/logout"`));
  assert.equal(res.headers.get("set-cookie"), null);
});

it("refuses a student even when Slack grants them admin rights", async () => {
  createPersonFromSheet({
    personId: "student",
    role: "student",
    fullName: "Student",
    email: null,
    slackUserId: "UADMIN",
    dates: {},
  });
  assert.equal((await request(suite())).status, 403);
});
