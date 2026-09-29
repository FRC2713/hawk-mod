import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOT_SCOPES, enrollOptions, USER_SCOPES } from "../src/slack/app.js";
import { workspaceAddress } from "../src/slack/workspace.js";
import { landingPage } from "../src/web/pages.js";

/**
 * The landing page and its enroll link (#43). On a phone, Slack's
 * authorization screen asked which workspace to sign in to, and mentors had
 * no way there to look it up.
 */
describe("the enroll link", () => {
  it("names the installed workspace, so Slack skips asking for it", () => {
    const o = enrollOptions("https://mod.example.org", "T70GB68SX");
    assert.equal(o.teamId, "T70GB68SX");
  });

  it("is Bolt's plain link before the first installation", () => {
    assert.equal(
      "teamId" in enrollOptions("https://mod.example.org", undefined),
      false
    );
  });

  it("keeps the enrollment scopes and the OAuth redirect", () => {
    const o = enrollOptions("https://mod.example.org", "T1");
    assert.deepEqual(o.scopes, BOT_SCOPES);
    assert.deepEqual(o.userScopes, USER_SCOPES);
    assert.equal(o.redirectUri, "https://mod.example.org/slack/oauth_redirect");
  });
});

describe("the workspace address", () => {
  it("comes from Slack's url", () => {
    assert.equal(
      workspaceAddress({ url: "https://frc2713.slack.com/", domain: "other" }),
      "frc2713.slack.com"
    );
  });

  it("falls back to the domain", () => {
    assert.equal(workspaceAddress({ domain: "frc2713" }), "frc2713.slack.com");
  });

  it("is unknown rather than wrong", () => {
    assert.equal(workspaceAddress({}), null);
    assert.equal(workspaceAddress({ url: "not a url" }), null);
    assert.equal(workspaceAddress({ domain: "<b>x</b>" }), null);
  });
});

describe("the landing page", () => {
  it("tells a mentor which workspace to enter", () => {
    const html = landingPage("frc2713.slack.com");
    assert.match(
      html,
      /which workspace, enter\s+<strong>frc2713\.slack\.com<\/strong>/
    );
    assert.match(html, /href="\/slack\/install"/);
  });

  it("leaves the line out when the address is not known", () => {
    assert.doesNotMatch(landingPage(null), /which workspace/);
  });

  it("no longer says user groups declare roles", () => {
    assert.doesNotMatch(landingPage(null), /declare roles/);
  });
});
