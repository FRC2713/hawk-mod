import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fencedReplies } from "../src/slack/replyChunks.js";

/**
 * A long lifecycle preview is split between lines into code blocks that each
 * fit in a Slack message, rather than being cut off (#74).
 */

const lines = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `      P${String(i).padStart(4, "0")} Alex S. (Student)`
  );

describe("splitting a long reply", () => {
  it("leaves a short reply as one code block", () => {
    assert.deepEqual(fencedReplies("a\nb"), ["```a\nb```"]);
  });

  it("splits between lines, every piece fenced and within the limit", () => {
    const text = lines(200).join("\n");
    const replies = fencedReplies(text, { chars: 1000, max: 50 });
    assert.ok(replies.length > 1);
    for (const r of replies) {
      assert.ok(r.length <= 1000, `${r.length} characters`);
      assert.ok(r.startsWith("```") && r.endsWith("```"));
    }
    // Nothing lost, nothing split mid-line.
    assert.equal(replies.map((r) => r.slice(3, -3)).join("\n"), text);
  });

  it("cuts a single line too long for one reply", () => {
    const replies = fencedReplies("x".repeat(25), { chars: 16, max: 50 });
    assert.equal(replies.map((r) => r.slice(3, -3)).join(""), "x".repeat(25));
    for (const r of replies) assert.ok(r.length <= 16);
  });

  it("says what was left out when there are more pieces than replies", () => {
    const replies = fencedReplies(lines(200).join("\n"), {
      chars: 1000,
      max: 3,
    });
    assert.equal(replies.length, 3);
    assert.match(
      replies[2]!,
      /more line\(s\), not shown: Slack allows 3 replies/
    );
  });

  it("fits a 180-join preview in one reply by default", () => {
    assert.equal(fencedReplies(lines(180).join("\n")).length, 1);
  });
});
