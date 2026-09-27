import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Person } from "../src/domain/people.js";
import { planRoster } from "../src/domain/lifecycle/roster.js";
import { formatRosterPlan } from "../src/domain/lifecycle/rosterReport.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";

/**
 * The dry run is posted into Slack and mostly describes minors, so it may name
 * Person IDs, roster rows, Slack IDs and dates, and never a name or an
 * address. This builds a plan that touches every section and checks the text.
 */

function rosterRow(id: number, overrides: Partial<Person>): Person {
  return {
    id,
    person_id: null,
    slack_user_id: null,
    email: null,
    full_name: `Roster Name ${id}`,
    role: "student",
    active: 1,
    screening_expires_on: null,
    training_expires_on: null,
    cori_expires_on: null,
    consent_release_expires_on: null,
    data_privacy_expires_on: null,
    mentor_ready_completed_on: null,
    slack_consent_expires_on: null,
    notes: null,
    created_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

function student(
  personId: string,
  name: string,
  overrides: Partial<SheetPerson> = {}
): SheetPerson {
  return {
    personId,
    name,
    personalEmail: `${name.split(" ")[0]!.toLowerCase()}@home.example`,
    status: "active",
    roles: ["Student"],
    mentor: null,
    student: {
      row: 2,
      schoolEmail: `${name.split(" ")[0]!.toLowerCase()}@school.example`,
      slackUserId: null,
      lead: false,
      slackConsentExpiry: null,
    },
    adminRoles: [],
    ...overrides,
  };
}

const sheet: SheetPerson[] = [
  student("P0100", "Avery Quinn"), // new row
  student("P0101", "Blake Rowe"), // matched by email, consent cleared
  student("P0102", "Casey Stone", { status: "inactive" }), // undeclared
  {
    ...student("P0103", "Drew Tate"),
    roles: ["Mentor"],
    student: null,
    mentor: {
      row: 3,
      rhrEmail: "drew@rhr.example",
      slackUserId: null,
      yptExpiry: null,
      screeningExpiry: null,
      coriExpiry: null,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: false,
    },
  }, // roster_drift
];

const roster: Person[] = [
  rosterRow(1, {
    email: "blake@school.example",
    full_name: "Blake R",
    slack_user_id: "U1",
    slack_consent_expires_on: "2027-08-01",
  }),
  rosterRow(2, { person_id: "P0102", full_name: "Casey Stone" }),
  rosterRow(3, { person_id: "P0103", full_name: "Drew Tate" }),
  rosterRow(4, {
    email: "emery@personal.example",
    full_name: "Emery Vance",
    slack_user_id: "U4",
  }), // unmatched, refuses the first apply
];

const plan = planRoster({
  roster,
  sheet,
  accounts: [
    { id: "U1", email: "blake@school.example", live: true },
    { id: "U4", email: "emery@personal.example", live: true },
  ],
  firstApply: true,
});

const text = formatRosterPlan({ plan, roster, sheetProblems: 2, dryRun: true });

describe("roster dry run text", () => {
  it("names no one and quotes no address", () => {
    for (const secret of [
      "Avery",
      "Blake",
      "Casey",
      "Drew",
      "Emery",
      "@",
      "example",
    ]) {
      assert.ok(!text.includes(secret), `report contains "${secret}"`);
    }
  });

  it("says nothing changed, and that the first apply would be refused", () => {
    assert.match(text, /dry run: nothing changed/);
    assert.match(text, /WOULD BE REFUSED: 1 roster row/);
  });

  it("lists every date that would be cleared, with the value it had", () => {
    assert.match(text, /P0101 \(row 1\): Slack Consent 2027-08-01 -> blank/);
  });

  it("shows matches, new rows and every kind of question", () => {
    assert.match(text, /row 1 -> P0101/);
    assert.match(text, /P0100 student, not in Slack yet/);
    assert.match(text, /P0102 \(row 2\) student: Inactive on the sheet/);
    assert.match(text, /row 4, Slack U4 student: matches nobody on the sheet/);
    assert.match(text, /\[Make adult\]: 1\n {4}P0103 \(row 3\)/);
    assert.match(text, /2 sheet problem\(s\)/);
  });
});
