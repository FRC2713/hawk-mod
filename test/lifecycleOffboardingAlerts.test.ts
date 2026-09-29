import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JWT } from "google-auth-library";
import {
  checkSuspendDelegation,
  setSuspended,
} from "../src/google/directory.js";
import {
  heldMemberFinding,
  heldSubjects,
} from "../src/domain/lifecycle/heldMembers.js";
import type { Leaver } from "../src/domain/lifecycle/offboarding.js";
import {
  groupOutsiderFindings,
  offboardingAccountsFinding,
  offersSuspend,
  unknownGoogleAccountFinding,
} from "../src/domain/lifecycle/offboardingFindings.js";
import { formatOffboarding } from "../src/domain/lifecycle/offboardingReport.js";
import {
  lifecycleAction,
  REMOVE_FROM_GROUPS_ACTION,
  RESTORE_GOOGLE_ACTION,
  SUSPEND_GOOGLE_ACTION,
} from "../src/slack/alerts.js";

/**
 * Step 7, part 4: the alerts and buttons. Suspend is offered only for an
 * account hawk-mod@ may suspend; Restore only on a suspended account's
 * request; Remove from groups now reaches the groups the sheet does not
 * compute. Summaries never carry a student's address — `/hawkmod findings`
 * and the morning report print them wherever they are run.
 */

const SLACK_ADMIN = "https://frc2713.slack.com/admin";

function leaver(extra: Partial<Leaver> = {}): Leaver {
  return {
    personId: "P0012",
    name: "Pat Mentor",
    reason: { kind: "inactive" },
    google: { account: "pat@rhr.example", admin: false },
    slack: { slackUserId: "U12" },
    groups: [],
    ...extra,
  };
}

function finding(
  f: NonNullable<ReturnType<typeof offboardingAccountsFinding>>
) {
  return {
    kind: f.kind,
    dedupe_key: f.dedupeKey,
    detail: JSON.stringify(f.detail),
  };
}

