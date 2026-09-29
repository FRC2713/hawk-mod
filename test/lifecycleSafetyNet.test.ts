import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GroupPlanResult } from "../src/domain/lifecycle/groupPlan.js";
import {
  heldMemberFinding,
  heldSubjects,
  mentorsInSlackWithoutCori,
} from "../src/domain/lifecycle/heldMembers.js";
import { formatOnboarding } from "../src/domain/lifecycle/onboardingReport.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import { unknownAccountSummary } from "../src/domain/people.js";
import {
  lifecycleAction,
  REMOVE_FROM_GROUPS_ACTION,
} from "../src/slack/alerts.js";

/**
 * Step 6's safety net: a mentor in Slack without CORI current. Slack Pro
 * cannot restrict a member, so this is an alert asking a person to act —
 * folded into the one `cori_lapsed` alert per mentor (decided 2026-09-29),
 * whether or not they are also held in a group.
 */

const AS_OF = "2026-09-29";

function person(
  personId: string,
  over: Partial<SheetPerson> & { cori?: string | null } = {}
): SheetPerson {
  const { cori = null, ...rest } = over;
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
      yptExpiry: null,
      screeningExpiry: null,
      coriExpiry: cori,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: false,
    },
    student: null,
    adminRoles: [],
    parentEmails: [],
    ...rest,
  };
}

describe("mentors in Slack without CORI current", () => {
  const inSlack = new Set([
    "P0001",
    "P0002",
    "P0003",
    "P0004",
    "P0005",
    "P0006",
    "P0007",
  ]);
  const found = mentorsInSlackWithoutCori(
    [
      person("P0001"), // never had CORI
      person("P0002", { cori: "2026-09-28" }), // lapsed yesterday
      person("P0003", { cori: "2028-06-01" }), // current
      person("P0004", { status: "inactive" }), // left: sheet_undeclared's
      person("P0005", { roles: ["Student", "Mentor"] }), // a student
      person("P0006", { roles: ["Volunteer"], mentor: null }),
      person("P0007", { status: "unknown" }),
      person("P0008"), // not in Slack
    ],
    (p) => inSlack.has(p.personId),
    AS_OF
  );

  it("are the Active mentors, and only them, whose CORI is missing or lapsed", () => {
    assert.deepEqual(found, ["P0001", "P0002"]);
  });
});

const names = new Map([
  ["P0001", "Jordan Lee"],
  ["P0002", "Sam Park"],
]);

/** P0002 is also held in grp-mentors for CORI, as the groups run holds them. */
const plans = [
  {
    group: "grp-mentors",
    held: [
      {
        address: "p0002@rhr.example",
        personIds: ["P0002"],
        reason: "no_access",
      },
    ],
  },
] as unknown as GroupPlanResult[];

describe("one cori_lapsed alert per mentor", () => {
  const subjects = heldSubjects(plans, [], ["P0001", "P0002"]);

  it("raises one for a mentor held nowhere but Slack", () => {
    const s = subjects.find((x) => x.personId === "P0001")!;
    assert.equal(s.key, "cori_lapsed:P0001");
    assert.deepEqual(s.entries, []);
    const f = heldMemberFinding(s, { names, inSlack: () => true });
    assert.equal(
      f.summary,
      "P0001 Jordan Lee does not have CORI current, and has a Slack account. " +
        "Nothing was removed. Slack Pro cannot restrict a member: an " +
        "administrator should deactivate their Slack account until a current " +
        "CORI Expiry is on the sheet, or enter it there if CORI is done."
    );
  });

  it("folds the Slack account into the alert of a mentor also held in a group", () => {
    const mine = subjects.filter((x) => x.personId === "P0002");
    assert.equal(mine.length, 1);
    const f = heldMemberFinding(mine[0]!, { names, inSlack: () => true });
    assert.equal(f.kind, "cori_lapsed");
    assert.match(
      f.summary,
      /^P0002 Sam Park does not have CORI current, and is still in grp-mentors, and has a Slack account\./
    );
    assert.match(f.summary, /They rejoin on their own/);
    assert.match(f.summary, /deactivate their Slack account/);
  });

  it("offers Remove from mentor groups only when there is a group", () => {
    const [held, slackOnly] = ["P0002", "P0001"].map((id) => {
      const f = heldMemberFinding(
        subjects.find((x) => x.personId === id)!,
        { names, inSlack: () => true }
      );
      return lifecycleAction({
        kind: f.kind,
        dedupe_key: f.dedupeKey,
        detail: JSON.stringify(f.detail),
      });
    });
    assert.equal(held?.actionId, REMOVE_FROM_GROUPS_ACTION);
    assert.equal(slackOnly, null);
  });

  it("keeps the button on an alert from before step 6, which has no such detail", () => {
    assert.equal(
      lifecycleAction({
        kind: "cori_lapsed",
        dedupe_key: "cori_lapsed:P0009",
        detail: null,
      })?.actionId,
      REMOVE_FROM_GROUPS_ACTION
    );
  });
});

describe("the onboarding dry run", () => {
  it("lists the mentors in Slack without CORI current", () => {
    const text = formatOnboarding({
      plan: { requests: [], notReady: [], directoryChecked: true },
      asOf: AS_OF,
      slackAccounts: 10,
      directory: { count: 5 },
      channel: "#onboarding (C1)",
      channelIsFallback: false,
      slackWithoutCori: ["P0001", "P0002"],
    });
    assert.match(
      text,
      /Mentors in Slack without CORI current \(each a cori_lapsed alert in the alert channel\): 2\n {2}P0001, P0002/
    );
  });
});

describe("an account nobody on the sheet matches", () => {
  it("is named, never mentioned, and says how to match it", () => {
    const text = unknownAccountSummary({
      id: "U0ABC",
      name: "jordan",
      realName: "Jordan Lee",
      email: "jordan@gmail.example",
    });
    assert.equal(
      text,
      "Slack account Jordan Lee (@jordan, jordan@gmail.example) is not " +
        "matched to anyone on the lifecycle sheet. If they are on it, type " +
        "U0ABC into their row's Slack User ID."
    );
    assert.doesNotMatch(text, /<@/);
  });
});
