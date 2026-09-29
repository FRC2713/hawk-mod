import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JWT } from "google-auth-library";
import { listDomainUsers, pageUsers } from "../src/google/directory.js";
import type { OnboardingPlan } from "../src/domain/lifecycle/onboarding.js";
import { formatOnboarding } from "../src/domain/lifecycle/onboardingReport.js";

/**
 * Step 6, part 2: reading Google's user accounts as hawk-mod@, and the
 * `/hawkmod lifecycle onboarding` dry run. The dry run can be posted in any
 * channel, so it names Person IDs and never an address.
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

describe("reading Google's user accounts", () => {
  it("keeps the primary address, every alias, and suspension, lower-cased", () => {
    assert.deepEqual(
      pageUsers({
        users: [
          {
            primaryEmail: "Jordan.Lee@RHR.example",
            aliases: ["JLee@rhr.example"],
            nonEditableAliases: ["jordan.lee@rhr.test-google-a.com"],
            suspended: false,
          },
          { primaryEmail: "gone@rhr.example", suspended: true },
          { aliases: ["no-primary@rhr.example"] },
        ],
      }),
      [
        {
          primaryEmail: "jordan.lee@rhr.example",
          aliases: ["jlee@rhr.example", "jordan.lee@rhr.test-google-a.com"],
          suspended: false,
        },
        { primaryEmail: "gone@rhr.example", aliases: [], suspended: true },
      ]
    );
  });

  it("reads every page, asking for nothing but addresses and suspension", async () => {
    const google = fakeGoogle([
      { users: [{ primaryEmail: "a@rhr.example" }], nextPageToken: "p2" },
      { users: [{ primaryEmail: "b@rhr.example" }] },
    ]);
    const users = await listDomainUsers(google);
    assert.deepEqual(
      users.map((u) => u.primaryEmail),
      ["a@rhr.example", "b@rhr.example"]
    );
    assert.equal(google.urls.length, 2);
    assert.match(google.urls[1]!, /pageToken=p2/);
    const fields = new URL(google.urls[0]!).searchParams.get("fields");
    assert.equal(
      fields,
      "users(primaryEmail,aliases,nonEditableAliases,suspended),nextPageToken"
    );
  });

  it("names the missing delegation scope when Google refuses the client", async () => {
    const google = fakeGoogle([
      new Error("unauthorized_client: Client is unauthorized"),
    ]);
    await assert.rejects(
      listDomainUsers(google),
      /admin\.directory\.user\.readonly/
    );
  });

  it("names the missing role privilege on a 403", async () => {
    const google = fakeGoogle([googleError(403, "Not Authorized")]);
    await assert.rejects(listDomainUsers(google), /Users → Read/);
  });
});

const PLAN: OnboardingPlan = {
  requests: [
    {
      kind: "google_account",
      personId: "P0042",
      name: "Jordan Lee",
      address: null,
    },
    {
      kind: "google_account",
      personId: "P0073",
      name: "Alexa Mentor",
      address: "alexa@rhr.example",
    },
    {
      kind: "rhr_email",
      personId: "P0043",
      name: "Sam Park",
      problem: { kind: "alias", primaryEmail: "sam.park@rhr.example" },
    },
    {
      kind: "slack_invite",
      personId: "P0043",
      name: "Sam Park",
      role: "mentor",
      address: "sam@rhr.example",
    },
    {
      kind: "slack_invite",
      personId: "P0101",
      name: "Alex Student",
      role: "student",
      address: "alex@school.example",
    },
    {
      kind: "slack_reactivate",
      personId: "P0102",
      name: "Casey Student",
      role: "student",
      slackUserId: "U9",
    },
  ],
  notReady: [
    {
      personId: "P0004",
      role: "mentor",
      reason: "no CORI Expiry on the sheet",
    },
  ],
  directoryChecked: true,
};

function report(over: Partial<Parameters<typeof formatOnboarding>[0]> = {}) {
  return formatOnboarding({
    plan: PLAN,
    asOf: "2026-09-29",
    slackAccounts: 120,
    directory: { count: 45 },
    channel: "#bot-onboarding-requests (C0ONBOARD)",
    channelIsFallback: false,
    ...over,
  });
}

describe("the onboarding dry run", () => {
  it("lists every request and every reason, by Person ID", () => {
    const text = report();
    assert.match(text, /dry run: nothing posted/);
    assert.match(
      text,
      /Google accounts to create \(Active mentors with no account yet\): 2\n {2}P0042: no RHR Email on the sheet yet\n {2}P0073: at the RHR Email on the sheet/
    );
    assert.match(text, /suspended or an alias: 1 \(checked against 45/);
    assert.match(text, /P0043: it is an alias of another account/);
    assert.match(
      text,
      /Slack invites: 2\n {2}mentors: P0043\n {2}students: P0101/
    );
    assert.match(text, /reactivate: 1\n {2}P0102 \(student\)/);
    assert.match(text, /P0004 \(mentor\): no CORI Expiry on the sheet/);
    assert.match(
      text,
      /Requests will go to #bot-onboarding-requests \(C0ONBOARD\)\.$/
    );
  });

  it("never shows a name or an address", () => {
    const text = report();
    assert.doesNotMatch(text, /@/);
    for (const name of ["Jordan", "Sam", "Alex", "Casey", "Alexa"]) {
      assert.doesNotMatch(text, new RegExp(name));
    }
  });

  it("says when requests would go to the alert channel instead", () => {
    const text = report({
      channel: "#hawk-mod-alerts (C0ALERTS)",
      channelIsFallback: true,
    });
    assert.match(
      text,
      /the alert channel, because `onboarding-channel` is not set/
    );
  });

  it("says RHR Emails were not checked, and why, when Google refused", () => {
    const text = report({
      plan: { ...PLAN, requests: [], directoryChecked: false },
      directory: { error: "Google refused to list user accounts." },
    });
    assert.match(
      text,
      /RHR Emails: NOT checked against Google, so accounts still to create at a filled-in address are not listed\. .*\n {2}Google refused to list/
    );
  });
});
