import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCookies,
  signToken,
  verifyToken,
  type Session,
} from "../src/web/session.js";

const SECRET = "correct-horse-battery-staple";
const NOW = 1_700_000_000_000;

function freshSession(): Session {
  return { slackUserId: "U123", teamId: "T123", expiresAt: NOW + 60_000 };
}

describe("web session tokens", () => {
  it("round-trips a payload", () => {
    const token = signToken("web-session", freshSession(), SECRET);
    const back = verifyToken<Session>("web-session", token, SECRET, NOW);
    assert.equal(back?.slackUserId, "U123");
    assert.equal(back?.teamId, "T123");
  });

  it("rejects an expired token", () => {
    const token = signToken("web-session", freshSession(), SECRET);
    assert.equal(verifyToken("web-session", token, SECRET, NOW + 60_001), null);
  });

  it("rejects a tampered payload", () => {
    const token = signToken("web-session", freshSession(), SECRET);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...freshSession(), slackUserId: "UEVIL" })
    ).toString("base64url");
    assert.equal(
      verifyToken("web-session", `${forged}.${mac}`, SECRET, NOW),
      null
    );
    // The untampered halves still verify, so the test can't pass vacuously.
    assert.ok(verifyToken("web-session", `${body}.${mac}`, SECRET, NOW));
  });

  it("rejects the wrong secret", () => {
    const token = signToken("web-session", freshSession(), SECRET);
    assert.equal(
      verifyToken("web-session", token, "another-secret", NOW),
      null
    );
  });

  it("binds a token to its purpose — state cannot become a session", () => {
    const token = signToken("web-oauth-state", freshSession(), SECRET);
    assert.equal(verifyToken("web-session", token, SECRET, NOW), null);
  });

  it("rejects garbage without throwing", () => {
    for (const junk of ["", ".", "a.b", "not-a-token", "aaaa"]) {
      assert.equal(verifyToken("web-session", junk, SECRET, NOW), null);
    }
  });

  it("rejects a payload with no expiry", () => {
    const body = Buffer.from(JSON.stringify({ slackUserId: "U1" })).toString(
      "base64url"
    );
    // Signed the same way signToken would, but expiresAt is absent.
    const forged = signToken(
      "web-session",
      { expiresAt: NOW + 1000 },
      SECRET
    ).replace(/^[^.]+/, body);
    assert.equal(verifyToken("web-session", forged, SECRET, NOW), null);
  });
});

describe("cookie parsing", () => {
  it("finds a cookie among several", () => {
    const jar = parseCookies("a=1; hawkmod_session=abc.def; b=2");
    assert.equal(jar.get("hawkmod_session"), "abc.def");
  });

  it("tolerates a missing header", () => {
    assert.equal(parseCookies(undefined).get("hawkmod_session"), undefined);
  });
});
