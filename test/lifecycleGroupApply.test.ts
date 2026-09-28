import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideGroups,
  heldFinding,
  raAnnouncement,
  type GroupDecision,
} from "../src/domain/lifecycle/groupApply.js";
import {
  planGoogleGroups,
  type GroupPlanResult,
} from "../src/domain/lifecycle/groupPlan.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import { googleReason } from "../src/google/directory.js";
import {
  applyGroupDecisions,
  type GroupChange,
} from "../src/lifecycle/applyGroups.js";
import { APPLY_ANYWAY_ACTION, lifecycleAction } from "../src/slack/alerts.js";

/**
 * What a groups apply may touch. Joining is automatic; leaving waits for a
 * click; a refused plan waits for Apply anyway; a wrong or missing group is
 * never touched.
 */

const AS_OF = "2026-09-28";

function mentor(personId: string, extra: { ra?: boolean } = {}): SheetPerson {
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
      coriExpiry: "2028-06-01",
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: extra.ra ?? false,
    },
    student: null,
    adminRoles: [],
    parentEmails: [],
  };
}

const found = (group: string, name = group) => ({
  id: `0${group.replace(/\W/g, "").slice(0, 14).padEnd(14, "x")}`,
  name,
  email: `${group}@team.example`,
  count: 0,
});

const addr = (id: string) => `${id.toLowerCase()}@rhr.example`;

// grp-ra: four members, three with the RA flag turned off, one new RA.
const people = [
  mentor("P0010", { ra: true }),
  mentor("P0011"),
  mentor("P0012"),
  mentor("P0013"),
  mentor("P0014", { ra: true }),
  { ...mentor("P0015"), status: "inactive" as const },
];
const plans = planGoogleGroups({
  people,
  actual: {
    "grp-ra": ["P0010", "P0011", "P0012", "P0013"].map(addr),
    "grp-mentors": ["P0010", "P0015"].map(addr),
  },
  asOf: AS_OF,
});
const only = (group: string) =>
  plans.filter((p): p is GroupPlanResult => p.group === group);

describe("deciding what a groups run may apply", () => {
  it("holds a refused plan", () => {
    const [d] = decideGroups({
      plans: only("grp-ra"),
      found: { "grp-ra": found("grp-ra") },
      missing: {},
    });
    assert.equal(d?.kind, "held");
    assert.equal(d?.kind === "held" && d.why, "refused");
  });

  it("applies a refused plan when an administrator says Apply anyway", () => {
    const [d] = decideGroups({
      plans: only("grp-ra"),
      found: { "grp-ra": found("grp-ra") },
      missing: {},
      force: new Set(["grp-ra"]),
    });
    assert.equal(d?.kind, "apply");
    if (d?.kind !== "apply") return;
    assert.deepEqual(
      d.add.map((m) => m.address),
      [addr("P0014")]
    );
    assert.deepEqual(
      d.remove.map((m) => m.address),
      ["P0011", "P0012", "P0013"].map(addr)
    );
  });

  it("never applies to a group whose ID leads to another group, even anyway", () => {
    const [d] = decideGroups({
      plans: only("grp-ra"),
      found: { "grp-ra": found("grp-ra", "grp-parents") },
      missing: {},
      force: new Set(["grp-ra"]),
    });
    assert.equal(d?.kind === "held" && d.why, "wrong_group");
  });

  it("never applies to a group it could not find", () => {
    const [d] = decideGroups({
      plans: only("grp-mentors"),
      found: {},
      missing: { "grp-mentors": { id: "04anzqyu2b5mt66" } },
    });
    assert.equal(d?.kind === "held" && d.why, "missing");
  });

  it("applies joins and never removes someone leaving", () => {
    const [d] = decideGroups({
      plans: only("grp-mentors"),
      found: { "grp-mentors": found("grp-mentors") },
      missing: {},
    });
    assert.equal(d?.kind, "apply");
    if (d?.kind !== "apply") return;
    // P0015 is Inactive and in the group: held, so not in `remove`.
    assert.deepEqual(d.remove, []);
    assert.ok(d.add.some((m) => m.address === addr("P0011")));
  });
});

describe("applying", () => {
  const decisions: GroupDecision[] = [
    {
      group: "grp-mentors",
      kind: "apply",
      groupId: "0abc",
      name: "grp-mentors",
      add: [
        { address: "a@rhr.example", personIds: ["P0001"] },
        { address: "bad@rhr.example", personIds: ["P0002"] },
        { address: "c@rhr.example", personIds: ["P0003"] },
      ],
      remove: [{ address: "d@rhr.example", personIds: ["P0004"] }],
    },
    { group: "grp-ra", kind: "held", why: "refused", message: "too many" },
  ];

  it("makes each change, records it, and carries on past a failure", async () => {
    const calls: string[] = [];
    const recorded: GroupChange[] = [];
    const result = await applyGroupDecisions(
      decisions,
      {
        add: async (_id, email) => {
          if (email.startsWith("bad")) throw new Error("Member not allowed");
          calls.push(`add ${email}`);
        },
        remove: async (_id, email) => {
          calls.push(`remove ${email}`);
        },
      },
      (c) => recorded.push(c)
    );
    assert.deepEqual(calls, [
      "add a@rhr.example",
      "add c@rhr.example",
      "remove d@rhr.example",
    ]);
    assert.equal(recorded.length, 3);
    assert.deepEqual(
      result.failed.map((f) => [f.member.personIds[0], f.reason]),
      [["P0002", "Member not allowed"]]
    );
  });

  it("touches nothing in a held group", async () => {
    const touched: string[] = [];
    await applyGroupDecisions(
      [decisions[1]!],
      {
        add: async (id) => void touched.push(id),
        remove: async (id) => void touched.push(id),
      },
      () => {}
    );
    assert.deepEqual(touched, []);
  });
});

describe("what people are told", () => {
  it("announces every grp-ra change by name", () => {
    const text = raAnnouncement(
      [
        {
          action: "add",
          member: { address: "x@rhr.example", personIds: ["P0014"] },
        },
        {
          action: "remove",
          member: { address: "y@rhr.example", personIds: ["P0011"] },
        },
      ],
      new Map([
        ["P0014", "Jordan Lee"],
        ["P0011", "Sam Park"],
      ])
    );
    assert.match(text, /grp-ra can edit the lifecycle sheet/);
    assert.match(text, /Added: P0014 Jordan Lee/);
    assert.match(text, /Removed: P0011 Sam Park/);
    assert.ok(!text.includes("@rhr.example"));
  });

  it("offers Apply anyway on a refusal, and on nothing else", () => {
    const refusal = heldFinding({
      group: "grp-ra",
      kind: "held",
      why: "refused",
      message: "too many",
    });
    const wrong = heldFinding({
      group: "grp-ra",
      kind: "held",
      why: "wrong_group",
      message: "wrong",
    });
    assert.equal(
      lifecycleAction({ kind: refusal.kind, dedupe_key: refusal.dedupeKey })
        ?.actionId,
      APPLY_ANYWAY_ACTION
    );
    assert.equal(
      lifecycleAction({ kind: wrong.kind, dedupe_key: wrong.dedupeKey }),
      null
    );
  });

  it("blanks any address in Google's reason, which can reach Slack", () => {
    const reason = googleReason({
      response: {
        data: { error: { message: "Member kid@home.example is not allowed" } },
      },
    });
    assert.equal(reason, "Member <address> is not allowed");
  });
});
