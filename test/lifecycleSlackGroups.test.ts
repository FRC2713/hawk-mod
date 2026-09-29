import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import {
  decideSlackCopies,
  planSlackCopies,
  SLACK_COPIES,
  SLACK_GROUP_IDS,
  type SlackCopy,
  type SlackCopyPlan,
} from "../src/domain/lifecycle/slackGroups.js";

/**
 * The Slack user groups copy the sheet by the Google rule: joining by Apply,
 * leaving only from the person's own finding, and a lead or RA flag turned
 * off as the one removal Apply makes.
 */

const AS_OF = "2026-09-28";

function mentor(
  personId: string,
  extra: {
    lead?: boolean;
    ra?: boolean;
    coriExpiry?: string | null;
    yptExpiry?: string;
  } = {}
): SheetPerson {
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
      yptExpiry: extra.yptExpiry ?? "2027-08-01",
      screeningExpiry: "2028-06-01",
      coriExpiry:
        extra.coriExpiry === undefined ? "2028-06-01" : extra.coriExpiry,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: extra.lead ?? false,
      ra: extra.ra ?? false,
    },
    student: null,
    adminRoles: [],
    parentEmails: [],
  };
}

function student(
  personId: string,
  extra: { lead?: boolean } = {}
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
      lead: extra.lead ?? false,
      slackConsentExpiry: null,
    },
    adminRoles: [],
    parentEmails: [],
  };
}

/** Every person has a Slack account `U` + their number, unless left out. */
function accounts(people: SheetPerson[], without: string[] = []) {
  return new Map(
    people
      .filter((p) => !without.includes(p.personId))
      .map((p) => [p.personId, `U${p.personId.slice(1)}`])
  );
}

const u = (personId: string) => `U${personId.slice(1)}`;

function plan(
  people: SheetPerson[],
  actual: Partial<Record<SlackCopy, string[]>>,
  without: string[] = []
): Record<SlackCopy, SlackCopyPlan> {
  const plans = planSlackCopies({
    people,
    slackIds: accounts(people, without),
    actual,
    asOf: AS_OF,
  });
  return Object.fromEntries(plans.map((p) => [p.copy, p])) as Record<
    SlackCopy,
    SlackCopyPlan
  >;
}

const ids = (ms: { personId: string | null }[]) => ms.map((m) => m.personId);

