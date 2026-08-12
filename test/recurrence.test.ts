import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recurs,
  type ClosableFinding,
} from "../src/domain/rules/recurrence.js";

const CLOSED_AT = "2026-08-12T10:00:00.000Z";
const BEFORE = "2026-08-12T09:00:00.000Z";
const AFTER = "2026-08-12T11:00:00.000Z";

function closed(status: "acknowledged" | "resolved"): ClosableFinding {
  return { status, closedAt: CLOSED_AT };
}

describe("recurrence of an occurrence finding", () => {
  it("is not a recurrence when there is no finding yet", () => {
    // A first violation alerts because it is new, not because it recurred.
    assert.equal(recurs(undefined, AFTER), false);
  });

  it("is not a recurrence while the finding is still open", () => {
    assert.equal(recurs({ status: "open", closedAt: null }, AFTER), false);
  });

  /**
   * The bug this rule exists for. Acknowledging a 1:1 meant hearing about it
   * once and never again, however many messages followed — the silence read as
   * compliance.
   */
  it("re-alerts an acknowledged finding when a new message arrives", () => {
    assert.equal(recurs(closed("acknowledged"), AFTER), true);
  });

  it("re-alerts a resolved finding when a new message arrives", () => {
    assert.equal(recurs(closed("resolved"), AFTER), true);
  });

  /**
   * The other half. The DM stays in the adult's conversation list forever, so
   * the hourly backfill re-evaluates it forever; without this, resolving a
   * finding bought an hour of quiet before it came back on its own.
   */
  it("stays quiet when nothing has happened since the closure", () => {
    assert.equal(recurs(closed("resolved"), BEFORE), false);
    assert.equal(recurs(closed("acknowledged"), BEFORE), false);
  });

  it("stays quiet for backfilled history older than the closure", () => {
    // Walking DM history that predates enrollment turns up real messages we
    // had never recorded, but they are not new conduct: a human already looked
    // at this conversation and said so.
    assert.equal(recurs(closed("resolved"), "2026-01-01T00:00:00.000Z"), false);
  });

  it("treats a message at the closing instant as already covered", () => {
    assert.equal(recurs(closed("resolved"), CLOSED_AT), false);
  });

  it("alerts when a closed finding has no closure time to compare", () => {
    // Should not be reachable. If it is, the safe direction is noise.
    assert.equal(
      recurs({ status: "acknowledged", closedAt: null }, BEFORE),
      true
    );
  });
});
