import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  planAdd,
  planGroupMembership,
  planRemove,
  reducesMonitoring,
} from "../src/domain/rules/groupMembership.js";

const set = (...ids: string[]) => new Set(ids);

describe("group membership plans", () => {
  it("adds one person without disturbing the rest", () => {
    const plan = planAdd(set("U1", "U2"), "U3");
    assert.deepEqual(plan.add, ["U3"]);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.result, ["U1", "U2", "U3"]);
    assert.equal(plan.refusal, null);
  });

  it("treats adding someone already present as a no-op", () => {
    const plan = planAdd(set("U1", "U2"), "U2");
    assert.deepEqual(plan.add, []);
    assert.deepEqual(plan.remove, []);
    assert.equal(plan.refusal, null);
  });

  it("removes one person however small the group", () => {
    // A person naming a person. Never refused for being proportionally large,
    // or removing someone from a group of three would be impossible.
    const plan = planRemove(set("U1", "U2", "U3"), "U2");
    assert.deepEqual(plan.remove, ["U2"]);
    assert.deepEqual(plan.result, ["U1", "U3"]);
    assert.equal(plan.refusal, null);
  });

  it("refuses to empty a group, because Slack rejects it anyway", () => {
    const plan = planRemove(set("U1"), "U1");
    assert.match(
      plan.refusal ?? "",
      /does not allow a user group to be emptied/
    );
  });

  it("refuses a bulk plan that removes most of a group", () => {
    // The shape of a bad spreadsheet: a handful of survivors, everyone else
    // silently dropped.
    const current = set("U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8");
    const plan = planGroupMembership(current, set("U1", "U2"));
    assert.deepEqual(plan.remove, ["U3", "U4", "U5", "U6", "U7", "U8"]);
    assert.match(plan.refusal ?? "", /would remove 6 of 8 members \(75%\)/);
  });

  it("allows a bulk plan within the removal limit", () => {
    const current = set("U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8");
    const plan = planGroupMembership(
      current,
      set("U1", "U2", "U3", "U4", "U5", "U6")
    );
    assert.deepEqual(plan.remove, ["U7", "U8"]);
    assert.equal(plan.refusal, null);
  });

  it("counts additions and removals in the same plan", () => {
    const plan = planGroupMembership(
      set("U1", "U2", "U3", "U4"),
      set("U1", "U2", "U3", "U9")
    );
    assert.deepEqual(plan.add, ["U9"]);
    assert.deepEqual(plan.remove, ["U4"]);
    assert.deepEqual(plan.unchanged, ["U1", "U2", "U3"]);
    assert.equal(plan.refusal, null);
  });

  it("carries the refusal on the plan rather than beside it", () => {
    // A caller cannot apply a refused plan by forgetting to check a flag
    // somewhere else; the refusal travels with the thing being applied.
    const plan = planRemove(set("U1"), "U1");
    assert.ok(plan.refusal);
    assert.deepEqual(plan.result, []);
  });

  it("respects a caller-supplied removal limit", () => {
    const current = set("U1", "U2", "U3", "U4");
    const strict = planGroupMembership(current, set("U1", "U2"), {
      maxRemovedFraction: 0.1,
    });
    assert.ok(strict.refusal);
    const loose = planGroupMembership(current, set("U1", "U2"), {
      maxRemovedFraction: 0.9,
    });
    assert.equal(loose.refusal, null);
  });
});

/**
 * The gate in front of the single most consequential edit hawk-mod can make.
 * It is keyed on the resolved handle for a reason — see the regression below.
 */
describe("edits that end a student's monitoring", () => {
  const adults = "adults";

  it("flags a student being added to the adults group", () => {
    assert.equal(
      reducesMonitoring({
        action: "add",
        subjectRole: "student",
        handle: "adults",
        adultHandle: adults,
      }),
      true
    );
  });

  it("ignores an adult being added to the adults group", () => {
    assert.equal(
      reducesMonitoring({
        action: "add",
        subjectRole: "adult",
        handle: "adults",
        adultHandle: adults,
      }),
      false
    );
  });

  it("ignores a student being added to any other group", () => {
    assert.equal(
      reducesMonitoring({
        action: "add",
        subjectRole: "student",
        handle: "programming",
        adultHandle: adults,
      }),
      false
    );
  });

  it("ignores removals, which never end monitoring", () => {
    assert.equal(
      reducesMonitoring({
        action: "remove",
        subjectRole: "student",
        handle: "adults",
        adultHandle: adults,
      }),
      false
    );
  });

  it("matches regardless of @ prefix or case on either side", () => {
    assert.equal(
      reducesMonitoring({
        action: "add",
        subjectRole: "student",
        handle: "Adults",
        adultHandle: "@adults",
      }),
      true
    );
  });

  /**
   * Regression. The first version of this compared the *raw slash-command
   * argument* to the configured handle. The app sets `should_escape: true`, so
   * Slack sends `<!subteam^S0614TY5A|adults>` and the raw argument is an opaque
   * id — which never equals "adults", so the gate never fired and a student
   * could be moved into the adults group by typo, with no reason recorded.
   * Only the resolved handle is a safe input here.
   */
  it("is not fooled by a group id, because it never sees one", () => {
    assert.equal(
      reducesMonitoring({
        action: "add",
        subjectRole: "student",
        handle: "S0614TY5A",
        adultHandle: adults,
      }),
      false
    );
  });
});
