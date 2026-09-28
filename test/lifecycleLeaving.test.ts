import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coriExpiringFinding,
  coriExpiringSoon,
} from "../src/domain/lifecycle/cori.js";
import { planGoogleGroups } from "../src/domain/lifecycle/groupPlan.js";
import {
  heldMemberFinding,
  heldSubjects,
  maskAddress,
} from "../src/domain/lifecycle/heldMembers.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import {
  lifecycleAction,
  REMOVE_FROM_GROUPS_ACTION,
} from "../src/slack/alerts.js";

/**
 * Leaving waits for a click (step 4, part 4): who is held, gathered into one
 * alert each, and what those alerts say and offer. And the 60-day CORI
 * warning, so the lapse is never a surprise.
 */

const AS_OF = "2026-09-28";

function student(
  personId: string,
  extra: Partial<SheetPerson> = {}
): SheetPerson {
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
      slackConsentExpiry: null,
    },
    adminRoles: [],
    parentEmails: [],
    ...extra,
  };
}

function mentor(personId: string, cori: string | null): SheetPerson {
  return {
    ...student(personId),
    name: `Mentor ${personId}`,
    roles: ["Mentor"],
    student: null,
    mentor: {
      row: 3,
      rhrEmail: `${personId.toLowerCase()}@rhr.example`,
      slackUserId: null,
      yptExpiry: null,
      screeningExpiry: null,
      coriExpiry: cori,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: false,
    },
  };
}

const people = [
  // Left: their own groups and one parent go with them.
  student("P0020", {
    status: "inactive",
    parentEmails: ["mom@home.example", "dad@home.example"],
  }),
  // A younger sibling still Active keeps mom listed.
  student("P0021", { parentEmails: ["mom@home.example"] }),
  mentor("P0010", "2026-09-01"), // CORI lapsed
];

const plans = planGoogleGroups({
  people,
  actual: {
    "grp-students": ["p0020@school.example", "p0021@school.example"],
    "grp-parents": ["mom@home.example", "dad@home.example"],
    "grp-mentors": ["p0010@rhr.example", "stranger@elsewhere.example"],
  },
  asOf: AS_OF,
});
const subjects = heldSubjects(plans);
const byKey = new Map(subjects.map((s) => [s.key, s]));
const names = new Map(people.map((p) => [p.personId, p.name]));

describe("who is held, one alert each", () => {
  it("puts a departing student's groups and their parent in one alert", () => {
    const s = byKey.get("group_member_held:P0020");
    assert.ok(s);
    assert.deepEqual(
      s.entries.map((e) => [e.group, e.address]),
      [
        ["grp-students", "p0020@school.example"],
        ["grp-parents", "dad@home.example"],
      ]
    );
  });

  it("never holds a parent an Active sibling still lists", () => {
    const all = subjects.flatMap((s) => s.entries.map((e) => e.address));
    assert.ok(!all.includes("mom@home.example"));
  });

  it("makes a mentor held only for CORI a cori_lapsed alert", () => {
    const s = byKey.get("cori_lapsed:P0010");
    assert.equal(s?.kind, "cori_lapsed");
    assert.deepEqual(
      s?.entries.map((e) => e.group),
      ["grp-mentors"]
    );
  });

  it("gives an address nobody on the sheet has its own alert", () => {
    const s = byKey.get("group_member_held:address:stranger@elsewhere.example");
    assert.equal(s?.personId, null);
  });
});

describe("what the alerts say and offer", () => {
  const finding = (key: string, inSlack = false) =>
    heldMemberFinding(byKey.get(key)!, { names, inSlack: () => inSlack });

  it("names the person, the groups and the parent, and removes nothing", () => {
    const f = finding("group_member_held:P0020");
    assert.equal(
      f.summary,
      "P0020 Student P0020 is Inactive on the lifecycle sheet: still in " +
        "grp-students; a parent still in grp-parents. Nothing was removed."
    );
    assert.ok(!f.summary.includes("@"));
  });

  it("shows an unplaceable address only partly", () => {
    const f = finding("group_member_held:address:stranger@elsewhere.example");
    assert.match(f.summary, /s…@elsewhere\.example/);
    assert.ok(!f.summary.includes("stranger"));
    assert.equal(maskAddress("kid@home.example"), "k…@home.example");
  });

  it("reminds about Slack for a lapsed mentor who is in it", () => {
    assert.match(finding("cori_lapsed:P0010", true).summary, /out of Slack/);
    assert.doesNotMatch(finding("cori_lapsed:P0010", false).summary, /Slack/);
  });

  it("offers Remove from groups, and Remove from mentor groups for CORI", () => {
    const held = finding("group_member_held:P0020");
    const cori = finding("cori_lapsed:P0010");
    assert.deepEqual(
      lifecycleAction({ kind: held.kind, dedupe_key: held.dedupeKey }),
      { actionId: REMOVE_FROM_GROUPS_ACTION, label: "Remove from groups" }
    );
    assert.deepEqual(
      lifecycleAction({ kind: cori.kind, dedupe_key: cori.dedupeKey }),
      {
        actionId: REMOVE_FROM_GROUPS_ACTION,
        label: "Remove from mentor groups",
      }
    );
  });
});

describe("the 60-day CORI warning", () => {
  const soon = (
    cori: string | null,
    status: SheetPerson["status"] = "active"
  ) => coriExpiringSoon([{ ...mentor("P0010", cori), status }], AS_OF);

  it("warns from 60 days out to the day itself", () => {
    assert.equal(soon("2026-11-27").length, 1); // 60 days
    assert.equal(soon("2026-09-28").length, 1); // today
    assert.equal(soon("2026-11-28").length, 0); // 61 days
  });

  it("does not warn about a CORI already lapsed, or an Inactive mentor", () => {
    assert.equal(soon("2026-09-27").length, 0);
    assert.equal(soon("2026-10-15", "inactive").length, 0);
    assert.equal(soon(null).length, 0);
  });

  it("warns once per expiry date: a renewed date is a new key", () => {
    const [a] = soon("2026-10-15");
    const renewed = { ...a!, expiresOn: "2029-10-15" };
    assert.notEqual(
      coriExpiringFinding(a!).dedupeKey,
      coriExpiringFinding(renewed).dedupeKey
    );
    assert.match(
      coriExpiringFinding(a!).summary,
      /expires on 2026-10-15 \(17 days\)/
    );
  });
});