describe("planning a Slack copy: joining by Apply, leaving waits", () => {
  it("copies the five groups the design names, by handle", () => {
    assert.deepEqual(
      SLACK_COPIES.map((c) => [c, SLACK_GROUP_IDS[c].handle]),
      [
        ["grp-students", "students"],
        ["grp-mentors", "mentors"],
        ["grp-student-leads", "student-leads"],
        ["grp-mentor-leads", "mentor-leads"],
        ["grp-ra", "ra-adults"],
      ]
    );
  });

  it("adds a new student with a Slack account", () => {
    const p = plan([student("P0020"), student("P0021")], {
      "grp-students": [u("P0020")],
    });
    assert.deepEqual(ids(p["grp-students"].add), ["P0021"]);
    assert.equal(p["grp-students"].add[0]!.slackUserId, "U0021");
  });

  it("does not count someone with no Slack account as a difference", () => {
    const p = plan([student("P0020"), mentor("P0010")], {}, ["P0020", "P0010"]);
    for (const copy of SLACK_COPIES) {
      assert.deepEqual(p[copy].add, [], copy);
      assert.deepEqual(p[copy].held, [], copy);
    }
  });

  it("does not add a mentor to @mentors until their CORI is current", () => {
    const p = plan(
      [
        mentor("P0010", { coriExpiry: null }),
        mentor("P0011", { coriExpiry: "2026-09-01" }),
      ],
      {}
    );
    assert.deepEqual(p["grp-mentors"].add, []);
  });

  it("keeps a mentor already in @mentors whose CORI lapsed, for their own finding", () => {
    const p = plan(
      [mentor("P0010", { coriExpiry: "2026-09-01" }), mentor("P0011")],
      {
        "grp-mentors": [u("P0010"), u("P0011")],
      }
    );
    assert.deepEqual(p["grp-mentors"].remove, []);
    assert.deepEqual(p["grp-mentors"].held, [
      { slackUserId: "U0010", personId: "P0010", reason: "no_access" },
    ]);
  });

  it("keeps someone leaving, and never removes them on Apply", () => {
    const inactive = { ...student("P0020"), status: "inactive" as const };
    const graduate = { ...student("P0021"), roles: ["Alumni" as const] };
    const unknown = { ...student("P0022"), status: "unknown" as const };
    const p = plan([inactive, graduate, unknown, student("P0023")], {
      "grp-students": ["P0020", "P0021", "P0022", "P0023"].map(u),
    });
    assert.deepEqual(p["grp-students"].remove, []);
    assert.deepEqual(
      p["grp-students"].held.map((h) => [h.personId, h.reason]),
      [
        ["P0020", "inactive"],
        ["P0021", "role_gone"],
        ["P0022", "status_unknown"],
      ]
    );
  });

  it("keeps an account the sheet does not account for", () => {
    const p = plan([student("P0020")], {
      "grp-students": [u("P0020"), "UHANDADDED"],
    });
    assert.deepEqual(p["grp-students"].held, [
      { slackUserId: "UHANDADDED", personId: null, reason: "not_on_sheet" },
    ]);
    assert.deepEqual(p["grp-students"].remove, []);
  });

  it("keeps a student added to @mentors by hand, for their own finding", () => {
    const p = plan([student("P0020"), mentor("P0010")], {
      "grp-mentors": [u("P0010"), u("P0020")],
    });
    assert.deepEqual(p["grp-mentors"].remove, []);
    assert.deepEqual(ids(p["grp-mentors"].held), ["P0020"]);
  });

  it("puts back someone removed by hand who still belongs", () => {
    const p = plan([student("P0020"), student("P0021")], {
      "grp-students": [u("P0020")],
    });
    assert.deepEqual(ids(p["grp-students"].add), ["P0021"]);
  });

  it("never adds someone leaving who is already out", () => {
    const inactive = { ...student("P0020"), status: "inactive" as const };
    const p = plan([inactive, student("P0021")], {
      "grp-students": [u("P0021")],
    });
    assert.deepEqual(p["grp-students"].add, []);
    assert.deepEqual(p["grp-students"].held, []);
  });

  it("removes someone whose lead flag was turned off", () => {
    const people = [
      student("P0020", { lead: true }),
      student("P0021", { lead: true }),
      student("P0022", { lead: true }),
      student("P0023", { lead: true }),
      student("P0024"),
    ];
    const p = plan(people, {
      "grp-students": people.map((x) => u(x.personId)),
      "grp-student-leads": ["P0020", "P0021", "P0022", "P0023", "P0024"].map(u),
    });
    assert.deepEqual(ids(p["grp-student-leads"].remove), ["P0024"]);
    assert.deepEqual(p["grp-student-leads"].held, []);
    assert.equal(p["grp-student-leads"].refusal, null);
    // Still a student: nothing changes in @students.
    assert.deepEqual(p["grp-students"].remove, []);
  });

  it("keeps an RA whose screening lapsed, and adds a new RA only once screened", () => {
    const p = plan(
      [
        mentor("P0010", { ra: true, yptExpiry: "2026-08-01" }),
        mentor("P0011", { ra: true, yptExpiry: "2026-08-01" }),
        mentor("P0012", { ra: true }),
      ],
      { "grp-ra": [u("P0010")] }
    );
    assert.deepEqual(p["grp-ra"].remove, []);
    assert.deepEqual(p["grp-ra"].held, []);
    assert.deepEqual(ids(p["grp-ra"].add), ["P0012"]);
  });

  it("puts every lead in its role group too", () => {
    const people = [
      student("P0020", { lead: true }),
      mentor("P0010", { lead: true }),
      mentor("P0011", { lead: true, coriExpiry: null }),
    ];
    const p = plan(people, {});
    const added = (c: SlackCopy) => new Set(ids(p[c].add));
    for (const [lead, role] of [
      ["grp-student-leads", "grp-students"],
      ["grp-mentor-leads", "grp-mentors"],
    ] as const) {
      for (const id of added(lead))
        assert.ok(added(role).has(id), `${id} in ${role}`);
    }
    assert.deepEqual(ids(p["grp-mentor-leads"].add), ["P0010"]);
  });

  it("refuses flags turned off that would take more than a quarter, or empty the group", () => {
    const leads = ["P0020", "P0021", "P0022", "P0023"];
    const people = [
      student("P0020", { lead: true }),
      ...leads.slice(1).map((id) => student(id)),
    ];
    const p = plan(people, { "grp-student-leads": leads.map(u) });
    assert.match(p["grp-student-leads"].refusal ?? "", /remove 3 of 4/);

    const none = plan(
      leads.map((id) => student(id)),
      {
        "grp-student-leads": leads.map(u),
      }
    );
    assert.match(none["grp-student-leads"].refusal ?? "", /empty/);
  });

  it("never counts held members toward the refusal", () => {
    const people = ["P0020", "P0021", "P0022", "P0023"].map((id) => ({
      ...student(id),
      status: "inactive" as const,
    }));
    const p = plan([...people, student("P0024")], {
      "grp-students": ["P0020", "P0021", "P0022", "P0023", "P0024"].map(u),
    });
    assert.equal(p["grp-students"].refusal, null);
    assert.equal(p["grp-students"].held.length, 4);
  });
});

