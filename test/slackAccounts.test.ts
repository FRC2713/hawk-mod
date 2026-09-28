import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchSlackAccount, type Person } from "../src/domain/people.js";

/**
 * After the cutover the roster's email is the identity email — RHR or School —
 * and many people signed up to Slack with another address. Matching Slack
 * accounts to rows by email alone would call every one of them unknown each
 * night, or worse, move a row onto whichever account shares its address.
 */

function row(id: number, slack: string | null, email: string | null): Person {
  return {
    id,
    person_id: `P${String(id).padStart(4, "0")}`,
    slack_user_id: slack,
    email,
    full_name: `Person ${id}`,
    role: "adult",
    active: 1,
    screening_expires_on: null,
    training_expires_on: null,
    cori_expires_on: null,
    consent_release_expires_on: null,
    data_privacy_expires_on: null,
    mentor_ready_completed_on: null,
    slack_consent_expires_on: null,
    notes: null,
    created_at: "x",
    updated_at: "x",
  };
}

function roster(...people: Person[]) {
  return {
    bySlackId: (id: string) => people.find((p) => p.slack_user_id === id),
    byEmail: (e: string) =>
      people.find((p) => p.email?.toLowerCase() === e.toLowerCase()),
  };
}

describe("matching a Slack account to the roster", () => {
  it("knows an account by its Slack ID, whatever email it signed up with", () => {
    const r = roster(row(1, "U1", "mentor@rhr.example"));
    const m = matchSlackAccount(
      { id: "U1", email: "own@gmail.example" },
      r.bySlackId,
      r.byEmail
    );
    assert.equal(m.kind, "known");
  });

  it("links a new account to the unlinked row with its identity email", () => {
    const r = roster(row(1, null, "p0001@school.example"));
    const m = matchSlackAccount(
      { id: "U9", email: "P0001@School.Example" },
      r.bySlackId,
      r.byEmail
    );
    assert.equal(m.kind, "link");
    assert.equal(m.kind === "link" && m.person.id, 1);
  });

  it("never moves a linked row to another account that shares its email", () => {
    const r = roster(row(1, "U1", "mentor@rhr.example"));
    const m = matchSlackAccount(
      { id: "U2", email: "mentor@rhr.example" },
      r.bySlackId,
      r.byEmail
    );
    assert.equal(m.kind, "unknown");
  });

  it("calls an account nobody has placed unknown", () => {
    const r = roster(row(1, "U1", "mentor@rhr.example"));
    assert.equal(
      matchSlackAccount({ id: "U3", email: null }, r.bySlackId, r.byEmail).kind,
      "unknown"
    );
  });
});
