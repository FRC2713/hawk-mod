import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesGroup } from "../src/slack/userGroups.js";

const students = { id: "S0614TY5A", handle: "students" };
const mentors = { id: "S07QQ2M1B", handle: "mentors" };

describe("finding a user group by handle or id", () => {
  it("matches a plain handle", () => {
    assert.equal(matchesGroup(students, "students"), true);
  });

  it("matches a handle written with @", () => {
    assert.equal(matchesGroup(students, "@students"), true);
  });

  it("matches regardless of case", () => {
    assert.equal(matchesGroup(students, "@Students"), true);
  });

  it("matches the id Slack sends in an escaped mention", () => {
    assert.equal(matchesGroup(students, "S0614TY5A"), true);
  });

  it("does not match a different group", () => {
    assert.equal(matchesGroup(mentors, "students"), false);
    assert.equal(matchesGroup(students, "S07QQ2M1B"), false);
  });

  it("ignores surrounding whitespace", () => {
    assert.equal(matchesGroup(students, "  @students  "), true);
  });

  it("does not match nothing", () => {
    assert.equal(matchesGroup(students, ""), false);
    assert.equal(matchesGroup(students, "  "), false);
    assert.equal(matchesGroup(students, "@"), false);
  });

  it("copes with a group Slack returned without a handle", () => {
    assert.equal(matchesGroup({ id: "S1234ABCD" }, "students"), false);
    assert.equal(matchesGroup({ handle: "students" }, "S1234ABCD"), false);
  });

  /**
   * The regression, and it was as bad as it looks. Resolution used to decide up
   * front whether a reference was a handle or an id, using a pattern for Slack
   * ids: `S` followed by alphanumerics. `students` uppercased is `STUDENTS` —
   * an `S` and seven more characters — so the single most important handle in
   * this project was read as an opaque id, matched against no group, and
   * reported as missing.
   *
   * That broke `/hawkmod config`, `/hawkmod group`, and the role sync, which
   * meant no student was rostered and so none was monitored. Matching on either
   * handle or id removes the guess that made it possible.
   */
  it("matches handles that look like a Slack id", () => {
    for (const handle of ["students", "staff", "seniors", "scouting"]) {
      assert.equal(
        matchesGroup({ id: "S0614TY5A", handle }, handle),
        true,
        `@${handle} must resolve by handle`
      );
    }
  });
});
