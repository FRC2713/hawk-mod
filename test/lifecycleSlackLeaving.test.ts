import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planGoogleGroups } from "../src/domain/lifecycle/groupPlan.js";
import {
  heldMemberFinding,
  heldSubjects,
} from "../src/domain/lifecycle/heldMembers.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import {
  isSlackCopy,
  planSlackCopies,
  SLACK_GROUP_IDS,
} from "../src/domain/lifecycle/slackGroups.js";
import {
  lifecycleAction,
  REMOVE_FROM_GROUPS_ACTION,
} from "../src/slack/alerts.js";

/**
 * Step 5, part 4: someone held in a Slack copy is gathered into the same
 * one-per-person alert as the Google Groups, so Remove from groups takes them
 * out of both; a Slack account the sheet does not know gets its own.
 */

const AS_OF = "2026-09-28";

function mentor(personId: string, coriExpiry: string | null): SheetPerson {
  return {
    personId,
    name: `Mentor ${personId}`,
    personalEmail: null,
    status: "active",
    roles: ["Mentor"],
    mentor: {
      row: 2,
      rhrEmail: `${personId.toLowerCase()}@rhr.example`,
      slackUserId: null,
      yptExpiry: "2027-08-01",
      screeningExpiry: "2028-06-01",
      coriExpiry,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: false,
    },
    student: null,
    adminRoles: [],
    parentEmails: [],
  };
}

function student(personId: string): SheetPerson {
  return {
    personId,
    name: `Student ${personId}`,
    personalEmail: null,
    status: "inactive",
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
  };
}

const u = (personId: string) => `U${personId.slice(1)}`;

// P0004: no CORI, in grp-mentors and @mentors. P0019: no CORI, in @mentors
// only. P0020: Inactive student, in @students only. UGUEST: nobody's.
const people = [
  mentor("P0004", null),
  mentor("P0019", null),
  mentor("P0010", "2028-06-01"),
  student("P0020"),
];
const googlePlans = planGoogleGroups({
  people,
  actual: { "grp-mentors": ["p0004@rhr.example", "p0010@rhr.example"] },
  asOf: AS_OF,
});
const slackPlans = planSlackCopies({
  people,
  slackIds: new Map(people.map((p) => [p.personId, u(p.personId)])),
  actual: {
    "grp-mentors": ["U0004", "U0019", "U0010"],
    "grp-students": ["U0020", "UGUEST"],
  },
  asOf: AS_OF,
});
const subjects = heldSubjects(googlePlans, slackPlans);
const byKey = new Map(subjects.map((s) => [s.key, s]));
const names = new Map(people.map((p) => [p.personId, p.name]));
const finding = (key: string) =>
  heldMemberFinding(byKey.get(key)!, {
    names,
    inSlack: () => true,
    slackNames: new Map([["UGUEST", "Guest Person"]]),
  });

describe("held in the Slack copies", () => {
  it("keeps one alert per person, Google and Slack together, under the same key", () => {
    assert.deepEqual([...byKey.keys()].sort(), [
      "cori_lapsed:P0004",
      "cori_lapsed:P0019",
      "group_member_held:P0020",
      "group_member_held:slack:UGUEST",
    ]);
    const p4 = byKey.get("cori_lapsed:P0004")!;
    assert.deepEqual(
      p4.entries.map((e) => e.group),
      ["grp-mentors"]
    );
    assert.deepEqual(
      p4.slack.map((e) => e.copy),
      ["grp-mentors"]
    );
    assert.match(finding("cori_lapsed:P0004").summary, /grp-mentors, @mentors/);
  });

  it("raises a CORI alert for a mentor held only in @mentors", () => {
    const f = finding("cori_lapsed:P0019");
    assert.equal(f.kind, "cori_lapsed");
    assert.match(
      f.summary,
      /P0019 Mentor P0019 does not have CORI current, and is still in @mentors/
    );
    assert.deepEqual(
      lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey }),
      {
        actionId: REMOVE_FROM_GROUPS_ACTION,
        label: "Remove from mentor groups",
      }
    );
  });

  it("says why someone is held only in Slack", () => {
    assert.match(
      finding("group_member_held:P0020").summary,
      /P0020 Student P0020 is Inactive on the lifecycle sheet: still in @students/
    );
  });

  it("names a Slack account the sheet does not know by its Slack name", () => {
    const f = finding("group_member_held:slack:UGUEST");
    assert.match(f.summary, /Guest Person \(UGUEST\), is in @students/);
    assert.equal(f.subjectRef, "UGUEST");
  });

  it("leaves Google-only alerts exactly as they were without the Slack plans", () => {
    const googleOnly = heldSubjects(googlePlans);
    assert.deepEqual(
      googleOnly.map((s) => s.key),
      ["cori_lapsed:P0004"]
    );
    assert.doesNotMatch(
      heldMemberFinding(googleOnly[0]!, { names, inSlack: () => false })
        .summary,
      /@mentors/
    );
  });
});

describe("the copied groups", () => {
  it("are recognised by ID, which /hawkmod group and managed-groups refuse", () => {
    assert.ok(isSlackCopy(SLACK_GROUP_IDS["grp-students"].id));
    assert.ok(!isSlackCopy("S0BPVB142VA")); // @admins
    assert.ok(!isSlackCopy(""));
  });
});
