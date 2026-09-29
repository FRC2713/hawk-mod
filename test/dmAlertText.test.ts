import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Person, Role } from "../src/domain/people.js";
import { label } from "../src/domain/people.js";
import {
  classifyConversation,
  everyone,
  messageSpan,
} from "../src/domain/rules/dmPolicy.js";

/**
 * What a DM alert says. Finding #154 said only "a student and 1 account(s)
 * not on the roster", naming nobody an administrator could go and ask, and
 * gave no hint that the conversation was years old.
 */

const AS_OF = "2026-09-29";
let nextId = 1;

function person(role: Role, name: string, screened = false): Person {
  const id = nextId++;
  return {
    id,
    person_id: null,
    slack_user_id: `U${id}`,
    email: null,
    full_name: name,
    role,
    active: 1,
    screening_expires_on: screened ? "2027-01-15" : null,
    training_expires_on: screened ? "2027-08-01" : null,
    cori_expires_on: screened ? "2027-06-01" : null,
    consent_release_expires_on: null,
    data_privacy_expires_on: null,
    mentor_ready_completed_on: null,
    slack_consent_expires_on: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as Person;
}

const alex = person("student", "Alex Student");
const unnas = person("adult", "Unnas Hussain", true);

describe("an account off the roster", () => {
  it("is named by Slack's name", () => {
    assert.equal(
      label({ slackUserId: "U9", slackName: "Jordan Doe" }),
      "Jordan Doe (not on the roster)"
    );
  });

  it("says when it is deactivated", () => {
    assert.equal(
      label({ slackUserId: "U9", slackName: "Jordan Doe", deactivated: true }),
      "Jordan Doe (not on the roster, deactivated)"
    );
  });

  it("falls back to its ID when Slack could not be asked", () => {
    assert.equal(
      label({ slackUserId: "U9" }),
      "Slack account U9 (not on the roster)"
    );
  });
});

describe("everyone in a conversation", () => {
  it("lists students first and marks them", () => {
    const jordan = { slackUserId: "U9", slackName: "Jordan Doe" };
    assert.equal(
      everyone([unnas, jordan, alex]),
      "Alex Student (student), Unnas Hussain and Jordan Doe (not on the roster)"
    );
  });
});

describe("the DM verdicts name everyone", () => {
  it("names the account off the roster in a group DM (#154)", () => {
    const jordan = {
      slackUserId: "U9",
      slackName: "Jordan Doe",
      deactivated: true,
    };
    const v = classifyConversation("mpim", [alex, unnas, jordan], AS_OF);
    assert.equal(v.violation, "unknown_participant_with_student");
    assert.equal(
      v.summary,
      "Group DM with Alex Student (student), Unnas Hussain and Jordan Doe " +
        "(not on the roster, deactivated): a student and an account not on " +
        "the roster."
    );
  });

  it("counts several accounts off the roster", () => {
    const v = classifyConversation(
      "mpim",
      [alex, { slackUserId: "U8" }, { slackUserId: "U9" }],
      AS_OF
    );
    assert.match(v.summary, /a student and 2 accounts not on the roster\.$/);
  });

  it("names everyone in a group DM short of two screened adults", () => {
    const v = classifyConversation("mpim", [alex, unnas], AS_OF);
    assert.equal(v.violation, "group_without_second_adult");
    assert.equal(
      v.summary,
      "Group DM with Alex Student (student) and Unnas Hussain: only 1 " +
        "screened adult; two are required."
    );
  });

  it("still names both people in a 1:1", () => {
    const v = classifyConversation("im", [unnas, alex], AS_OF);
    assert.match(v.summary, /^1:1 DM between Unnas Hussain and Alex Student/);
  });
});

describe("when the messages were sent", () => {
  it("gives the range", () => {
    assert.equal(
      messageSpan("2024-11-02", "2025-03-14"),
      "Messages from 2024-11-02 to 2025-03-14."
    );
  });

  it("gives one day once", () => {
    assert.equal(
      messageSpan("2025-03-14", "2025-03-14"),
      "Messages on 2025-03-14."
    );
  });
});
