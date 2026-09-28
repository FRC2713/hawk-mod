import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { planGoogleGroups } from "../src/domain/lifecycle/groupPlan.js";
import { formatGroupPlans } from "../src/domain/lifecycle/groupReport.js";
import { GOOGLE_GROUP_IDS, GROUPS } from "../src/domain/lifecycle/groups.js";
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

const found = {
  "grp-students": {
    name: "grp-students",
    email: "students@team.example",
    count: 2,
  },
  "grp-alumni": { name: "grp-alumni", email: "alumni@team.example", count: 0 },
  "grp-parents": {
    name: "grp-parents",
    email: "frc-parents@team.example",
    count: 0,
  },
  // An ID pasted on the wrong line: it leads to the parents group.
  "grp-mentors": {
    name: "grp-parents",
    email: "frc-parents@team.example",
    count: 9,
  },
};

const report = (members: boolean) =>
  formatGroupPlans({
    plans,
    found,
    missing: {
      "grp-ra": { id: "02nusc193nukp6h" },
      "grp-volunteers": { id: "" },
    },
    members,
    dryRun: true,
  });

/** The report's lines that are not group addresses, which are team lists. */
const withoutGroupAddresses = (text: string) =>
  text.replace(/\([a-z-]+@team\.example, /g, "(");

describe("groups dry run text", () => {
  it("names Person IDs and counts, and no person's address, in Slack", () => {
    const text = report(false);
    assert.ok(!withoutGroupAddresses(text).includes("@"), text);
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

  it("shows each group's current address beside it", () => {
    assert.match(
      report(false),
      /grp-students \(students@team\.example, 2 now\)/
    );
  });

  it("says when no group has an ID, or no ID is set", () => {
    const text = report(false);
    assert.match(text, /grp-ra: no group has ID 02nusc193nukp6h/);
    assert.match(text, /grp-volunteers: no ID yet/);
  });

  it("warns loudly when an ID leads to a differently named group", () => {
    assert.match(
      report(false),
      /grp-mentors \(frc-parents@team\.example, 9 now\)\n {4}WRONG GROUP: this ID belongs to a group named "grp-parents"/
    );
  });

  it("leaves missing and wrong groups out of the totals", () => {
    // Counted: grp-students (P0020 joins; P0021 and a stranger held) and
    // grp-parents (P0020's parent joins). Not grp-mentors, whose ID leads to
    // the wrong group, nor the groups with no group behind their ID.
    assert.match(report(false), /Would join: 2 · .* held for a click: 2/);
  });

  it("says when a group already matches", () => {
    assert.match(
      report(false),
      /grp-alumni \(alumni@team\.example, 0 now\)\n {4}Matches the sheet\./
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

describe("Red Hawk's group IDs", () => {
  const ids = GROUPS.map((g) => GOOGLE_GROUP_IDS[g]);

  it("gives every group an ID", () => {
    for (const g of GROUPS) assert.ok(GOOGLE_GROUP_IDS[g], `${g} has no ID`);
  });

  it("never gives two groups the same ID", () => {
    const set = ids.filter(Boolean);
    assert.equal(new Set(set).size, set.length, "an ID appears twice");
  });

  it("looks like a Google group ID", () => {
    for (const id of ids.filter(Boolean)) assert.match(id, /^0[0-9a-z]{14}$/);
  });
});