describe("the accounts alert", () => {
  it("offers Suspend for an active account, and asks for Slack by hand", () => {
    const f = offboardingAccountsFinding(leaver(), SLACK_ADMIN)!;
    assert.equal(f.kind, "offboarding_accounts");
    assert.equal(f.dedupeKey, "offboarding_accounts:P0012");
    assert.equal(
      f.summary,
      "P0012 Pat Mentor is Inactive on the lifecycle sheet, and still has an " +
        "active Google account (pat@rhr.example) and a live Slack account. " +
        "Suspend Google account suspends it — it is never deleted, and can be " +
        "restored if they come back. Slack Pro gives hawk-mod no way to " +
        "deactivate anyone: an admin deactivates their account in Slack's " +
        "Manage members page (<https://frc2713.slack.com/admin|frc2713.slack.com/admin>). " +
        "Nothing was changed."
    );
    assert.equal(offersSuspend(JSON.stringify(f.detail)), true);
    assert.equal(lifecycleAction(finding(f))?.actionId, SUSPEND_GOOGLE_ACTION);
    assert.equal(lifecycleAction(finding(f))?.label, "Suspend Google account");
  });

  it("offers no Suspend for an account holding an admin role, and says who can", () => {
    const f = offboardingAccountsFinding(
      leaver({
        google: { account: "pat@rhr.example", admin: true },
        slack: null,
      }),
      SLACK_ADMIN
    )!;
    assert.match(f.summary, /holds an admin role, which only a Super Admin/);
    assert.doesNotMatch(f.summary, /Slack/);
    assert.equal(lifecycleAction(finding(f)), null);
  });

  it("asks only for Slack for a student, naming no address", () => {
    const f = offboardingAccountsFinding(
      leaver({
        personId: "P0040",
        name: "Kid Graduate",
        reason: { kind: "role", roles: ["Alumni"] },
        google: null,
        slack: { slackUserId: "U40" },
        groups: [
          {
            groupId: "g1",
            groupName: "grp-orders",
            address: "kid@school.example",
            role: "MEMBER",
          },
        ],
      }),
      SLACK_ADMIN
    )!;
    assert.match(
      f.summary,
      /^P0040 Kid Graduate is now Alumni on the lifecycle sheet, not a Mentor or Student, and still has a live Slack account\./
    );
    assert.doesNotMatch(f.summary, /school\.example/);
    assert.doesNotMatch(JSON.stringify(f.detail), /school\.example/);
    assert.equal(lifecycleAction(finding(f)), null);
  });

  it("says where to deactivate in words when the workspace is unknown", () => {
    const f = offboardingAccountsFinding(leaver({ google: null }), null)!;
    assert.match(f.summary, /in Slack's Manage members page\./);
    assert.doesNotMatch(f.summary, /https/);
  });

  it("is not raised for someone with only groups left", () => {
    assert.equal(
      offboardingAccountsFinding(leaver({ google: null, slack: null }), null),
      null
    );
  });

  it("words each way of leaving", () => {
    const why = (reason: Leaver["reason"]) =>
      offboardingAccountsFinding(leaver({ reason }), null)!.summary;
    assert.match(why({ kind: "gone" }), /is no longer on the lifecycle sheet,/);
    assert.match(
      why({ kind: "status_unknown" }),
      /has a blank or unknown Active\/Inactive/
    );
    assert.match(
      why({ kind: "role", roles: [] }),
      /holds no role on the lifecycle sheet,/
    );
  });
});

describe("Restore, on a suspended account's onboarding request", () => {
  it("replaces I'm on it for a suspended account, and only for one", () => {
    const suspended = lifecycleAction({
      kind: "onboarding_rhr_email",
      dedupe_key: "onboarding_rhr_email:P0012",
      detail: JSON.stringify({ problem: { kind: "suspended" } }),
    });
    assert.equal(suspended?.actionId, RESTORE_GOOGLE_ACTION);
    assert.equal(suspended?.label, "Restore Google account");
    assert.equal(suspended?.routine, true);
    const alias = lifecycleAction({
      kind: "onboarding_rhr_email",
      dedupe_key: "onboarding_rhr_email:P0012",
      detail: JSON.stringify({
        problem: { kind: "alias", primaryEmail: "x@rhr.example" },
      }),
    });
    assert.equal(alias?.label, "I'm on it");
  });
});

describe("warnings for what nobody accounts for", () => {
  it("a Google account no RHR Email reaches, named in full", () => {
    const f = unknownGoogleAccountFinding({
      account: "calendar@rhr.example",
      admin: false,
    });
    assert.equal(f.dedupeKey, "google_account_unknown:calendar@rhr.example");
    assert.equal(
      f.summary,
      "An active Google account the lifecycle sheet does not account for: " +
        "calendar@rhr.example. No one's RHR Email is this account. If it is a " +
        "mentor's, put it on their row; if it is a shared account, " +
        "acknowledge this. Nothing was changed."
    );
    assert.equal(
      lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey }),
      null
    );
  });

  it("one warning per outside address, partly hidden, naming every group", () => {
    const fs = groupOutsiderFindings([
      {
        groupId: "g2",
        groupName: "grp-grants",
        address: "m.kitchen@gmail.example",
        role: "MANAGER",
      },
      {
        groupId: "g3",
        groupName: "Kitchens",
        address: "m.kitchen@gmail.example",
        role: "OWNER",
      },
      {
        groupId: "g4",
        groupName: "grp-contact",
        address: "m.kitchen@gmail.example",
        role: "MEMBER",
      },
      {
        groupId: "g3",
        groupName: "Kitchens",
        address: "e.baker@gmail.example",
        role: "OWNER",
      },
    ]);
    assert.deepEqual(
      fs.map((f) => [f.dedupeKey, f.subjectRef, f.summary]),
      [
        [
          "group_outsider:e.baker@gmail.example",
          "e…@gmail.example",
          "An address the lifecycle sheet does not account for, " +
            "e…@gmail.example, is in Kitchens (owner). If it is someone's, " +
            "put it on their row; if it is an outside collaborator, " +
            "acknowledge this. Nothing was removed.",
        ],
        [
          "group_outsider:m.kitchen@gmail.example",
          "m…@gmail.example",
          "An address the lifecycle sheet does not account for, " +
            "m…@gmail.example, is in grp-grants (manager), Kitchens (owner) " +
            "and grp-contact. If it is someone's, put it on their row; if it " +
            "is an outside collaborator, acknowledge this. Nothing was removed.",
        ],
      ]
    );
    for (const f of fs) {
      assert.doesNotMatch(f.summary, /kitchen@|baker@/);
      assert.equal(
        lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey }),
        null
      );
    }
  });
});

