import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideHelpdesk,
  HELPDESK_GROUP,
  planAdmins,
  planHelpdesk,
  type AdminAccount,
  type HelpdeskPlan,
} from "../src/domain/lifecycle/helpdesk.js";
import type { DirectoryAccount } from "../src/domain/lifecycle/onboarding.js";
import type { SheetPerson, SheetRole } from "../src/domain/lifecycle/sheet.js";

/**
 * Step 8: grp-helpdesk carries Help Desk Admin, so who can reset passwords is
 * who is in that group. The sheet decides who should be; every change is
 * Apply's, except someone leaving the team, whose own alert removes them.
 */

const AS_OF = "2026-10-02";

function mentor(
  personId: string,
  extra: {
    helpdesk?: boolean;
    coriExpiry?: string | null;
    rhrEmail?: string | null;
    status?: SheetPerson["status"];
    roles?: SheetRole[];
  } = {}
): SheetPerson {
  return {
    personId,
    name: `Mentor ${personId}`,
    personalEmail: null,
    status: extra.status ?? "active",
    roles: extra.roles ?? ["Mentor"],
    mentor: {
      row: 2,
      rhrEmail:
        extra.rhrEmail === undefined
          ? `${personId.toLowerCase()}@rhr.example`
          : extra.rhrEmail,
      slackUserId: null,
      yptExpiry: "2027-08-01",
      screeningExpiry: "2028-06-01",
      coriExpiry:
        extra.coriExpiry === undefined ? "2028-06-01" : extra.coriExpiry,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: false,
    },
    student: null,
    adminRoles: extra.helpdesk ? ["Help Desk Admin"] : [],
    parentEmails: [],
  };
}

/** A working Google account for each person's RHR Email. */
function directoryFor(
  people: SheetPerson[],
  extra: DirectoryAccount[] = []
): DirectoryAccount[] {
  return [
    ...people.flatMap((p) =>
      p.mentor?.rhrEmail
        ? [{ primaryEmail: p.mentor.rhrEmail, aliases: [], suspended: false }]
        : []
    ),
    ...extra,
  ];
}

function plan(
  people: SheetPerson[],
  members: string[] = [],
  directory = directoryFor(people)
): HelpdeskPlan {
  return planHelpdesk({ people, directory, members, asOf: AS_OF });
}

describe("planHelpdesk", () => {
  it("adds an Active Mentor with a Help Desk Admin row and CORI current, by RHR Email", () => {
    const p = plan([mentor("P0010", { helpdesk: true }), mentor("P0011")]);
    assert.deepEqual(p.add, [
      { address: "p0010@rhr.example", personId: "P0010" },
    ]);
    assert.deepEqual(p.remove, []);
  });

  it("changes nothing for someone already in the group", () => {
    const p = plan(
      [mentor("P0010", { helpdesk: true })],
      ["P0010@RHR.example"]
    );
    assert.deepEqual(p.add, []);
    assert.deepEqual(p.remove, []);
  });

  it("removes an Active Mentor whose row is gone", () => {
    const p = plan([mentor("P0010")], ["p0010@rhr.example"]);
    assert.deepEqual(p.remove, [
      { address: "p0010@rhr.example", personId: "P0010", reason: "no_row" },
    ]);
  });

  it("does not add a mentor whose CORI is not current, and says why", () => {
    const p = plan([mentor("P0010", { helpdesk: true, coriExpiry: null })]);
    assert.deepEqual(p.add, []);
    assert.deepEqual(p.waiting, [{ personId: "P0010", why: "no_access" }]);
  });

  it("removes a member whose CORI lapsed, and lists them once", () => {
    const p = plan(
      [mentor("P0010", { helpdesk: true, coriExpiry: "2026-09-01" })],
      ["p0010@rhr.example"]
    );
    assert.deepEqual(p.remove, [
      { address: "p0010@rhr.example", personId: "P0010", reason: "no_access" },
    ]);
    assert.deepEqual(p.waiting, []);
  });

  it("holds someone leaving the team for their own Remove from groups", () => {
    const people = [
      mentor("P0010", { helpdesk: true, status: "inactive" }),
      mentor("P0011", { helpdesk: true, status: "unknown" }),
      mentor("P0012", { helpdesk: true, roles: ["Volunteer"] }),
    ];
    const p = plan(people, [
      "p0010@rhr.example",
      "p0011@rhr.example",
      "p0012@rhr.example",
    ]);
    assert.deepEqual(p.remove, []);
    assert.deepEqual(
      p.held.map((h) => [h.personId, h.reason]),
      [
        ["P0010", "inactive"],
        ["P0011", "status_unknown"],
        ["P0012", "role_gone"],
      ]
    );
  });

  it("lists a Help Desk row left on someone leaving, in or out of the group", () => {
    const p = plan([
      mentor("P0010", { helpdesk: true, status: "inactive" }),
      mentor("P0011", { status: "inactive" }),
    ]);
    assert.deepEqual(p.staleRows, [{ personId: "P0010", reason: "inactive" }]);
    assert.deepEqual(p.add, []);
  });

  it("offers someone back only while their row is still there", () => {
    // Back from Inactive: removed when they left, Active again.
    const kept = plan([mentor("P0010", { helpdesk: true })]);
    assert.deepEqual(
      kept.add.map((a) => a.personId),
      ["P0010"]
    );
    const deleted = plan([mentor("P0010")]);
    assert.deepEqual(deleted.add, []);
  });

  it("removes an address that is no sheet person's", () => {
    const p = plan([mentor("P0010")], ["calendar@rhr.example"]);
    assert.deepEqual(p.remove, [
      {
        address: "calendar@rhr.example",
        personId: null,
        reason: "not_on_sheet",
      },
    ]);
    assert.deepEqual(p.held, []);
  });

  it("waits for an RHR Email that does not reach a working account", () => {
    const people = [
      mentor("P0010", { helpdesk: true, rhrEmail: null }),
      mentor("P0011", { helpdesk: true }),
      mentor("P0012", { helpdesk: true }),
      mentor("P0013", { helpdesk: true }),
    ];
    const directory: DirectoryAccount[] = [
      { primaryEmail: "p0012@rhr.example", aliases: [], suspended: true },
      {
        primaryEmail: "someone@rhr.example",
        aliases: ["p0013@rhr.example"],
        suspended: false,
      },
    ];
    const p = plan(people, [], directory);
    assert.deepEqual(p.add, []);
    assert.deepEqual(p.waiting, [
      { personId: "P0010", why: "no_rhr_email" },
      { personId: "P0011", why: "not_an_account" },
      { personId: "P0012", why: "suspended" },
      { personId: "P0013", why: "alias" },
    ]);
  });

  it("knows a member by their account's primary address when the RHR Email is an alias", () => {
    const people = [mentor("P0013", { helpdesk: true })];
    const directory: DirectoryAccount[] = [
      {
        primaryEmail: "someone@rhr.example",
        aliases: ["p0013@rhr.example"],
        suspended: false,
      },
    ];
    const p = plan(people, ["someone@rhr.example"], directory);
    assert.deepEqual(p.remove, []);
    assert.deepEqual(p.add, []);
    assert.deepEqual(p.waiting, []);
  });
});

