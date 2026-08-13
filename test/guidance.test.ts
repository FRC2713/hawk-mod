import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guidanceFor } from "../src/domain/guidance.js";
import type { Person, Role } from "../src/domain/people.js";
import { classifyConversation } from "../src/domain/rules/dmPolicy.js";

const ASOF = "2026-08-12";

let nextId = 1;

function person(role: Role, screened: boolean): Person {
  const id = nextId++;
  const on = screened ? "2026-08-01" : null;
  return {
    id,
    slack_user_id: `U${String(id).padStart(3, "0")}`,
    email: `p${id}@example.org`,
    full_name: `Person ${id}`,
    role,
    active: 1,
    ypp_completed_on: on,
    ypt_completed_on: on,
    mentor_ready_on: on,
    cori_completed_on: on,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("guidance to an adult", () => {
  it("says nothing about a conversation that is allowed", () => {
    // Guidance hangs off a violation. A compliant group DM must never produce a
    // nudge, or hawk-mod becomes something people mute.
    const verdict = classifyConversation(
      "mpim",
      [person("adult", true), person("adult", true), person("student", false)],
      ASOF
    );
    assert.equal(verdict.violation, null);
    assert.equal(guidanceFor(verdict), null);
  });

  it("tells an adult in a 1:1 which student and what to do", () => {
    const student = person("student", false);
    const verdict = classifyConversation(
      "im",
      [person("adult", true), student],
      ASOF
    );
    const text = guidanceFor(verdict);
    assert.ok(text);
    // Named, so the adult knows which conversation is meant — they are already
    // in it, so this discloses nothing.
    assert.match(text, new RegExp(`<@${student.slack_user_id}>`));
    assert.match(text, /To put it right/);
    // The fix is a new group message, and saying why stops it reading as a
    // workaround someone invented.
    assert.match(text, /cannot add someone to an existing direct message/);
  });

  it("asks a lone adult in a group DM to add a second", () => {
    const verdict = classifyConversation(
      "mpim",
      [person("adult", true), person("adult", false), person("student", false)],
      ASOF
    );
    assert.equal(verdict.violation, "group_without_second_adult");
    const text = guidanceFor(verdict);
    assert.ok(text);
    assert.match(text, /add another screened adult/);
  });

  it("points an unknown participant at a coach, not at the adult", () => {
    const verdict = classifyConversation(
      "mpim",
      [
        person("adult", true),
        person("adult", true),
        person("student", false),
        { slackUserId: "UNOTONROSTER" },
      ],
      ASOF
    );
    assert.equal(verdict.violation, "unknown_participant_with_student");
    const text = guidanceFor(verdict);
    assert.ok(text);
    assert.match(text, /ask a coach/);
  });

  it("never accuses, and always says the finding still stands", () => {
    // The tone is the feature. An adult who feels accused moves the
    // conversation somewhere nobody can see it.
    const verdict = classifyConversation(
      "im",
      [person("adult", true), person("student", false)],
      ASOF
    );
    const text = guidanceFor(verdict);
    assert.ok(text);
    assert.match(text, /not a telling-off/);
    assert.match(text, /Nothing here is an accusation/);
    // Guidance must never read as a substitute for the alert.
    assert.match(text, /coach has been notified/);
  });
});