describe("Remove from groups reaches the groups the sheet does not compute", () => {
  const other = [
    {
      groupId: "g1",
      groupName: "grp-orders",
      address: "pat@rhr.example",
      role: "OWNER" as const,
    },
    {
      groupId: "g2",
      groupName: "bonfire",
      address: "pat@rhr.example",
      role: "MEMBER" as const,
    },
  ];
  const names = new Map([["P0012", "Pat Mentor"]]);

  it("someone leaving who is only in other groups gets the alert, with their reason", () => {
    const [s] = heldSubjects([], [], [], [leaver({ groups: other })]);
    assert.equal(s?.kind, "group_member_held");
    assert.equal(s?.key, "group_member_held:P0012");
    const f = heldMemberFinding(s!, { names, inSlack: () => false });
    assert.equal(
      f.summary,
      "P0012 Pat Mentor is Inactive on the lifecycle sheet: still in " +
        "grp-orders (owner), bonfire. Nothing was removed."
    );
    assert.deepEqual((f.detail as { other: unknown[] }).other, [
      { groupId: "g1", groupName: "grp-orders", role: "OWNER" },
      { groupId: "g2", groupName: "bonfire", role: "MEMBER" },
    ]);
    const action = lifecycleAction({
      kind: f.kind,
      dedupe_key: f.dedupeKey,
      detail: JSON.stringify(f.detail),
    });
    assert.equal(action?.actionId, REMOVE_FROM_GROUPS_ACTION);
  });

  it("joins the tracked groups' alert for the same person, and is never cori_lapsed", () => {
    const subjects = heldSubjects(
      [
        {
          group: "grp-mentors",
          add: [],
          automatic: [],
          held: [
            {
              address: "pat@rhr.example",
              personIds: ["P0012"],
              reason: "no_access",
            },
          ],
          refusal: null,
        },
      ],
      [],
      [],
      [leaver({ groups: other })]
    );
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0]?.kind, "group_member_held");
    const f = heldMemberFinding(subjects[0]!, { names, inSlack: () => false });
    assert.match(
      f.summary,
      /still in grp-mentors, grp-orders \(owner\), bonfire/
    );
  });

  it("names each other group once, with the most senior role held", () => {
    const [s] = heldSubjects(
      [],
      [],
      [],
      [
        leaver({
          groups: [
            { ...other[1]!, address: "pat@rhr.example" },
            { ...other[1]!, address: "old@rhr.example", role: "MANAGER" },
          ],
        }),
      ]
    );
    const f = heldMemberFinding(s!, { names, inSlack: () => false });
    assert.match(f.summary, /still in bonfire \(manager\)\./);
  });
});

/** A stand-in for Google: records each request, answers from a list. */
function fakeGoogle(answers: (object | Error)[]) {
  const calls: { url: string; method?: string; data?: unknown }[] = [];
  return {
    calls,
    client: {
      request: async (req: {
        url: string;
        method?: string;
        data?: unknown;
      }) => {
        calls.push(req);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return { data: next };
      },
      getAccessToken: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return { token: "t" };
      },
    } as unknown as JWT,
  };
}

function googleError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

describe("suspending and restoring in Google", () => {
  it("patches only the suspended flag, by the account's address", async () => {
    const g = fakeGoogle([{}, {}]);
    await setSuspended(g.client, "pat@rhr.example", true);
    await setSuspended(g.client, "pat@rhr.example", false);
    assert.equal(g.calls[0]?.method, "PATCH");
    assert.match(g.calls[0]!.url, /\/users\/pat%40rhr\.example\?/);
    assert.deepEqual(g.calls[0]?.data, { suspended: true });
    assert.deepEqual(g.calls[1]?.data, { suspended: false });
  });

  it("names the role privilege, and the admin-role limit, on a 403", async () => {
    const g = fakeGoogle([googleError(403, "Not Authorized")]);
    await assert.rejects(
      setSuspended(g.client, "pat@rhr.example", true),
      /Users → Update → Suspend users.*only a Super Admin/s
    );
  });

  it("names the missing delegation scope, before any click", async () => {
    const g = fakeGoogle([
      new Error("unauthorized_client: Client is unauthorized"),
    ]);
    await assert.rejects(
      checkSuspendDelegation(g.client),
      /admin\.directory\.user \(docs\/google-setup\.md, Part 4\)/
    );
    await checkSuspendDelegation(fakeGoogle([{}]).client);
  });

  it("the dry run says whether the delegation is in place", () => {
    const base = {
      plan: { leavers: [], directoryChecked: true, groupsChecked: true },
      asOf: "2026-09-29",
      slackAccounts: 1,
      directory: { count: 1, admins: 0 },
      groups: { untracked: [], total: 9 },
    };
    assert.match(
      formatOffboarding({ ...base, suspend: { ok: true } }),
      /Suspend and Restore: the delegation is in place\./
    );
    assert.match(
      formatOffboarding({ ...base, suspend: { error: "Google refused." } }),
      /Suspend and Restore: NOT set up\. Google refused\./
    );
  });
});
