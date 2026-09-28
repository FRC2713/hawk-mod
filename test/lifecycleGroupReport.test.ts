import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { planGoogleGroups } from "../src/domain/lifecycle/groupPlan.js";
import { formatGroupPlans } from "../src/domain/lifecycle/groupReport.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import { googleActor, googleDomain } from "../src/google/credentials.js";
import { pageAddresses } from "../src/google/directory.js";

/**
 * The groups dry run is posted into Slack, and most of the people in these
 * groups are minors or their parents: Person IDs and counts only, unless the
 * CLI asks for addresses.
 */

const AS_OF = "2026-09-28";

function student(
  personId: string,
  extra: Partial<SheetPerson> = {}
): SheetPerson {
  return {
    personId,
    name: `Student ${personId}`,
    personalEmail: `${personId.toLowerCase()}@home.example`,
    status: "active",
    roles: ["Student"],
    mentor: null,
    student: {
      row: 2,
      schoolEmail: `${personId.toLowerCase()}@school.example`,
      slackUserId: null,
      lead: false,
      slackConsentExpiry: null,
    },
    adminRoles: [],
    parentEmails: [],
    ...extra,
  };
}

const people = [
  student("P0020", { parentEmails: ["mom@home.example"] }),
  student("P0021", { status: "inactive" }),
];

const plans = planGoogleGroups({
  people,
  actual: {
    "grp-students": ["p0021@school.example", "stranger@elsewhere.example"],
    "grp-alumni": [],
  },
  asOf: AS_OF,
});

const report = (members: boolean) =>
  formatGroupPlans({
    plans,
    current: { "grp-students": 2, "grp-alumni": 0 },
    missing: ["grp-ra"],
    members,
    dryRun: true,
  });

describe("groups dry run text", () => {
  it("names Person IDs and counts, and no address, in Slack", () => {
    const text = report(false);
    assert.ok(!text.includes("@"), text);
    assert.match(text, /Would join: 1\n {6}P0020/);
    assert.match(text, /P0021: Inactive on the sheet/);
    assert.match(text, /Held, not on the sheet: 1 address\(es\)/);
    assert.match(text, /parent of P0020/);
  });

  it("lists addresses only when the CLI asks", () => {
    const text = report(true);
    assert.match(text, /<stranger@elsewhere\.example>/);
    assert.match(text, /parent of P0020 <mom@home\.example>/);
  });

  it("says a missing group must be created by hand", () => {
    assert.match(report(false), /grp-ra: does not exist in Google/);
  });

  it("says when a group already matches", () => {
    assert.match(
      report(false),
      /grp-alumni \(0 now\)\n {4}Matches the sheet\./
    );
  });

  it("says it is a dry run", () => {
    assert.match(report(false), /dry run: nothing changed/);
  });
});

describe("reading a group's members", () => {
  it("lower-cases addresses and drops blanks", () => {
    assert.deepEqual(
      pageAddresses({
        members: [{ email: "A@Example.org" }, {}, { email: "b@example.org" }],
      }),
      ["a@example.org", "b@example.org"]
    );
    assert.deepEqual(pageAddresses({}), []);
  });
});

describe("the account hawk-mod acts as", () => {
  afterEach(() => {
    delete process.env.GOOGLE_DOMAIN;
    delete process.env.GOOGLE_ADMIN_SUBJECT;
  });

  it("is hawk-mod@ the team's domain unless the environment says otherwise", () => {
    assert.equal(googleDomain(), "redhawkrobotics.org");
    assert.equal(googleActor(), "hawk-mod@redhawkrobotics.org");
    process.env.GOOGLE_ADMIN_SUBJECT = "someone@example.org";
    assert.equal(googleActor(), "someone@example.org");
  });
});
