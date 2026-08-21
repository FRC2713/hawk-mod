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
    ypt_completed_on: null,
    mentor_ready_on: null,
    cori_completed_on: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** Someone the roster remembers but no longer monitors. */
function deactivated(p: Person): Person {
  return { ...p, active: 0 };
}

function roster(...people: Person[]): Map<string, Person> {
  return new Map(people.map((p) => [p.slack_user_id!, p]));
}

const groups = (students: string[], adults: string[]) => ({
  students: new Set(students),
  adults: new Set(adults),
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
      roster(person("U1", "student"), person("U2", "adult")),
      groups(["U1"], ["U2"])
    );
    assert.deepEqual(
      decisions.map((d) => d.kind),
      ["unchanged", "unchanged"]
    );
  });

  it("does not demote the district observer", () => {
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
    assert.equal(d.to, "adult");
    assert.equal(d.reducesProtection, true);
  });

  it("moving an adult into the students group increases protection", () => {
    const decisions = reconcileRoles(
      roster(person("U1", "adult")),
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

  /**
   * The mirror of the property above. Monitoring is sticky on the way out and
   * automatic on the way back in: a deactivated student who is declared again
   * is monitored again, without waiting for anyone to notice and approve it.
   */
  describe("returning after deactivation", () => {
    it("resumes monitoring when a deactivated student is declared again", () => {
      const p = deactivated(person("U1", "student"));
      const decisions = reconcileRoles(roster(p), groups(["U1"], []));
      assert.deepEqual(decisions, [
        { kind: "reactivate", personId: p.id, slackId: "U1", role: "student" },
      ]);
    });

    it("resumes monitoring for a deactivated adult too", () => {
      const p = deactivated(person("U1", "adult"));
      const decisions = reconcileRoles(roster(p), groups([], ["U1"]));
      assert.deepEqual(decisions, [
        { kind: "reactivate", personId: p.id, slackId: "U1", role: "adult" },
      ]);
    });

    it("keeps a deactivated district observer's role while resuming them", () => {
      const p = deactivated(person("U1", "district_observer"));
      const decisions = reconcileRoles(roster(p), groups([], ["U1"]));
      assert.deepEqual(decisions, [
        {
          kind: "reactivate",
          personId: p.id,
          slackId: "U1",
          role: "district_observer",
        },
      ]);
    });

    it("reactivates and changes role in one decision", () => {
      const p = deactivated(person("U1", "student"));
      const decisions = reconcileRoles(roster(p), groups([], ["U1"]));
      const d = decisions[0]!;
      assert.equal(d.kind, "change");
      if (d.kind !== "change") return;
      assert.equal(d.to, "adult");
      assert.equal(d.reactivates, true);
      assert.equal(d.reducesProtection, true);
    });

    it("does not reactivate someone who is in no group", () => {
      const p = deactivated(person("U1", "student"));
      assert.deepEqual(reconcileRoles(roster(p), groups([], [])), []);
    });

    it("says nothing about an active person who is already right", () => {
      const decisions = reconcileRoles(
        roster(person("U1", "student")),
        groups(["U1"], [])
      );
      assert.deepEqual(decisions, [{ kind: "unchanged", slackId: "U1" }]);
    });

    /**
     * There is no decision that deactivates anybody. If one ever appears here,
     * the sync has gained the power to end monitoring on its own.
     */
    it("never produces a decision that ends monitoring", () => {
      const people = [
        person("U1", "student"),
        person("U2", "adult"),
        deactivated(person("U3", "student")),
        deactivated(person("U4", "adult")),
      ];
      const decisions = reconcileRoles(
        roster(...people),
        groups(["U1", "U3"], ["U2", "U4"])
      );
      for (const d of decisions) {
        assert.notEqual(d.kind, "deactivate");
        if (d.kind === "change") assert.notEqual(d.reactivates, undefined);
      }
    });
  });
});