describe("decideHelpdesk", () => {
  const toAdd = plan([mentor("P0010", { helpdesk: true })]);

  it("applies nothing to a group with no ID or that Google does not have", () => {
    const d = decideHelpdesk({ plan: toAdd, found: null });
    assert.equal(d.kind, "held");
    assert.equal(d.kind === "held" && d.why, "missing");
  });

  it("applies nothing to an ID that leads to another group", () => {
    const d = decideHelpdesk({
      plan: toAdd,
      found: { id: "abc", name: "grp-mentors" },
    });
    assert.deepEqual(d, {
      kind: "held",
      why: "wrong_group",
      message: "its ID belongs to grp-mentors, not grp-helpdesk",
    });
  });

  it("applies the plan to the right group", () => {
    const d = decideHelpdesk({
      plan: toAdd,
      found: { id: "abc", name: "grp-helpdesk" },
    });
    assert.equal(d.kind, "apply");
    assert.equal(d.kind === "apply" && d.groupId, "abc");
  });

  it("has nothing to do when the group matches", () => {
    const d = decideHelpdesk({
      plan: plan([mentor("P0010")]),
      found: { id: "abc", name: HELPDESK_GROUP.name },
    });
    assert.deepEqual(d, { kind: "nothing" });
  });

  it("may empty the group: every change is already a click", () => {
    const d = decideHelpdesk({
      plan: plan([mentor("P0010")], ["p0010@rhr.example"]),
      found: { id: "abc", name: "grp-helpdesk" },
    });
    assert.equal(d.kind, "apply");
  });
});

describe("planAdmins", () => {
  const ACTOR = "hawk-mod@rhr.example";

  function account(
    primaryEmail: string,
    flags: Partial<Pick<AdminAccount, "superAdmin" | "delegatedAdmin">> = {},
    suspended = false
  ): AdminAccount {
    return {
      primaryEmail,
      aliases: [],
      suspended,
      superAdmin: flags.superAdmin ?? false,
      delegatedAdmin: flags.delegatedAdmin ?? false,
    };
  }

  it("lists every Super Admin, suspended ones marked, with whose they are", () => {
    const r = planAdmins({
      people: [mentor("P0006")],
      directory: [
        account("p0006@rhr.example", { superAdmin: true }),
        account("old@rhr.example", { superAdmin: true }, true),
        account("p0010@rhr.example"),
      ],
      members: [],
      actor: ACTOR,
    });
    assert.deepEqual(r.superAdmins, [
      { account: "old@rhr.example", suspended: true, personId: null },
      { account: "p0006@rhr.example", suspended: false, personId: "P0006" },
    ]);
  });

  it("reports a delegated admin grp-helpdesk does not explain, never hawk-mod@", () => {
    const r = planAdmins({
      people: [mentor("P0010"), mentor("P0011")],
      directory: [
        account(ACTOR, { delegatedAdmin: true }),
        account("p0010@rhr.example", { delegatedAdmin: true }),
        account("p0011@rhr.example", { delegatedAdmin: true }),
      ],
      members: ["p0010@rhr.example"],
      actor: ACTOR,
    });
    assert.deepEqual(r.unexpected, [
      { account: "p0011@rhr.example", suspended: false, personId: "P0011" },
    ]);
  });

  it("tells nothing apart when grp-helpdesk could not be read", () => {
    const r = planAdmins({
      people: [],
      directory: [account("p0010@rhr.example", { delegatedAdmin: true })],
      members: null,
      actor: ACTOR,
    });
    assert.equal(r.unexpected, null);
    assert.equal(r.unflagged, null);
  });

  it("lists members Google does not flag as an admin", () => {
    const r = planAdmins({
      people: [],
      directory: [
        account("p0010@rhr.example"),
        account("p0011@rhr.example", { delegatedAdmin: true }),
        account("p0006@rhr.example", { superAdmin: true }),
      ],
      members: ["P0010@rhr.example", "p0011@rhr.example", "p0006@rhr.example"],
      actor: ACTOR,
    });
    assert.deepEqual(r.unflagged, ["p0010@rhr.example"]);
  });
});
