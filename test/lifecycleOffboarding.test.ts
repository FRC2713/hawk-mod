import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GOOGLE_GROUP_IDS } from "../src/domain/lifecycle/groups.js";
import type { OnboardingSlackAccount } from "../src/domain/lifecycle/onboarding.js";
import {
  planOffboarding,
  type DomainGroup,
  type OffboardingAccount,
  type RosterEntry,
} from "../src/domain/lifecycle/offboarding.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";

/**
 * Step 7 (capability I): what is left behind when someone leaves — an active
 * Google account, a live Slack account, a place in a group the sheet does not
 * compute — for a person to take away with a click. The planner takes
 * nothing away; these tests pin down who counts as leaving, and which of
 * their addresses.
 */

type Extra = {
  status?: SheetPerson["status"];
  roles?: SheetPerson["roles"];
  rhrEmail?: string | null;
  schoolEmail?: string | null;
  slackUserId?: string | null;
  coriExpiry?: string | null;
  parentEmails?: string[];
};

function mentor(personId: string, extra: Extra = {}): SheetPerson {
  const id = personId.toLowerCase();
  return {
    personId,
    name: `Mentor ${personId}`,
    personalEmail: `${id}@personal.example`,
    status: extra.status ?? "active",
    roles: extra.roles ?? ["Mentor"],
    mentor: {
      row: 2,
      rhrEmail:
        extra.rhrEmail === undefined ? `${id}@rhr.example` : extra.rhrEmail,
      slackUserId: extra.slackUserId ?? null,
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
    adminRoles: [],
    parentEmails: extra.parentEmails ?? [],
  };
}

function student(personId: string, extra: Extra = {}): SheetPerson {
  const id = personId.toLowerCase();
  return {
    personId,
    name: `Student ${personId}`,
    personalEmail: `${id}@personal.example`,
    status: extra.status ?? "active",
    roles: extra.roles ?? ["Student"],
    mentor: null,
    student: {
      row: 2,
      schoolEmail:
        extra.schoolEmail === undefined
          ? `${id}@school.example`
          : extra.schoolEmail,
      slackUserId: extra.slackUserId ?? null,
      lead: false,
      slackConsentExpiry: "2027-08-01",
    },
    adminRoles: [],
    parentEmails: extra.parentEmails ?? [],
  };
}

function volunteer(personId: string, extra: Extra = {}): SheetPerson {
  return {
    personId,
    name: `Volunteer ${personId}`,
    personalEmail: `${personId.toLowerCase()}@personal.example`,
    status: extra.status ?? "active",
    roles: extra.roles ?? ["Volunteer"],
    mentor: null,
    student: null,
    adminRoles: [],
    parentEmails: [],
  };
}

function account(
  primaryEmail: string,
  extra: Partial<OffboardingAccount> = {}
): OffboardingAccount {
  return {
    primaryEmail,
    aliases: [],
    suspended: false,
    admin: false,
    ...extra,
  };
}

function slack(
  id: string,
  email: string | null,
  deactivated = false
): OnboardingSlackAccount {
  return { id, email, deactivated };
}

function group(
  name: string,
  members: [string, DomainGroup["members"][number]["role"]?][]
): DomainGroup {
  return {
    id: `id-${name}`,
    name,
    members: members.map(([address, role]) => ({
      address,
      role: role ?? "MEMBER",
    })),
  };
}

function plan(args: {
  people: SheetPerson[];
  roster?: RosterEntry[];
  slackAccounts?: OnboardingSlackAccount[];
  directory?: OffboardingAccount[] | null;
  groups?: DomainGroup[] | null;
}) {
  return planOffboarding({
    roster: [],
    slackAccounts: [],
    directory: [],
    groups: [],
    ...args,
  });
}

describe("offboarding: who is leaving", () => {
  it("leaves out everyone the sheet still declares", () => {
    const p = plan({
      people: [mentor("P0001"), student("P0002"), volunteer("P0003")],
      directory: [account("p0001@rhr.example")],
      slackAccounts: [
        slack("U1", "p0001@rhr.example"),
        slack("U2", "p0002@school.example"),
      ],
      groups: [
        group("grp-orders", [
          ["p0001@rhr.example"],
          ["p0003@personal.example"],
        ]),
      ],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("an Inactive mentor leaves behind their Google account, Slack account and groups", () => {
    const p = plan({
      people: [mentor("P0001", { status: "inactive", slackUserId: "U1" })],
      directory: [account("p0001@rhr.example")],
      slackAccounts: [slack("U1", "p0001@rhr.example")],
      groups: [group("grp-orders", [["p0001@rhr.example", "OWNER"]])],
    });
    assert.deepEqual(p.leavers, [
      {
        personId: "P0001",
        name: "Mentor P0001",
        reason: { kind: "inactive" },
        google: { account: "p0001@rhr.example", admin: false },
        slack: { slackUserId: "U1" },
        groups: [
          {
            groupId: "id-grp-orders",
            groupName: "grp-orders",
            address: "p0001@rhr.example",
            role: "OWNER",
          },
        ],
      },
    ]);
  });

  it("a blank or unknown Active/Inactive is read as leaving, as the groups read it", () => {
    const p = plan({
      people: [mentor("P0001", { status: "unknown" })],
      directory: [account("p0001@rhr.example")],
    });
    assert.deepEqual(p.leavers[0]?.reason, { kind: "status_unknown" });
    assert.ok(p.leavers[0]?.google);
  });

  it("a mentor who is now only a Volunteer leaves their RHR account behind", () => {
    const p = plan({
      people: [mentor("P0001", { roles: ["Volunteer"] })],
      directory: [account("p0001@rhr.example")],
    });
    assert.deepEqual(p.leavers[0]?.reason, {
      kind: "role",
      roles: ["Volunteer"],
    });
    assert.equal(p.leavers[0]?.google?.account, "p0001@rhr.example");
  });

  it("a lapsed CORI is not leaving: that is cori_lapsed's, and suspends nothing", () => {
    const p = plan({
      people: [
        mentor("P0001", { coriExpiry: "2020-01-01", slackUserId: "U1" }),
      ],
      directory: [account("p0001@rhr.example")],
      slackAccounts: [slack("U1", "p0001@rhr.example")],
      groups: [group("grp-orders", [["p0001@rhr.example"]])],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("someone leaving with nothing left behind is not listed", () => {
    const p = plan({
      people: [mentor("P0001", { status: "inactive" })],
      directory: [account("p0001@rhr.example", { suspended: true })],
      slackAccounts: [slack("U1", "p0001@rhr.example", true)],
    });
    assert.deepEqual(p.leavers, []);
  });
});

describe("offboarding: Google accounts", () => {
  it("a student has no Google account to suspend", () => {
    const p = plan({
      people: [student("P0002", { status: "inactive" })],
      directory: [account("p0001@rhr.example")],
      groups: [group("grp-orders", [["p0002@school.example"]])],
    });
    assert.equal(p.leavers[0]?.google, null);
    assert.equal(p.leavers[0]?.groups.length, 1);
  });

  it("an account holding an admin role is named, marked, and left to a Super Admin", () => {
    const p = plan({
      people: [mentor("P0001", { status: "inactive" })],
      directory: [account("p0001@rhr.example", { admin: true })],
    });
    assert.deepEqual(p.leavers[0]?.google, {
      account: "p0001@rhr.example",
      admin: true,
    });
  });

  it("finds the account behind an alias, and names its primary address", () => {
    const p = plan({
      people: [mentor("P0001", { status: "inactive" })],
      directory: [
        account("first.last@rhr.example", { aliases: ["p0001@rhr.example"] }),
      ],
    });
    assert.equal(p.leavers[0]?.google?.account, "first.last@rhr.example");
  });

  it("compares addresses lower-cased", () => {
    const p = plan({
      people: [
        mentor("P0001", { status: "inactive", rhrEmail: "Pat@RHR.example" }),
      ],
      directory: [account("pat@rhr.example")],
    });
    assert.equal(p.leavers[0]?.google?.account, "pat@rhr.example");
  });

  it("never suspends an address an Active mentor still uses", () => {
    // Two rows with one RHR Email is a sheet problem, not a reason to lock
    // out the person who is using it.
    const p = plan({
      people: [
        mentor("P0001", { status: "inactive", rhrEmail: "shared@rhr.example" }),
        mentor("P0002", { rhrEmail: "shared@rhr.example" }),
      ],
      directory: [account("shared@rhr.example")],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("says Google was not read, and suspends nobody, when the directory is null", () => {
    const p = plan({
      people: [mentor("P0001", { status: "inactive", slackUserId: "U1" })],
      slackAccounts: [slack("U1", null)],
      directory: null,
    });
    assert.equal(p.directoryChecked, false);
    assert.equal(p.leavers[0]?.google, null);
    assert.deepEqual(p.leavers[0]?.slack, { slackUserId: "U1" });
  });
});

describe("offboarding: Slack accounts", () => {
  it("finds a leaver's live Slack account by their Slack User ID or their address", () => {
    const p = plan({
      people: [
        mentor("P0001", { status: "inactive", slackUserId: "U1" }),
        student("P0002", { status: "inactive" }),
      ],
      slackAccounts: [slack("U1", null), slack("U2", "p0002@school.example")],
    });
    assert.deepEqual(
      p.leavers.map((l) => [l.personId, l.slack?.slackUserId]),
      [
        ["P0001", "U1"],
        ["P0002", "U2"],
      ]
    );
  });

  it("a graduate who is now Active Alumni should leave Slack", () => {
    const p = plan({
      people: [student("P0002", { roles: ["Alumni"], slackUserId: "U2" })],
      slackAccounts: [slack("U2", "p0002@school.example")],
    });
    assert.deepEqual(p.leavers[0]?.reason, {
      kind: "role",
      roles: ["Alumni"],
    });
    assert.deepEqual(p.leavers[0]?.slack, { slackUserId: "U2" });
  });

  it("an Active mentor without CORI keeps their Slack account here: cori_lapsed asks about it", () => {
    const p = plan({
      people: [mentor("P0001", { coriExpiry: null, slackUserId: "U1" })],
      slackAccounts: [slack("U1", "p0001@rhr.example")],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("never names a Slack account someone who belongs in Slack is using", () => {
    // A stale Slack User ID on a leaver's row that now belongs to an Active
    // student is the student's account.
    const p = plan({
      people: [
        mentor("P0001", { status: "inactive", slackUserId: "U9" }),
        student("P0002", { slackUserId: "U9" }),
      ],
      slackAccounts: [slack("U9", null)],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("a former student now an Active mentor keeps the Slack account under their School Email", () => {
    // The School Email is left behind, but the Slack account it matches is
    // the one they use: someone who belongs in Slack is never asked about.
    const former: SheetPerson = {
      ...mentor("P0004"),
      student: {
        row: 3,
        schoolEmail: "p0004@school.example",
        slackUserId: null,
        lead: false,
        slackConsentExpiry: null,
      },
    };
    const p = plan({
      people: [former],
      slackAccounts: [slack("U4", "p0004@school.example")],
      groups: [group("grp-orders", [["p0004@school.example"]])],
    });
    assert.deepEqual(
      p.leavers.map((l) => [l.slack, l.groups.map((g) => g.address)]),
      [[null, ["p0004@school.example"]]]
    );
  });
});

describe("offboarding: groups the sheet does not compute", () => {
  it("lists every untracked group, with the role held there, and never a tracked one", () => {
    const tracked: DomainGroup = {
      id: GOOGLE_GROUP_IDS["grp-mentors"],
      name: "grp-mentors",
      members: [{ address: "p0001@rhr.example", role: "MEMBER" }],
    };
    const p = plan({
      people: [mentor("P0001", { status: "inactive" })],
      directory: null,
      groups: [
        tracked,
        group("grp-orders", [["p0001@rhr.example", "MANAGER"]]),
        group("grp-grants", [["P0001@RHR.example"]]),
        group("grp-contact", [["someone@else.example"]]),
      ],
    });
    assert.deepEqual(
      p.leavers[0]?.groups.map((g) => [g.groupName, g.role]),
      [
        ["grp-grants", "MEMBER"],
        ["grp-orders", "MANAGER"],
      ]
    );
  });

  it("a graduate now Active Alumni leaves their School Email behind and keeps their Personal Email", () => {
    const p = plan({
      people: [student("P0002", { roles: ["Alumni"] })],
      groups: [
        group("grp-orders", [
          ["p0002@school.example"],
          ["p0002@personal.example"],
        ]),
      ],
    });
    assert.deepEqual(
      p.leavers[0]?.groups.map((g) => g.address),
      ["p0002@school.example"]
    );
  });

  it("an Inactive volunteer leaves their Personal Email behind", () => {
    const p = plan({
      people: [volunteer("P0003", { status: "inactive" })],
      groups: [group("grp-orders", [["p0003@personal.example"]])],
    });
    assert.deepEqual(
      p.leavers[0]?.groups.map((g) => g.address),
      ["p0003@personal.example"]
    );
  });

  it("never looks for a mentor's or a student's Personal Email", () => {
    const p = plan({
      people: [
        mentor("P0001", { status: "inactive", rhrEmail: null }),
        student("P0002", { status: "inactive", schoolEmail: null }),
      ],
      groups: [
        group("grp-orders", [
          ["p0001@personal.example"],
          ["p0002@personal.example"],
        ]),
      ],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("a parent address an Active student lists is never left behind", () => {
    // An Inactive volunteer who is also an Active student's parent, at the
    // same address: that address is still in use.
    const p = plan({
      people: [
        volunteer("P0003", { status: "inactive" }),
        student("P0002", { parentEmails: ["p0003@personal.example"] }),
      ],
      groups: [group("grp-orders", [["p0003@personal.example"]])],
    });
    assert.deepEqual(p.leavers, []);
  });

  it("says the groups were not read when they could not be", () => {
    const p = plan({
      people: [mentor("P0001", { status: "inactive" })],
      directory: [account("p0001@rhr.example")],
      groups: null,
    });
    assert.equal(p.groupsChecked, false);
    assert.deepEqual(p.leavers[0]?.groups, []);
  });
});

describe("offboarding: rows gone from the sheet", () => {
  it("uses hawk-mod's roster for someone whose Person ID is gone", () => {
    const p = plan({
      people: [mentor("P0001")],
      roster: [
        {
          personId: "P0001",
          name: "Mentor P0001",
          email: "p0001@rhr.example",
          slackUserId: "U1",
        },
        {
          personId: "P0009",
          name: "Gone P0009",
          email: "p0009@rhr.example",
          slackUserId: "U9",
        },
      ],
      directory: [account("p0001@rhr.example"), account("p0009@rhr.example")],
      slackAccounts: [slack("U1", null), slack("U9", null)],
      groups: [group("grp-orders", [["p0009@rhr.example"]])],
    });
    assert.deepEqual(p.leavers, [
      {
        personId: "P0009",
        name: "Gone P0009",
        reason: { kind: "gone" },
        google: { account: "p0009@rhr.example", admin: false },
        slack: { slackUserId: "U9" },
        groups: [
          {
            groupId: "id-grp-orders",
            groupName: "grp-orders",
            address: "p0009@rhr.example",
            role: "MEMBER",
          },
        ],
      },
    ]);
  });

  it("a gone row whose address someone on the sheet now uses leaves nothing behind", () => {
    const p = plan({
      people: [mentor("P0001")],
      roster: [
        {
          personId: "P0009",
          name: "Gone P0009",
          email: "p0001@rhr.example",
          slackUserId: null,
        },
      ],
      directory: [account("p0001@rhr.example")],
    });
    assert.deepEqual(p.leavers, []);
  });
});
