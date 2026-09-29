import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  planOnboarding,
  rhrEmailProblem,
  type DirectoryAccount,
  type OnboardingSlackAccount,
} from "../src/domain/lifecycle/onboarding.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";

/**
 * Step 6 (capability H): the requests hawk-mod posts so that someone the
 * sheet declares gets into Google and Slack. Readiness is per role — a
 * mentor's CORI, a student's Slack Consent — and a student is only ever
 * invited by School Email.
 */

const AS_OF = "2026-09-29";

type MentorExtra = {
  rhrEmail?: string | null;
  coriExpiry?: string | null;
  slackUserId?: string | null;
  noDetails?: boolean;
  status?: SheetPerson["status"];
};

function mentor(personId: string, extra: MentorExtra = {}): SheetPerson {
  return {
    personId,
    name: `Mentor ${personId}`,
    personalEmail: `${personId.toLowerCase()}@personal.example`,
    status: extra.status ?? "active",
    roles: ["Mentor"],
    mentor: extra.noDetails
      ? null
      : {
          row: 2,
          rhrEmail:
            extra.rhrEmail === undefined
              ? `${personId.toLowerCase()}@rhr.example`
              : extra.rhrEmail,
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
    parentEmails: [],
  };
}

type StudentExtra = {
  schoolEmail?: string | null;
  consent?: string | null;
  slackUserId?: string | null;
  roles?: SheetPerson["roles"];
};

function student(personId: string, extra: StudentExtra = {}): SheetPerson {
  return {
    personId,
    name: `Student ${personId}`,
    personalEmail: `${personId.toLowerCase()}@personal.example`,
    status: "active",
    roles: extra.roles ?? ["Student"],
    mentor: null,
    student: {
      row: 2,
      schoolEmail:
        extra.schoolEmail === undefined
          ? `${personId.toLowerCase()}@school.example`
          : extra.schoolEmail,
      slackUserId: extra.slackUserId ?? null,
      lead: false,
      slackConsentExpiry:
        extra.consent === undefined ? "2027-08-01" : extra.consent,
    },
    adminRoles: [],
    parentEmails: [],
  };
}

/** Every mentor's RHR Email is a live Google account unless a test says not. */
function directoryFor(people: SheetPerson[]): DirectoryAccount[] {
  return people
    .map((p) => p.mentor?.rhrEmail)
    .filter((e): e is string => Boolean(e))
    .map((primaryEmail) => ({ primaryEmail, aliases: [], suspended: false }));
}

function plan(
  people: SheetPerson[],
  slack: OnboardingSlackAccount[] = [],
  directory: DirectoryAccount[] | null = directoryFor(people)
) {
  return planOnboarding(people, slack, directory, AS_OF);
}

const live = (id: string, email: string | null): OnboardingSlackAccount => ({
  id,
  email,
  deactivated: false,
});
const gone = (id: string, email: string | null): OnboardingSlackAccount => ({
  id,
  email,
  deactivated: true,
});

describe("Google account requests", () => {
  it("asks for an account for an Active mentor with no RHR Email", () => {
    const { requests } = plan([mentor("P0042", { rhrEmail: null })]);
    assert.deepEqual(requests, [
      {
        kind: "google_account",
        personId: "P0042",
        name: "Mentor P0042",
        address: null,
      },
    ]);
  });

  it("asks for one for a mentor with no Mentor_Details row at all", () => {
    const { requests } = plan([mentor("P0042", { noDetails: true })]);
    assert.deepEqual(
      requests.map((r) => r.kind),
      ["google_account"]
    );
  });

  it("does not wait for CORI", () => {
    const { requests } = plan([
      mentor("P0042", { rhrEmail: null, coriExpiry: null }),
    ]);
    assert.deepEqual(
      requests.map((r) => r.kind),
      ["google_account"]
    );
  });

  it("names nobody who is Inactive, or whose status is blank", () => {
    const { requests, notReady } = plan([
      mentor("P0042", { rhrEmail: null, status: "inactive" }),
      mentor("P0043", { rhrEmail: null, status: "unknown" }),
    ]);
    assert.deepEqual(requests, []);
    assert.deepEqual(notReady, []);
  });

  it("is done once the RHR Email is filled in", () => {
    const { requests } = plan(
      [mentor("P0042")],
      [live("U1", "p0042@rhr.example")]
    );
    assert.deepEqual(requests, []);
  });

  it("carries no address when the sheet has none", () => {
    const [r] = plan([mentor("P0042", { rhrEmail: null })]).requests;
    assert.doesNotMatch(JSON.stringify(r), /@/);
  });
});

describe("the RHR Email directory check", () => {
  const dir = (a: Partial<DirectoryAccount> & { primaryEmail: string }) => ({
    aliases: [],
    suspended: false,
    ...a,
  });

  it("passes a live account, whatever the case", () => {
    assert.equal(
      rhrEmailProblem("Jordan@RHR.example", [
        dir({ primaryEmail: "jordan@rhr.example" }),
      ]),
      null
    );
  });

  it("flags an address with no account behind it", () => {
    assert.deepEqual(
      rhrEmailProblem("jordn@rhr.example", [
        dir({ primaryEmail: "jordan@rhr.example" }),
      ]),
      {
        kind: "not_an_account",
      }
    );
  });

  it("flags a suspended account", () => {
    assert.deepEqual(
      rhrEmailProblem("jordan@rhr.example", [
        dir({ primaryEmail: "jordan@rhr.example", suspended: true }),
      ]),
      { kind: "suspended" }
    );
  });

  it("flags an alias, naming the primary address to use instead", () => {
    assert.deepEqual(
      rhrEmailProblem("jlee@rhr.example", [
        dir({
          primaryEmail: "Jordan.Lee@rhr.example",
          aliases: ["JLee@rhr.example"],
        }),
      ]),
      { kind: "alias", primaryEmail: "jordan.lee@rhr.example" }
    );
  });

  it("asks for the account at the RHR Email the sheet already has (P0073)", () => {
    // The agreed address goes on the sheet first; the account comes after.
    const { requests } = plan(
      [mentor("P0073")],
      [live("U1", "p0073@rhr.example")],
      []
    );
    assert.deepEqual(requests, [
      {
        kind: "google_account",
        personId: "P0073",
        name: "Mentor P0073",
        address: "p0073@rhr.example",
      },
    ]);
  });

  it("raises an RHR Email request for a suspended account", () => {
    const people = [mentor("P0042")];
    const { requests } = plan(
      people,
      [live("U1", "p0042@rhr.example")],
      [{ primaryEmail: "p0042@rhr.example", aliases: [], suspended: true }]
    );
    assert.deepEqual(requests, [
      {
        kind: "rhr_email",
        personId: "P0042",
        name: "Mentor P0042",
        problem: { kind: "suspended" },
      },
    ]);
  });

  it("does not check an Inactive mentor's address", () => {
    const { requests } = plan(
      [mentor("P0042", { status: "inactive" })],
      [],
      []
    );
    assert.deepEqual(requests, []);
  });

  it("checks nothing, and says so, when Google could not be read", () => {
    const p = plan([mentor("P0042")], [], null);
    assert.equal(p.directoryChecked, false);
    assert.deepEqual(
      p.requests.map((r) => r.kind),
      ["slack_invite"]
    );
  });
});

describe("Slack invites for mentors", () => {
  it("invites a mentor with CORI current by their RHR Email", () => {
    const { requests } = plan([mentor("P0042")]);
    assert.deepEqual(requests, [
      {
        kind: "slack_invite",
        personId: "P0042",
        name: "Mentor P0042",
        role: "mentor",
        address: "p0042@rhr.example",
      },
    ]);
  });

  it("waits for CORI, and says why", () => {
    const { requests, notReady } = plan([
      mentor("P0042", { coriExpiry: null }),
      mentor("P0043", { coriExpiry: "2026-09-28" }),
    ]);
    assert.deepEqual(requests, []);
    assert.deepEqual(notReady, [
      {
        personId: "P0042",
        role: "mentor",
        reason: "no CORI Expiry on the sheet",
      },
      { personId: "P0043", role: "mentor", reason: "CORI has expired" },
    ]);
  });

  it("does not invite a mentor whose Google account is not created yet", () => {
    const { requests, notReady } = plan([mentor("P0042")], [], []);
    assert.deepEqual(
      requests.map((r) => r.kind),
      ["google_account"]
    );
    assert.deepEqual(notReady, [
      {
        personId: "P0042",
        role: "mentor",
        reason: "their Google account has not been created yet",
      },
    ]);
  });

  it("does not invite a mentor whose RHR Email is an alias", () => {
    const { requests, notReady } = plan(
      [mentor("P0042")],
      [],
      [
        {
          primaryEmail: "jordan@rhr.example",
          aliases: ["p0042@rhr.example"],
          suspended: false,
        },
      ]
    );
    assert.deepEqual(
      requests.map((r) => r.kind),
      ["rhr_email"]
    );
    assert.equal(notReady[0]?.reason, "their RHR Email needs fixing first");
  });

  it("leaves out a mentor already in Slack under their RHR Email", () => {
    assert.deepEqual(
      plan([mentor("P0042")], [live("U1", "P0042@rhr.example")]).requests,
      []
    );
  });

  it("leaves out a mentor whose typed Slack ID is a live account with another email", () => {
    const people = [mentor("P0042", { slackUserId: "U1" })];
    assert.deepEqual(
      plan(people, [live("U1", "jordan@gmail.example")]).requests,
      []
    );
  });

  it("asks to reactivate a deactivated account rather than invite", () => {
    const people = [mentor("P0042", { slackUserId: "U1" })];
    assert.deepEqual(plan(people, [gone("U1", "p0042@rhr.example")]).requests, [
      {
        kind: "slack_reactivate",
        personId: "P0042",
        name: "Mentor P0042",
        role: "mentor",
        slackUserId: "U1",
      },
    ]);
  });

  it("prefers a live account over a deactivated one", () => {
    const people = [mentor("P0042", { slackUserId: "U1" })];
    const slack = [
      gone("U1", "old@rhr.example"),
      live("U2", "p0042@rhr.example"),
    ];
    assert.deepEqual(plan(people, slack).requests, []);
  });

  it("does not reactivate a mentor whose CORI is not current", () => {
    const people = [mentor("P0042", { coriExpiry: null })];
    const p = plan(people, [gone("U1", "p0042@rhr.example")]);
    assert.deepEqual(p.requests, []);
    assert.equal(p.notReady.length, 1);
  });
});

describe("Slack invites for students", () => {
  it("invites a student with Slack Consent current by their School Email", () => {
    assert.deepEqual(plan([student("P0101")]).requests, [
      {
        kind: "slack_invite",
        personId: "P0101",
        name: "Student P0101",
        role: "student",
        address: "p0101@school.example",
      },
    ]);
  });

  it("waits for Slack Consent, and says why", () => {
    const { requests, notReady } = plan([
      student("P0101", { consent: null }),
      student("P0102", { consent: "2026-08-01" }),
    ]);
    assert.deepEqual(requests, []);
    assert.deepEqual(notReady, [
      {
        personId: "P0101",
        role: "student",
        reason: "no Slack Consent Expiry on the sheet",
      },
      {
        personId: "P0102",
        role: "student",
        reason: "Slack Consent has expired",
      },
    ]);
  });

  it("never invites a student by personal email", () => {
    const { requests, notReady } = plan([
      student("P0101", { schoolEmail: null }),
    ]);
    assert.deepEqual(requests, []);
    assert.deepEqual(notReady, [
      {
        personId: "P0101",
        role: "student",
        reason: "no School Email on the sheet",
      },
    ]);
  });

  it("leaves out a student already in Slack", () => {
    assert.deepEqual(
      plan([student("P0101")], [live("U9", "p0101@school.example")]).requests,
      []
    );
  });

  it("asks to reactivate a returning student's deactivated account", () => {
    const people = [student("P0101", { slackUserId: "U9" })];
    assert.deepEqual(
      plan(people, [gone("U9", "p0101@school.example")]).requests.map(
        (r) => r.kind
      ),
      ["slack_reactivate"]
    );
  });

  it("onboards someone who is both Student and Mentor as a student", () => {
    const p = student("P0101", { roles: ["Student", "Mentor"] });
    assert.deepEqual(plan([p]).requests, [
      {
        kind: "slack_invite",
        personId: "P0101",
        name: "Student P0101",
        role: "student",
        address: "p0101@school.example",
      },
    ]);
  });
});

describe("the whole plan", () => {
  it("leaves out volunteers and alumni, who are never in Slack", () => {
    const volunteer: SheetPerson = {
      ...mentor("P0200"),
      roles: ["Volunteer"],
      mentor: null,
    };
    const alum: SheetPerson = {
      ...student("P0201"),
      roles: ["Alumni"],
      student: null,
    };
    assert.deepEqual(plan([volunteer, alum]), {
      requests: [],
      notReady: [],
      directoryChecked: true,
    });
  });

  it("is in Person ID order", () => {
    const { requests } = plan([
      student("P0103"),
      mentor("P0042", { rhrEmail: null }),
      student("P0101"),
    ]);
    assert.deepEqual(
      requests.map((r) => r.personId),
      ["P0042", "P0101", "P0103"]
    );
  });

  it("never carries anyone's personal address", () => {
    const people = [
      mentor("P0042"),
      mentor("P0043", { rhrEmail: null }),
      student("P0101"),
      student("P0102", { schoolEmail: null }),
    ];
    const text = JSON.stringify(plan(people, [], []));
    assert.doesNotMatch(text, /personal\.example/);
  });
});
