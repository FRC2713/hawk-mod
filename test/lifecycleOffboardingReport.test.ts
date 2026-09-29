import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JWT } from "google-auth-library";
import {
  listDomainGroups,
  pageMembersWithRoles,
} from "../src/google/directory.js";
import { GOOGLE_GROUP_IDS } from "../src/domain/lifecycle/groups.js";
import {
  isTrackedGroup,
  type OffboardingPlan,
} from "../src/domain/lifecycle/offboarding.js";
import { formatOffboarding } from "../src/domain/lifecycle/offboardingReport.js";

/**
 * Step 7, part 2: reading every group in the Workspace as hawk-mod@, and the
 * `/hawkmod lifecycle offboarding` dry run. The dry run can be posted in any
 * channel, so it names Person IDs and group names and never an address.
 */

/** A stand-in for Google: answers each request from a list, in order. */
function fakeGoogle(answers: (object | Error)[]): JWT & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    request: async ({ url }: { url: string }) => {
      urls.push(url);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { data: next };
    },
  } as unknown as JWT & { urls: string[] };
}

function googleError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("reading every group in the Workspace", () => {
  it("keeps each member's role, lower-cases addresses, and drops blanks", () => {
    assert.deepEqual(
      pageMembersWithRoles({
        members: [
          { email: "Pat@RHR.example", role: "OWNER" },
          { email: "sam@rhr.example", role: "MANAGER" },
          { email: "kid@school.example", role: "MEMBER" },
          { email: "odd@rhr.example" },
          // A whole-domain member has no address.
          { role: "MEMBER" },
        ],
      }),
      [
        { address: "pat@rhr.example", role: "OWNER" },
        { address: "sam@rhr.example", role: "MANAGER" },
        { address: "kid@school.example", role: "MEMBER" },
        { address: "odd@rhr.example", role: "MEMBER" },
      ]
    );
  });

  it("lists every group, reads every page of each, and asks for nothing but addresses and roles", async () => {
    const google = fakeGoogle([
      { groups: [{ id: "g1", name: "grp-orders" }], nextPageToken: "gp2" },
      { groups: [{ id: "g2", name: "grp-grants" }] },
      {
        members: [{ email: "a@rhr.example", role: "OWNER" }],
        nextPageToken: "mp2",
      },
      { members: [{ email: "b@rhr.example" }] },
      { members: [] },
    ]);
    const groups = await listDomainGroups(google);
    assert.deepEqual(groups, [
      {
        id: "g1",
        name: "grp-orders",
        members: [
          { address: "a@rhr.example", role: "OWNER" },
          { address: "b@rhr.example", role: "MEMBER" },
        ],
      },
      { id: "g2", name: "grp-grants", members: [] },
    ]);
    const list = new URL(google.urls[0]!);
    assert.equal(list.searchParams.get("customer"), "my_customer");
    assert.equal(
      list.searchParams.get("fields"),
      "groups(id,name),nextPageToken"
    );
    assert.match(google.urls[1]!, /pageToken=gp2/);
    assert.equal(
      new URL(google.urls[2]!).searchParams.get("fields"),
      "members(email,role),nextPageToken"
    );
    assert.match(google.urls[3]!, /groups\/g1\/members.*pageToken=mp2/);
  });

  it("skips a group deleted between the list and its members", async () => {
    const google = fakeGoogle([
      {
        groups: [
          { id: "g1", name: "grp-old" },
          { id: "g2", name: "grp-grants" },
        ],
      },
      googleError(404, "Resource Not Found: groupKey"),
      { members: [{ email: "b@rhr.example" }] },
    ]);
    const groups = await listDomainGroups(google);
    assert.deepEqual(
      groups.map((g) => g.name),
      ["grp-grants"]
    );
  });

  it("names the missing role privilege on a 403", async () => {
    const google = fakeGoogle([googleError(403, "Not Authorized")]);
    await assert.rejects(listDomainGroups(google), /Groups → Read/);
  });

  it("knows the nine groups the sheet computes by ID", () => {
    assert.equal(isTrackedGroup(GOOGLE_GROUP_IDS["grp-mentors"]), true);
    assert.equal(isTrackedGroup("some-other-id"), false);
  });
});

