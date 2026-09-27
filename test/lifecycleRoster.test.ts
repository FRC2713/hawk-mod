import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Person, Role } from "../src/domain/people.js";
import {
  planRoster,
  type RosterChange,
  type RosterFinding,
  type RosterPlan,
} from "../src/domain/lifecycle/roster.js";
import type {
  MentorDetails,
  SheetPerson,
  SheetStatus,
} from "../src/domain/lifecycle/sheet.js";
import type { SlackAccount } from "../src/domain/lifecycle/slackIds.js";

/**
 * One test (at least) per row of "What applies, and what asks" in
 * docs/lifecycle-sync.md, plus the cutover matching and the invariant the
 * whole step rests on: nothing the sheet says can make hawk-mod see less.
 */

let row = 2;

type MentorOpts = Partial<Omit<MentorDetails, "row">>;

function sheetMentor(
  personId: string,
  opts: MentorOpts & { status?: SheetStatus; name?: string } = {}
): SheetPerson {
  const { status = "active", name = `Mentor ${personId}`, ...m } = opts;
  return {
    personId,
    name,
    personalEmail: null,
    status,
    roles: ["Mentor"],
    mentor: {
      row: row++,
      rhrEmail: `${personId.toLowerCase()}@rhr.example`,
      slackUserId: null,
      yptExpiry: null,
      screeningExpiry: null,
      coriExpiry: null,
      consentReleaseExpiry: null,
      dataPrivacyExpiry: null,
      mentorReadyCompleted: null,
      lead: false,
      ra: false,
      ...m,
    },
    student: null,
    adminRoles: [],
  };
}

function sheetStudent(
  personId: string,
  opts: {
    status?: SheetStatus;
    schoolEmail?: string | null;
    slackUserId?: string | null;
    slackConsentExpiry?: string | null;
  } = {}
): SheetPerson {
  return {
    personId,
    name: `Student ${personId}`,
    personalEmail: `${personId}@personal.example`,
    status: opts.status ?? "active",
    roles: ["Student"],
    mentor: null,
    student: {
      row: row++,
      schoolEmail:
        opts.schoolEmail === undefined
          ? `${personId.toLowerCase()}@school.example`
          : opts.schoolEmail,
      slackUserId: opts.slackUserId ?? null,
      lead: false,
      slackConsentExpiry: opts.slackConsentExpiry ?? null,
    },
    adminRoles: [],
  };
}

let nextId = 1;

