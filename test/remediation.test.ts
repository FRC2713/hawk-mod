import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  remediates,
  type GroupConversation,
  type OneOnOneFinding,
} from "../src/domain/rules/remediation.js";

const finding: OneOnOneFinding = {
  id: 1,
  firstSeenAt: "2026-08-12T10:00:00.000Z",
  students: ["S1"],
  adults: ["A1"],
};

function group(over: Partial<GroupConversation> = {}): GroupConversation {
  return {
    id: "G1",
    firstSeenAt: "2026-08-12T10:05:00.000Z",
    participants: ["A1", "A2", "S1"],
    studentIds: ["S1"],
    screenedAdultIds: ["A1", "A2"],
    ...over,
  };
}

describe("1:1 remediation", () => {
  it("accepts the same pair plus a second screened adult", () => {
    assert.equal(remediates(finding, group()), true);
  });

  /**
   * The one that matters. A group DM that already existed cannot have been
   * the response to a 1:1 that happened later, and treating it as one would
   * let a fresh violation be laundered with an old thread.
   */
  it("rejects a group DM that predates the finding", () => {
    assert.equal(
      remediates(finding, group({ firstSeenAt: "2026-08-12T09:00:00.000Z" })),
      false
    );
  });

  it("rejects a group that dropped the student", () => {
    assert.equal(
      remediates(
        finding,
        group({ participants: ["A1", "A2"], studentIds: [] })
      ),
      false
    );
  });

  it("rejects a group missing the adult who was in the 1:1", () => {
    assert.equal(
      remediates(
        finding,
        group({
          participants: ["A2", "A3", "S1"],
          screenedAdultIds: ["A2", "A3"],
        })
      ),
      false
    );
  });

  it("rejects a second adult who is not screened", () => {
    assert.equal(
      remediates(finding, group({ screenedAdultIds: ["A1"] })),
      false
    );
  });

  it("accepts a bigger group so long as everyone carried over", () => {
    assert.equal(
      remediates(
        finding,
        group({
          participants: ["A1", "A2", "A3", "S1", "S2"],
          studentIds: ["S1", "S2"],
          screenedAdultIds: ["A1", "A2", "A3"],
        })
      ),
      true
    );
  });
});
