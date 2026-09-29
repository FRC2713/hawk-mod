import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressKey } from "../src/domain/lifecycle/address.js";
import { planGoogleGroups } from "../src/domain/lifecycle/groupPlan.js";
import { planUnaccounted } from "../src/domain/lifecycle/offboarding.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";

/**
 * Gmail ignores dots and `+tags`, and Google Groups keeps a member under the
 * account's own spelling. A parent on the sheet as `h.smith@gmail.com` sat
 * in grp-parents as `hsmith@gmail.com`, was "added" every hour, and was held
 * as an address nobody lists (#142, 2026-09-29).
 */

const AS_OF = "2026-09-29";

function student(personId: string, parentEmails: string[]): SheetPerson {
  return {
    personId,
    name: `Student ${personId}`,
    personalEmail: null,
    status: "active",
    roles: ["Student"],
    mentor: null,
    student: {
      row: 2,
      schoolEmail: `${personId.toLowerCase()}@school.example`,
      slackUserId: null,
      lead: false,
      slackConsentExpiry: "2027-08-01",
    },
    adminRoles: [],
    parentEmails,
  };
}

describe("comparing addresses as Gmail does", () => {
  it("ignores dots, a +tag and case, and treats googlemail.com as gmail.com", () => {
    for (const a of [
      "h.smith@gmail.com",
      "HSmith@Gmail.com",
      "h.s.m.i.t.h+team@gmail.com",
      "hsmith@googlemail.com",
      " hsmith@gmail.com ",
    ]) {
      assert.equal(addressKey(a), "hsmith@gmail.com", a);
    }
  });

  it("leaves every other domain as written, lower-cased", () => {
    assert.equal(addressKey("H.Smith@Example.org"), "h.smith@example.org");
    assert.notEqual(
      addressKey("h.smith@school.example"),
      addressKey("hsmith@school.example")
    );
    assert.equal(addressKey("pat+x@rhr.example"), "pat+x@rhr.example");
  });
});

describe("a parent Google keeps under another spelling", () => {
  it("is neither added again nor held", () => {
    const [parents] = planGoogleGroups({
      people: [student("P0063", ["h.smith@gmail.com"])],
      actual: { "grp-parents": ["hsmith@gmail.com"] },
      asOf: AS_OF,
    }).filter((p) => p.group === "grp-parents");
    assert.deepEqual(parents?.add, []);
    assert.deepEqual(parents?.held, []);
  });

  it("is still added, by the sheet's spelling, when really missing", () => {
    const [parents] = planGoogleGroups({
      people: [student("P0063", ["h.smith@gmail.com"])],
      actual: { "grp-parents": [] },
      asOf: AS_OF,
    }).filter((p) => p.group === "grp-parents");
    assert.deepEqual(parents?.add, [
      { address: "h.smith@gmail.com", personIds: ["P0063"] },
    ]);
  });

  it("is one parent for two students who spell it differently", () => {
    const [parents] = planGoogleGroups({
      people: [
        student("P0063", ["h.smith@gmail.com"]),
        student("P0064", ["hsmith@gmail.com"]),
      ],
      actual: { "grp-parents": [] },
      asOf: AS_OF,
    }).filter((p) => p.group === "grp-parents");
    assert.deepEqual(parents?.add, [
      { address: "h.smith@gmail.com", personIds: ["P0063", "P0064"] },
    ]);
  });

  it("is on the sheet for the other groups' warnings too", () => {
    const u = planUnaccounted({
      people: [student("P0063", ["h.smith@gmail.com"])],
      roster: [],
      directory: null,
      groups: [
        {
          id: "g1",
          name: "grp-orders",
          members: [{ address: "hsmith@gmail.com", role: "MEMBER" }],
        },
      ],
    });
    assert.deepEqual(u.outsiders, []);
  });
});
