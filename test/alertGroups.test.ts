import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chunkLines,
  GROUP_THRESHOLD,
  planPosting,
  summaryText,
} from "../src/domain/alertGroups.js";
import type { FindingKind } from "../src/domain/findings.js";

/**
 * 1 August (#86): four or more new condition findings of one kind in one
 * sweep share a summary; fewer, or anything that records an event, are
 * posted one by one.
 */

const groupable = new Set<FindingKind>([
  "unconsented_account",
  "screening_lapsed",
]);

const raised = (kind: FindingKind, ...ids: number[]) =>
  ids.map((id) => ({ id, kind }));

describe("which new findings share a summary", () => {
  it("groups at four of a kind, and not at three", () => {
    assert.equal(GROUP_THRESHOLD, 4);
    const four = planPosting(
      raised("unconsented_account", 1, 2, 3, 4),
      groupable
    );
    assert.deepEqual(four, {
      singles: [],
      groups: [{ kind: "unconsented_account", ids: [1, 2, 3, 4] }],
    });
    const three = planPosting(
      raised("unconsented_account", 1, 2, 3),
      groupable
    );
    assert.deepEqual(three, { singles: [1, 2, 3], groups: [] });
  });

  it("makes one summary per kind, never mixing kinds", () => {
    const p = planPosting(
      [
        ...raised("unconsented_account", 1, 2, 3, 4),
        ...raised("screening_lapsed", 5, 6, 7, 8, 9),
        ...raised("unknown_account", 10),
      ],
      new Set([...groupable, "unknown_account"])
    );
    assert.deepEqual(p.singles, [10]);
    assert.deepEqual(
      p.groups.map((g) => [g.kind, g.ids]),
      [
        ["unconsented_account", [1, 2, 3, 4]],
        ["screening_lapsed", [5, 6, 7, 8, 9]],
      ]
    );
  });

  it("never groups a kind that records an event", () => {
    const p = planPosting(raised("student_enrolled", 1, 2, 3, 4, 5), groupable);
    assert.deepEqual(p, { singles: [1, 2, 3, 4, 5], groups: [] });
  });
});

describe("the summary's words", () => {
  const f = (
    id: number,
    status: "open" | "acknowledged" | "resolved" = "open",
    resolved_by: string | null = null
  ) => ({
    id,
    severity: "violation" as const,
    summary: `Student ${id} has a Slack account but their Slack Consent form is missing.`,
    status,
    resolved_by,
  });

  it("counts what is still open, and strikes through what closed", () => {
    const t = summaryText("unconsented_account", [
      f(1),
      f(2, "resolved", "Hawk Mod"),
      f(3),
      f(4, "acknowledged", "Rachel"),
    ]);
    assert.equal(
      t.headline,
      ":rotating_light: *unconsented_account* — 2 of 4 found together still open."
    );
    assert.equal(
      t.lines[0],
      "• #1 Student 1 has a Slack account but their Slack Consent form is missing."
    );
    assert.match(t.lines[1]!, /^• ~#2 .*~ _resolved by Hawk Mod_$/);
    assert.match(t.lines[3]!, /^• ~#4 .*~ _acknowledged by Rachel_$/);
    assert.match(t.footer, /\/hawkmod ack <id>/);
  });

  it("says so once every one is closed", () => {
    const t = summaryText("unconsented_account", [
      f(1, "resolved"),
      f(2, "resolved"),
    ]);
    assert.equal(
      t.headline,
      ":white_check_mark: *unconsented_account* — all 2 found together are closed."
    );
  });

  it("packs lines into blocks Slack will accept", () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `• #${i} ${"x".repeat(100)}`
    );
    const chunks = chunkLines(lines);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 2800));
    assert.equal(chunks.join("\n"), lines.join("\n"));
  });
});