describe("deciding what Apply may do to each Slack copy", () => {
  const people = [student("P0020"), student("P0021")];
  const plans = planSlackCopies({
    people,
    slackIds: accounts(people),
    actual: { "grp-students": [u("P0020")] },
    asOf: AS_OF,
  });
  const found = { "grp-students": { id: "S0STUDENTS", handle: "students" } };

  it("applies adds to a group found by ID with the right handle", () => {
    const d = decideSlackCopies({ plans, found }).find(
      (x) => x.copy === "grp-students"
    );
    assert.equal(d?.kind, "apply");
    if (d?.kind === "apply") {
      assert.equal(d.groupId, "S0STUDENTS");
      assert.deepEqual(ids(d.add), ["P0021"]);
    }
  });

  it("never applies to an ID that leads to another handle", () => {
    const d = decideSlackCopies({
      plans,
      found: { "grp-students": { id: "S0STUDENTS", handle: "mentors" } },
      force: new Set(["grp-students"]),
    }).find((x) => x.copy === "grp-students");
    assert.equal(d?.kind === "held" && d.why, "wrong_group");
  });

  it("reports a copy with no ID, or none Slack has, as missing", () => {
    const d = decideSlackCopies({ plans, found: {} });
    for (const x of d)
      assert.equal(x.kind === "held" && x.why, "missing", x.copy);
  });

  it("holds a refused plan, and applies it only when an administrator says anyway", () => {
    const leads = ["P0020", "P0021", "P0022", "P0023"];
    const refused = planSlackCopies({
      people: leads.map((id) => student(id)),
      slackIds: accounts(leads.map((id) => student(id))),
      actual: { "grp-student-leads": leads.map(u) },
      asOf: AS_OF,
    });
    const found = {
      "grp-student-leads": { id: "S0LEADS", handle: "student-leads" },
    };
    const held = decideSlackCopies({ plans: refused, found }).find(
      (x) => x.copy === "grp-student-leads"
    );
    assert.equal(held?.kind === "held" && held.why, "refused");

    // Three of four is over the quarter; Apply anyway overrides that.
    const three = planSlackCopies({
      people: [
        student("P0020", { lead: true }),
        ...leads.slice(1).map((id) => student(id)),
      ],
      slackIds: accounts(leads.map((id) => student(id))),
      actual: { "grp-student-leads": leads.map(u) },
      asOf: AS_OF,
    });
    const anyway = decideSlackCopies({
      plans: three,
      found,
      force: new Set<SlackCopy>(["grp-student-leads"]),
    }).find((x) => x.copy === "grp-student-leads");
    assert.equal(anyway?.kind, "apply");
    if (anyway?.kind === "apply") {
      assert.deepEqual(ids(anyway.remove), ["P0021", "P0022", "P0023"]);
    }
  });

  it("does nothing to a copy that already matches", () => {
    const d = decideSlackCopies({
      plans: planSlackCopies({
        people,
        slackIds: accounts(people),
        actual: { "grp-students": [u("P0020"), u("P0021")] },
        asOf: AS_OF,
      }),
      found,
    }).find((x) => x.copy === "grp-students");
    assert.equal(d?.kind, "nothing");
  });
});
