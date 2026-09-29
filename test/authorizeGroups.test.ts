import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupAuthorizeOptions } from "../src/slack/app.js";
import { GROUP_ADMIN_METADATA } from "../src/slack/installStore.js";

/**
 * The group-editing authorization (`/slack/authorize-groups`). It once sent
 * Slack no redirect_uri, so Slack returned the administrator to the app's
 * first registered URL — the web sign-in callback — which called the link
 * expired, and nobody could grant group editing.
 */
describe("the group-editing authorization", () => {
  const o = groupAuthorizeOptions("https://mod.example.org");

  it("names the OAuth redirect explicitly, never the web sign-in callback", () => {
    assert.equal(o.redirectUri, "https://mod.example.org/slack/oauth_redirect");
  });

  it("asks for usergroups:write alone, and no bot scopes", () => {
    assert.deepEqual(o.scopes, []);
    assert.deepEqual(o.userScopes, ["usergroups:write"]);
  });

  it("is marked so the callback stores it as the admin grant, apart from any DM token", () => {
    assert.equal(o.metadata, GROUP_ADMIN_METADATA);
  });
});
