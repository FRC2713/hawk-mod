import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSettingKey,
  parseHandles,
  parseReportTime,
  REPORT_TIME_DEFAULT,
  resolveSetting,
  SETTINGS,
  SETTING_KEYS,
} from "../src/settings.js";

describe("setting resolution", () => {
  it("prefers a value set from Slack", () => {
    assert.deepEqual(resolveSetting("mentors", "adults"), {
      value: "mentors",
      source: "slack",
    });
  });

  it("falls back to the environment", () => {
    // The point of the fallback: an existing host keeps working unchanged, so
    // moving these settings needs no flag day and no coordinated deploy.
    assert.deepEqual(resolveSetting(undefined, "adults"), {
      value: "adults",
      source: "env",
    });
  });

  it("reports unset rather than guessing", () => {
    assert.deepEqual(resolveSetting(undefined, undefined), {
      value: undefined,
      source: "unset",
    });
  });

  it("treats blank as unset on both sides", () => {
    // A variable set to "" in a compose file is the common shape of this, and
    // it must not beat a real value stored in Slack.
    assert.deepEqual(resolveSetting("  ", "adults"), {
      value: "adults",
      source: "env",
    });
    assert.deepEqual(resolveSetting("", ""), {
      value: undefined,
      source: "unset",
    });
  });

  it("trims, because a trailing space in a handle finds no group", () => {
    assert.deepEqual(resolveSetting(" mentors ", undefined), {
      value: "mentors",
      source: "slack",
    });
  });
});

describe("handle parsing", () => {
  it("splits a comma separated list", () => {
    assert.deepEqual(parseHandles("programming, drive-team"), [
      "programming",
      "drive-team",
    ]);
  });

  it("strips @ and lowercases, so stored and typed forms match", () => {
    assert.deepEqual(parseHandles("@Mentors"), ["mentors"]);
  });

  it("survives empty entries and trailing commas", () => {
    assert.deepEqual(parseHandles("a,,b,"), ["a", "b"]);
    assert.deepEqual(parseHandles(undefined), []);
    assert.deepEqual(parseHandles(""), []);
  });
});

describe("report time parsing", () => {
  it("reads a 24-hour clock time", () => {
    assert.deepEqual(parseReportTime("08:00"), { hour: 8, minute: 0 });
    assert.deepEqual(parseReportTime("23:59"), { hour: 23, minute: 59 });
  });

  it("accepts the one-digit-hour spelling people actually type", () => {
    assert.deepEqual(parseReportTime("7:30"), { hour: 7, minute: 30 });
  });

  it("trims, matching how the rest of the settings treat whitespace", () => {
    assert.deepEqual(parseReportTime(" 08:00 "), { hour: 8, minute: 0 });
  });

  it("rejects what is not a time of day", () => {
    // The scheduler falls back to the default on any of these; the validator
    // refuses to store them at all.
    for (const bad of ["24:00", "08:60", "8", "8:5", "eight", "", undefined]) {
      assert.equal(parseReportTime(bad), null, `accepted ${bad}`);
    }
  });

  it("has a default that itself parses", () => {
    assert.ok(parseReportTime(REPORT_TIME_DEFAULT));
  });
});

describe("the settable allowlist", () => {
  it("recognises only known keys", () => {
    assert.equal(isSettingKey("managed-groups"), true);
    // Retired at lifecycle step 5: the copies are found by ID in code.
    assert.equal(isSettingKey("student-group"), false);
    assert.equal(isSettingKey("mentor-group"), false);
    assert.equal(isSettingKey("nonsense"), false);
  });

  /**
   * The load-bearing property. Slack credentials cannot be configured from
   * Slack, and TOKEN_ENCRYPTION_KEY changing would make every stored token
   * undecryptable — every enrolled adult silently invisible, with coverage
   * still reading 100%.
   */
  it("cannot reach credentials or the encryption key", () => {
    const forbidden = [
      "SLACK_SIGNING_SECRET",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_STATE_SECRET",
      "TOKEN_ENCRYPTION_KEY",
      "DATA_DIR",
      "PUBLIC_URL",
      "PORT",
    ];
    const reachable = SETTING_KEYS.map((k) => SETTINGS[k].env);
    for (const env of forbidden) {
      assert.ok(
        !reachable.includes(env as never),
        `${env} must not be settable from Slack`
      );
    }
  });

  it("every key names an env var to fall back to", () => {
    for (const key of SETTING_KEYS) {
      assert.ok(SETTINGS[key].env, `${key} has no env fallback`);
      assert.ok(SETTINGS[key].label, `${key} has no label`);
    }
  });
});