function onRoster(role: Role, overrides: Partial<Person> = {}): Person {
  const id = nextId++;
  return {
    id,
    person_id: null,
    slack_user_id: null,
    email: null,
    full_name: `Roster ${id}`,
    role,
    active: 1,
    screening_expires_on: null,
    training_expires_on: null,
    cori_expires_on: null,
    consent_release_expires_on: null,
    data_privacy_expires_on: null,
    mentor_ready_completed_on: null,
    slack_consent_expires_on: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A roster row already matched to `s`, agreeing with it in every field. */
function matched(role: Role, s: SheetPerson, overrides: Partial<Person> = {}) {
  const d = s.mentor ?? s.student!;
  return onRoster(role, {
    person_id: s.personId,
    full_name: s.name,
    email: "rhrEmail" in d ? d.rhrEmail : d.schoolEmail,
    slack_user_id: d.slackUserId,
    slack_consent_expires_on: s.student?.slackConsentExpiry ?? null,
    ...overrides,
  });
}

const live = (id: string, email: string | null = null): SlackAccount => ({
  id,
  email,
  live: true,
});

function plan(
  roster: Person[],
  sheet: SheetPerson[],
  accounts: SlackAccount[] = [],
  firstApply = false
): RosterPlan {
  return planRoster({ roster, sheet, accounts, firstApply });
}

const kinds = (xs: { kind: string }[]) => xs.map((x) => x.kind);

function onlyCreate(p: RosterPlan): Extract<RosterChange, { kind: "create" }> {
  assert.equal(p.changes.length, 1, JSON.stringify(p.changes));
  const [c] = p.changes;
  assert.equal(c!.kind, "create");
  return c as Extract<RosterChange, { kind: "create" }>;
}

function onlyUpdate(p: RosterPlan): Extract<RosterChange, { kind: "update" }> {
  assert.equal(p.changes.length, 1, JSON.stringify(p.changes));
  const [c] = p.changes;
  assert.equal(c!.kind, "update");
  return c as Extract<RosterChange, { kind: "update" }>;
}

describe("roster from the sheet: what applies, and what asks", () => {
  it("creates a student or adult for someone Active with no row", () => {
    const p = plan([], [sheetStudent("P0100"), sheetMentor("P0101")]);
    assert.deepEqual(
      p.changes.map((c) => c.kind === "create" && [c.personId, c.role]),
      [
        ["P0100", "student"],
        ["P0101", "adult"],
      ]
    );
    assert.deepEqual(p.findings, []);
  });

  it("creates a row for someone not in Slack yet, with their identity email", () => {
    const c = onlyCreate(plan([], [sheetStudent("P0100")]));
    assert.equal(c.email, "p0100@school.example");
    assert.equal(c.slackUserId, null);
  });

  it("creates a row with no email when the sheet has none, never a personal one", () => {
    const c = onlyCreate(
      plan([], [sheetStudent("P0100", { schoolEmail: null })])
    );
    assert.equal(c.email, null);
  });

  it("counts a blank or unknown status as Active for monitoring", () => {
    const p = plan([], [sheetStudent("P0100", { status: "unknown" })]);
    assert.deepEqual(kinds(p.changes), ["create"]);
  });

  it("creates nobody for an Inactive row, a volunteer or an alum", () => {
    const alum: SheetPerson = { ...sheetStudent("P0102"), roles: ["Alumni"] };
    const volunteer: SheetPerson = {
      ...sheetMentor("P0103"),
      roles: ["Volunteer"],
    };
    const p = plan(
      [],
      [sheetStudent("P0100", { status: "inactive" }), alum, volunteer]
    );
    assert.deepEqual(p.changes, []);
  });

  it("changes an adult to student when the sheet says Student", () => {
    const s = sheetStudent("P0100");
    const u = onlyUpdate(plan([matched("adult", s)], [s]));
    assert.equal(u.set.role, "student");
  });

  it("changes a district observer to student when the sheet says Student", () => {
    const s = sheetStudent("P0100");
    const u = onlyUpdate(plan([matched("district_observer", s)], [s]));
    assert.equal(u.set.role, "student");
  });

  it("leaves a student the sheet calls Mentor alone, and asks: Make adult", () => {
    const s = sheetMentor("P0100");
    const r = matched("student", s);
    const p = plan([r], [s]);
    assert.deepEqual(p.changes, []);
    assert.deepEqual(p.findings, [
      { kind: "roster_drift", rosterId: r.id, personId: "P0100" },
    ]);
  });

  it("treats a district observer the sheet calls Mentor as agreement", () => {
    const s = sheetMentor("P0100");
    const p = plan([matched("district_observer", s)], [s]);
    assert.deepEqual(p.changes, []);
    assert.deepEqual(p.findings, []);
  });

  it("changes nothing for someone both Student and Mentor, and says so", () => {
    const s: SheetPerson = {
      ...sheetStudent("P0100"),
      roles: ["Student", "Mentor"],
      mentor: sheetMentor("P0100").mentor,
    };
    const onRow = plan([matched("student", s, { role: "adult" })], [s]);
    assert.deepEqual(onRow.changes, []);
    assert.deepEqual(kinds(onRow.findings), ["sheet_conflict"]);
    const noRow = plan([], [s]);
    assert.deepEqual(noRow.changes, []);
    assert.deepEqual(kinds(noRow.findings), ["sheet_conflict"]);
  });

  it("reactivates someone deactivated whom the sheet declares Active", () => {
    const s = sheetStudent("P0100");
    const u = onlyUpdate(plan([matched("student", s, { active: 0 })], [s]));
    assert.equal(u.set.reactivate, true);
  });

  it("reactivates on an unknown status too — the cautious reading", () => {
    const s = sheetStudent("P0100", { status: "unknown" });
    const u = onlyUpdate(plan([matched("student", s, { active: 0 })], [s]));
    assert.equal(u.set.reactivate, true);
  });

  for (const [what, s] of [
    ["Inactive", sheetStudent("P0100", { status: "inactive" })],
    ["now Alumni", { ...sheetStudent("P0100"), roles: ["Alumni"] }],
  ] as const) {
    it(`keeps monitoring someone ${what}, and asks: End monitoring`, () => {
      const r = matched("student", s as SheetPerson);
      const p = plan([r], [s as SheetPerson]);
      assert.deepEqual(p.changes, []);
      assert.equal(p.findings.length, 1);
      const f = p.findings[0]!;
      assert.equal(f.kind, "sheet_undeclared");
      assert.equal(f.kind === "sheet_undeclared" && f.rosterId, r.id);
    });
  }

  it("keeps monitoring someone whose row is gone from the sheet, and asks", () => {
    const r = onRoster("student", { person_id: "P0100", slack_user_id: "U1" });
    const p = plan([r], []);
    assert.deepEqual(p.changes, []);
    assert.deepEqual(p.findings, [
      {
        kind: "sheet_undeclared",
        rosterId: r.id,
        personId: "P0100",
        role: "student",
        reason: { kind: "gone" },
      },
    ]);
  });

  it("does not ask again about someone already deactivated", () => {
    const s = sheetStudent("P0100", { status: "inactive" });
    const p = plan([matched("student", s, { active: 0 })], [s]);
    assert.deepEqual(p.findings, []);
  });

  it("never flags a district observer for being missing from the sheet", () => {
    const p = plan(
      [onRoster("district_observer", { slack_user_id: "U9" })],
      [],
      [],
      true
    );
    assert.deepEqual(p.findings, []);
    assert.equal(p.refused, null);
  });

  it("updates a name and an identity email", () => {
    const s = sheetMentor("P0100", { name: "Jordan Lee" });
    const u = onlyUpdate(
      plan(
        [matched("adult", s, { full_name: "J Lee", email: "old@x.org" })],
        [s]
      )
    );
    assert.deepEqual(u.set, {
      full_name: "Jordan Lee",
      email: "p0100@rhr.example",
    });
  });

  it("clears an email the sheet no longer has, rather than keep a stand-in", () => {
    const s = sheetStudent("P0100", { schoolEmail: null });
    const u = onlyUpdate(
      plan([matched("student", s, { email: "U1@slack.local" })], [s])
    );
    assert.deepEqual(u.set, { email: null });
  });

  it("leaves a different Slack User ID alone, and says so", () => {
    const s = sheetMentor("P0100", { slackUserId: "U2" });
    const p = plan(
      [matched("adult", s, { slack_user_id: "U1" })],
      [s],
      [live("U1"), live("U2")]
    );
    assert.deepEqual(p.changes, []);
    assert.deepEqual(kinds(p.findings), ["sheet_conflict"]);
  });

  it("links a Slack account the roster did not have", () => {
    const s = sheetMentor("P0100", { slackUserId: "U2" });
    const u = onlyUpdate(
      plan([matched("adult", s, { slack_user_id: null })], [s], [live("U2")])
    );
    assert.deepEqual(u.set, { slack_user_id: "U2" });
  });
});

describe("roster from the sheet: dates", () => {
  const dated = sheetMentor("P0100", {
    yptExpiry: "2027-08-01",
    screeningExpiry: "2028-06-01",
    coriExpiry: "2029-01-01",
    consentReleaseExpiry: "2027-08-01",
    dataPrivacyExpiry: "2027-08-01",
    mentorReadyCompleted: "2025-10-01",
  });

  it("copies every requirement date to the column it belongs in", () => {
    const u = onlyUpdate(plan([matched("adult", dated)], [dated]));
    assert.deepEqual(u.set.dates, {
      screening_expires_on: "2028-06-01",
      training_expires_on: "2027-08-01",
      cori_expires_on: "2029-01-01",
      consent_release_expires_on: "2027-08-01",
      data_privacy_expires_on: "2027-08-01",
      mentor_ready_completed_on: "2025-10-01",
    });
  });

  it("copies a blank over a date on record — stricter, never blinder", () => {
    const s = sheetMentor("P0100");
    const u = onlyUpdate(
      plan([matched("adult", s, { cori_expires_on: "2029-01-01" })], [s])
    );
    assert.deepEqual(u.set.dates, { cori_expires_on: null });
  });

  it("keeps the dates of someone with no Mentor_Details row at all", () => {
    const s: SheetPerson = { ...sheetMentor("P0100"), mentor: null };
    const r = onRoster("adult", {
      person_id: "P0100",
      full_name: s.name,
      cori_expires_on: "2029-01-01",
    });
    assert.deepEqual(plan([r], [s]).changes, []);
  });

  it("copies a student's Slack Consent Expiry, blank included", () => {
    const s = sheetStudent("P0100", { slackConsentExpiry: "2027-08-01" });
    const u = onlyUpdate(
      plan([matched("student", s, { slack_consent_expires_on: null })], [s])
    );
    assert.deepEqual(u.set.dates, { slack_consent_expires_on: "2027-08-01" });
    const cleared = sheetStudent("P0101");
    const u2 = onlyUpdate(
      plan(
        [
          matched("student", cleared, {
            slack_consent_expires_on: "2027-08-01",
          }),
        ],
        [cleared]
      )
    );
    assert.deepEqual(u2.set.dates, { slack_consent_expires_on: null });
  });

  it("gives a new row the sheet's dates", () => {
    const c = onlyCreate(plan([], [dated]));
    assert.equal(c.dates.cori_expires_on, "2029-01-01");
  });

  it("changes nothing when the roster already agrees", () => {
    const r = matched("adult", dated, {
      screening_expires_on: "2028-06-01",
      training_expires_on: "2027-08-01",
      cori_expires_on: "2029-01-01",
      consent_release_expires_on: "2027-08-01",
      data_privacy_expires_on: "2027-08-01",
      mentor_ready_completed_on: "2025-10-01",
    });
    assert.deepEqual(plan([r], [dated]), {
      changes: [],
      findings: [],
      unmatchedWithSlack: [],
      refused: null,
    });
  });
});

describe("roster from the sheet: matching today's rows at cutover", () => {
  it("matches by the Slack User ID typed on the sheet, even with a different email", () => {
    const s = sheetMentor("P0100", { slackUserId: "U1" });
    const r = onRoster("adult", {
      slack_user_id: "U1",
      email: "own@gmail.example",
    });
    const u = onlyUpdate(
      plan([r], [s], [live("U1", "own@gmail.example")], true)
    );
    assert.equal(u.rosterId, r.id);
    assert.equal(u.set.person_id, "P0100");
  });

  it("matches by the Slack ID step 1 would fill in, from the identity email", () => {
    const s = sheetStudent("P0100");
    const r = onRoster("student", {
      slack_user_id: "U1",
      email: "U1@slack.local",
    });
    const u = onlyUpdate(
      plan([r], [s], [live("U1", "p0100@school.example")], true)
    );
    assert.equal(u.set.person_id, "P0100");
    assert.equal(u.set.email, "p0100@school.example");
  });

  it("matches by identity email, ignoring case", () => {
    const s = sheetStudent("P0100");
    const r = onRoster("student", { email: "P0100@School.Example" });
    const u = onlyUpdate(plan([r], [s], [], true));
    assert.equal(u.set.person_id, "P0100");
  });

  it("never matches on anything looser — a name is not a match", () => {
    const s = sheetStudent("P0100");
    const r = onRoster("student", {
      full_name: s.name,
      slack_user_id: "U1",
      email: "other@x.org",
    });
    const p = plan([r], [s], [live("U1", "other@x.org")], true);
    assert.deepEqual(p.unmatchedWithSlack, [r.id]);
    assert.ok(p.refused);
  });

  it("refuses the first apply while a row with a Slack account is unmatched", () => {
    const r = onRoster("student", { slack_user_id: "U1" });
    const p = plan([r], [sheetStudent("P0100")], [live("U1")], true);
    assert.deepEqual(p.unmatchedWithSlack, [r.id]);
    assert.match(p.refused!, /Type each one's Slack User ID into the sheet/);
  });

  it("does not refuse for an unmatched row with no Slack account", () => {
    const p = plan([onRoster("adult", { email: "gone@x.org" })], [], [], true);
    assert.equal(p.refused, null);
    assert.deepEqual(kinds(p.findings), ["sheet_undeclared"]);
  });

  it("after cutover, an unmatched row is a finding rather than a refusal", () => {
    const r = onRoster("student", { slack_user_id: "U1" });
    const p = plan([r], [], [live("U1")], false);
    assert.equal(p.refused, null);
    assert.deepEqual(p.findings, [
      {
        kind: "sheet_undeclared",
        rosterId: r.id,
        personId: null,
        role: "student",
        reason: { kind: "not_on_sheet" },
      },
    ]);
  });

  it("refuses a typed Slack User ID that is not a live account", () => {
    const s = sheetMentor("P0100", { slackUserId: "U404" });
    const r = onRoster("adult", { slack_user_id: "U404" });
    const p = plan([r], [s], [], true);
    assert.ok(p.findings.some((f) => f.kind === "sheet_conflict"));
    assert.ok(p.refused);
    assert.ok(!p.changes.some((c) => c.kind === "create"));
  });

  it("uses neither of two rows carrying the same Slack User ID", () => {
    const a = sheetMentor("P0100", { slackUserId: "U1" });
    const b = sheetMentor("P0101", { slackUserId: "U1" });
    const r = onRoster("adult", { slack_user_id: "U1" });
    const p = plan([r], [a, b], [live("U1")], true);
    assert.deepEqual(p.changes, []);
    assert.equal(
      p.findings.filter((f) => f.kind === "sheet_conflict").length,
      2
    );
    assert.ok(p.refused);
  });

  it("matches nobody when the Slack account and the email point at different people", () => {
    const a = sheetMentor("P0100", { slackUserId: "U1" });
    const b = sheetMentor("P0101");
    const r = onRoster("adult", {
      slack_user_id: "U1",
      email: "p0101@rhr.example",
    });
    const p = plan([r], [a, b], [live("U1")], true);
    assert.ok(!p.changes.some((c) => c.kind === "update"));
    assert.ok(
      p.findings.some((f) => f.kind === "sheet_conflict" && f.rosterId === r.id)
    );
    assert.ok(p.refused);
  });

  it("matches nobody when two roster rows land on one person", () => {
    const s = sheetMentor("P0100", { slackUserId: "U1" });
    const a = onRoster("adult", { slack_user_id: "U1" });
    const b = onRoster("adult", { email: "p0100@rhr.example" });
    const p = plan([a, b], [s], [live("U1")], true);
    assert.ok(!p.changes.some((c) => c.kind === "update"));
    // And no third row gets created for them.
    assert.ok(!p.changes.some((c) => c.kind === "create"));
    assert.ok(p.findings.some((f) => f.kind === "sheet_conflict"));
  });

  it("does not create a second row for someone whose Slack account a row already holds", () => {
    const s = sheetMentor("P0100", { slackUserId: "U1" });
    const other = sheetMentor("P0200");
    const r = matched("adult", other, { slack_user_id: "U1" });
    const p = plan([r], [s, other], [live("U1")]);
    assert.ok(!p.changes.some((c) => c.kind === "create"));
    assert.ok(p.findings.some((f) => f.kind === "sheet_conflict"));
  });

  it("keys a stamped row by Person ID from then on, whatever else changes", () => {
    const s = sheetMentor("P0100", { rhrEmail: "new@rhr.example" });
    const r = onRoster("adult", {
      person_id: "P0100",
      full_name: s.name,
      email: "old@rhr.example",
    });
    const u = onlyUpdate(plan([r], [s]));
    assert.equal(u.rosterId, r.id);
    assert.deepEqual(u.set, { email: "new@rhr.example" });
  });
});

describe("roster from the sheet: nothing lowers monitoring", () => {
  // Every combination of what the sheet can say about one person against
  // every state the roster can be in, with and without a Slack account.
  const statuses: SheetStatus[] = ["active", "inactive", "unknown"];
  const roleSets = [
    ["Student"],
    ["Mentor"],
    ["Student", "Mentor"],
    ["Alumni"],
    ["Volunteer"],
  ];
  const roles: Role[] = ["student", "adult", "district_observer"];

  function sheetAs(status: SheetStatus, roleSet: string[]): SheetPerson[] {
    const base = roleSet.includes("Mentor")
      ? sheetMentor("P0500", { status, slackUserId: "U5" })
      : sheetStudent("P0500", { status, slackUserId: "U5" });
    return [
      {
        ...base,
        roles: roleSet as SheetPerson["roles"],
        mentor: roleSet.includes("Mentor") ? base.mentor : null,
        student:
          roleSet.includes("Mentor") && !roleSet.includes("Student")
            ? null
            : (base.student ??
              sheetStudent("P0500", { slackUserId: "U5" }).student),
      },
    ];
  }

  let cases = 0;
  for (const status of statuses)
    for (const roleSet of roleSets)
      for (const role of roles)
        for (const active of [0, 1])
          for (const stamped of [true, false])
            for (const present of [true, false]) {
              const rosterRow = onRoster(role, {
                active,
                slack_user_id: "U5",
                person_id: stamped ? "P0500" : null,
              });
              const sheet = present ? sheetAs(status, roleSet) : [];
              const p = plan([rosterRow], sheet, [live("U5")]);
              cases++;
              const label = `${status} ${roleSet.join("+")} vs ${role}/${active}${stamped ? " stamped" : ""}${present ? "" : ", no sheet row"}`;
              it(`never lowers: ${label}`, () => {
                for (const c of p.changes) {
                  if (c.kind !== "update") continue;
                  const set = c.set as Record<string, unknown>;
                  assert.ok(!("active" in set), "no change deactivates");
                  if (rosterRow.role === "student") {
                    assert.equal(
                      set.role,
                      undefined,
                      "no change leaves student"
                    );
                  }
                  if (set.role !== undefined) assert.equal(set.role, "student");
                  if (set.reactivate !== undefined)
                    assert.equal(set.reactivate, true);
                }
                // Someone monitored whom the sheet stops declaring is asked
                // about, never dropped silently.
                const stillDeclared =
                  present &&
                  status !== "inactive" &&
                  (roleSet.includes("Student") || roleSet.includes("Mentor"));
                if (
                  active === 1 &&
                  role !== "district_observer" &&
                  !stillDeclared
                ) {
                  const asked = p.findings.some(
                    (f: RosterFinding) =>
                      (f.kind === "sheet_undeclared" &&
                        f.rosterId === rosterRow.id) ||
                      f.kind === "sheet_conflict"
                  );
                  assert.ok(asked, JSON.stringify(p.findings));
                }
              });
            }
  it("covered every combination", () =>
    assert.equal(cases, 3 * 5 * 3 * 2 * 2 * 2));
});
