import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { joinNotice } from "../src/domain/joinNotice.js";

/**
 * The line posted to the onboarding channel when anyone joins Slack (#86).
 * It names people by Person ID and name, and never by email.
 */

const AS_OF = "2026-11-12";
const account = { id: "U1", name: "bgillis", realName: "Ben G" };

describe("the join notice", () => {
  it("names a student and says their Slack Consent is missing", () => {
    assert.equal(
      joinNotice(
        {
          person_id: "P0086",
          full_name: "Ben Example",
          role: "student",
          slack_consent_expires_on: null,
        },
        account,
        AS_OF
      ),
      ":wave: P0086 Ben Example (Student) joined Slack. " +
        ":rotating_light: Slack Consent form: missing."
    );
  });

  it("says when a student's Slack Consent has expired, and when it is current", () => {
    const student = (expires: string) => ({
      person_id: "P0086",
      full_name: "Ben Example",
      role: "student" as const,
      slack_consent_expires_on: expires,
    });
    assert.match(
      joinNotice(student("2026-08-01"), account, AS_OF),
      /Slack Consent form: expired 2026-08-01\.$/
    );
    assert.match(
      joinNotice(student("2027-08-01"), account, AS_OF),
      /Slack Consent form: current, to 2027-08-01\.$/
    );
  });

  it("names an adult with no consent line", () => {
    assert.equal(
      joinNotice(
        {
          person_id: "P0012",
          full_name: "Ana Example",
          role: "adult",
          slack_consent_expires_on: null,
        },
        account,
        AS_OF
      ),
      ":wave: P0012 Ana Example (Adult) joined Slack."
    );
  });

  it("names an account the sheet does not know by its Slack name", () => {
    assert.equal(
      joinNotice(null, account, AS_OF),
      ":wave: Ben G (@bgillis) joined Slack, and is not on the lifecycle sheet."
    );
  });
});