const PLAN: OffboardingPlan = {
  directoryChecked: true,
  groupsChecked: true,
  leavers: [
    {
      personId: "P0012",
      name: "Pat Mentor",
      reason: { kind: "inactive" },
      google: { account: "pat@rhr.example", admin: false },
      slack: { slackUserId: "U12" },
      groups: [
        {
          groupId: "g1",
          groupName: "grp-orders",
          address: "pat@rhr.example",
          role: "OWNER",
        },
      ],
    },
    {
      personId: "P0013",
      name: "Robin Helpdesk",
      reason: { kind: "role", roles: ["Volunteer"] },
      google: { account: "robin@rhr.example", admin: true },
      slack: null,
      groups: [],
    },
    {
      personId: "P0040",
      name: "Kid Graduate",
      reason: { kind: "role", roles: ["Alumni"] },
      google: null,
      slack: { slackUserId: "U40" },
      groups: [
        {
          groupId: "g2",
          groupName: "grp-grants",
          address: "kid@school.example",
          role: "MEMBER",
        },
      ],
    },
    {
      personId: "P0050",
      name: "Gone Person",
      reason: { kind: "gone" },
      google: null,
      slack: { slackUserId: "U50" },
      groups: [],
    },
  ],
};

function report(overrides: Partial<Parameters<typeof formatOffboarding>[0]>) {
  return formatOffboarding({
    plan: PLAN,
    asOf: "2026-09-29",
    slackAccounts: 294,
    directory: { count: 22, admins: 5 },
    groups: {
      total: 13,
      untracked: [
        {
          id: "g1",
          name: "grp-orders",
          members: [{ address: "pat@rhr.example", role: "OWNER" }],
        },
        { id: "g2", name: "grp-grants", members: [] },
      ],
    },
    ...overrides,
  });
}

describe("the offboarding dry run", () => {
  it("lists each thing left behind by Person ID and reason", () => {
    const text = report({});
    assert.match(text, /dry run: nothing posted, nothing changed/);
    assert.match(text, /Google accounts to suspend: 2\n {2}P0012: Inactive\n/);
    assert.match(
      text,
      /P0013: now Volunteer — holds a Google admin role, so a Super Admin must remove it/
    );
    assert.match(
      text,
      /Slack accounts to deactivate \(by hand\): 3\n {2}P0012: Inactive\n {2}P0040: now Alumni\n {2}P0050: Person ID no longer on the sheet/
    );
    assert.match(
      text,
      /Still in groups the sheet does not compute: 2\n {2}P0012 \(Inactive\): grp-orders \(owner\)\n {2}P0040 \(now Alumni\): grp-grants/
    );
  });

  it("lists the untracked groups it read, and the counts", () => {
    const text = report({});
    assert.match(
      text,
      /Groups the sheet does not compute: 2 of the 13 in the Workspace\n {2}grp-grants \(g2\): 0 member\(s\)\n {2}grp-orders \(g1\): 1 member\(s\)/
    );
    assert.match(
      text,
      /Read 22 Google accounts \(5 hold an admin role\) and 294 Slack accounts\./
    );
  });

  it("never prints a name or an address", () => {
    const text = report({});
    for (const l of PLAN.leavers) assert.ok(!text.includes(l.name), l.name);
    assert.doesNotMatch(text, /@/);
  });

  it("says what it could not check, rather than reading it as nothing", () => {
    const text = report({
      plan: { ...PLAN, directoryChecked: false, groupsChecked: false },
      directory: { error: "Google refused to list user accounts." },
      groups: { error: "Google refused to read the list of groups." },
    });
    assert.match(
      text,
      /Google accounts: NOT checked\. .*\n {2}Google refused to list user accounts\./
    );
    assert.match(
      text,
      /Other groups: NOT checked\. .*\n {2}Google refused to read the list of groups\./
    );
    assert.doesNotMatch(text, /Google accounts to suspend/);
    assert.match(text, /Read 294 Slack accounts\./);
  });
});
