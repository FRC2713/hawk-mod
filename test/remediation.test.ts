import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  remediates,
  type GroupConversation,
  type OneOnOneFinding,
} from "../src/domain/rules/remediation.js";

const finding: OneOnOneFinding = {
  id: 1,
  lastOccurredAt: "2026-08-12T10:00:00.000Z",
  students: ["S1"],
  adults: ["A1"],
};

function group(over: Partial<GroupConversation> = {}): GroupConversation {
  return {
    id: "G1",
    lastMessageAt: "2026-08-12T10:05:00.000Z",
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
   * The ordinary way to comply, and the one an earlier version of this rule
   * wrongly rejected: the team already had a group chat, and the adult simply
   * carried the conversation into it. Nothing is created, so anchoring on when
   * the group was made would refuse to see the remedy at all.
   */
  it("accepts a group that already existed but has just been used", () => {
    assert.equal(
      remediates(finding, group({ lastMessageAt: "2026-08-12T10:00:30.000Z" })),
      true
    );
  });

  /**
   * The one that matters. A group thread nobody has spoken in since cannot have
   * been the response to a 1:1 that happened later, and treating it as one
   * would let a fresh violation be laundered with an old thread.
   */
  it("rejects a group whose last message predates the 1:1", () => {
    assert.equal(
      remediates(finding, group({ lastMessageAt: "2026-08-12T09:00:00.000Z" })),
      false
    );
  });

  /**
   * The same rule, applied to an adult who used the group once and then carried
   * on DMing the student privately anyway. The later 1:1 message moves the
   * anchor past the group's last message, so the group stops answering for it —
   * otherwise one trip to the group chat would excuse every 1:1 that followed
   * it, forever.
   */
  it("rejects a group not used since a later 1:1 message", () => {
    const recurred: OneOnOneFinding = {
      ...finding,
      lastOccurredAt: "2026-08-12T11:00:00.000Z",
    };
    assert.equal(
      remediates(
        recurred,
        group({ lastMessageAt: "2026-08-12T10:05:00.000Z" })
      ),
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
