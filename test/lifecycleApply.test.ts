import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// A fresh database for this file only: node:test runs each file in its own
// process, and db() opens DATA_DIR on first use.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hawkmod-apply-"));

const repo = await import("../src/db/repo.js");
const { db } = await import("../src/db/client.js");
const { applyRosterChanges } = await import("../src/lifecycle/applyRoster.js");
const { planRoster } = await import("../src/domain/lifecycle/roster.js");
type SheetPerson = import("../src/domain/lifecycle/sheet.js").SheetPerson;

function student(personId: string, slackUserId: string | null): SheetPerson {
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
      slackUserId,
      lead: false,
      slackConsentExpiry: "2027-08-01",
    },
    adminRoles: [],
  };
}

const count = (sql: string) => (db().prepare(sql).get() as { n: number }).n;

describe("applying a roster plan", () => {
  it("refuses a refused plan and changes nothing", () => {
    repo.upsertPerson({
      email: "u9@slack.local",
      fullName: "Unmatched",
      role: "adult",
      slackUserId: "U9",
    });
    const plan = planRoster({
      roster: repo.listPeople(false),
      sheet: [student("P0100", null)],
      accounts: [{ id: "U9", email: null, live: true }],
      firstApply: true,
    });
    assert.ok(plan.refused);
    assert.throws(() => applyRosterChanges(plan));
    assert.equal(count("SELECT count(*) n FROM people"), 1);
    assert.equal(repo.rosterCutoverDone(), false);
    db().prepare("DELETE FROM people").run();
  });

  it("writes every change, records it, and leaves nothing to do", () => {
    const existing = repo.upsertPerson({
      email: "u1@slack.local",
      fullName: "Slack Name",
      role: "student",
      slackUserId: "U1",
    });
    const sheet = [student("P0100", "U1"), student("P0101", null)];
    const accounts = [{ id: "U1", email: null, live: true }];
    const plan = planRoster({
      roster: repo.listPeople(false),
      sheet,
      accounts,
      firstApply: true,
    });
    const stats = applyRosterChanges(plan);
    assert.deepEqual([stats.created, stats.matched], [1, 1]);
    assert.equal(repo.rosterCutoverDone(), true);

    const matched = repo.personById(existing.id)!;
    assert.equal(matched.person_id, "P0100");
    assert.equal(matched.email, "p0100@school.example");
    assert.equal(matched.slack_consent_expires_on, "2027-08-01");
    assert.equal(
      count(
        "SELECT count(*) n FROM role_changes WHERE source = 'lifecycle_sheet'"
      ),
      1
    );
    assert.equal(
      count(
        "SELECT count(*) n FROM screening_changes WHERE source = 'lifecycle_sheet'"
      ),
      2
    );

    const again = planRoster({
      roster: repo.listPeople(false),
      sheet,
      accounts,
      firstApply: false,
    });
    assert.deepEqual(again.changes, []);
    assert.deepEqual(again.findings, []);
  });

  it("writes all or nothing", () => {
    const before = count("SELECT count(*) n FROM people");
    const runs = count("SELECT count(*) n FROM audit_runs");
    const bad = {
      changes: [
        {
          kind: "create" as const,
          personId: "P0200",
          role: "student" as const,
          fullName: "A",
          email: "same@school.example",
          slackUserId: null,
          dates: {},
        },
        {
          kind: "create" as const,
          personId: "P0201",
          role: "student" as const,
          fullName: "B",
          email: "same@school.example",
          slackUserId: null,
          dates: {},
        },
      ],
      findings: [],
      unmatchedWithSlack: [],
      refused: null,
    };
    assert.throws(() => applyRosterChanges(bad), /UNIQUE/);
    assert.equal(count("SELECT count(*) n FROM people"), before);
    assert.equal(count("SELECT count(*) n FROM audit_runs"), runs);
  });
});
