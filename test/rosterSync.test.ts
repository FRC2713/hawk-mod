import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Person, Role } from "../src/domain/people.js";
import { reconcileRoles } from "../src/domain/rules/rosterSync.js";

let nextId = 1;

function person(slackId: string, role: Role): Person {
  const id = nextId++;
  return {
    id,
    slack_user_id: slackId,
    email: `p${id}@example.org`,
    full_name: `Person ${id}`,
    role,
    active: 1,
    ypp_completed_on: null,
    mentor_ready_on: null,
    cori_completed_on: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function roster(...people: Person[]): Map<string, Person> {
  return new Map(people.map((p) => [p.slack_user_id!, p]));
}

const groups = (students: string[], mentors: string[]) => ({
  students: new Set(students),
  mentors: new Set(mentors),
});

describe("user group reconciliation", () => {
  it("creates a roster row for a group member nobody imported", () => {
    const decisions = reconcileRoles(roster(), groups(["U1"], []));
    assert.deepEqual(decisions, [
      { kind: "create", slackId: "U1", role: "student" },
    ]);
  });

  it("leaves agreement alone", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "student"), person("U2", "mentor")),
      groups(["U1"], ["U2"])
    );
    assert.deepEqual(
      decisions.map((d) => d.kind),
      ["unchanged", "unchanged"]
    );
  });

  it("does not demote a lead coach who is also in the mentors group", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "lead_coach")),
      groups([], ["U1"])
    );
    assert.equal(decisions[0]!.kind, "unchanged");
  });

  it("does not demote the district observer either", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "district_observer")),
      groups([], ["U1"])
    );
    assert.equal(decisions[0]!.kind, "unchanged");
  });

  it("promotes an adult who was wrongly rostered as a student, and says so", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "student")),
      groups([], ["U1"])
    );
    const d = decisions[0]!;
    assert.equal(d.kind, "change");
    if (d.kind !== "change") return;
    assert.equal(d.from, "student");
    assert.equal(d.to, "mentor");
    assert.equal(d.reducesProtection, true);
  });

  it("moving an adult into the students group increases protection", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "mentor")),
      groups(["U1"], [])
    );
    const d = decisions[0]!;
    assert.equal(d.kind, "change");
    if (d.kind !== "change") return;
    assert.equal(d.reducesProtection, false);
  });

  /**
   * The property the whole design rests on: dropping someone from the students
   * group must never silently end their monitoring.
   */
  it("leaves a student a student when they are in no group at all", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "student")),
      groups([], [])
    );
    assert.deepEqual(decisions, []);
  });

  it("refuses to act on someone in both groups", () => {
    const p = person("U1", "student");
    const decisions = reconcileRoles(roster(p), groups(["U1"], ["U1"]));
    assert.deepEqual(decisions, [
      { kind: "conflict", slackId: "U1", personId: p.id },
    ]);
  });

  it("reports a both-groups conflict even for someone not yet on the roster", () => {
    const decisions = reconcileRoles(roster(), groups(["U9"], ["U9"]));
    assert.deepEqual(decisions, [
      { kind: "conflict", slackId: "U9", personId: null },
    ]);
  });
});
