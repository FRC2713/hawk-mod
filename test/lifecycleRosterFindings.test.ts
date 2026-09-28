import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Person } from "../src/domain/people.js";
import type { RosterFinding } from "../src/domain/lifecycle/roster.js";
import {
  ROSTER_FINDING_PREFIXES,
  rosterFinding,
  rosterFindingKey,
} from "../src/domain/lifecycle/rosterFindings.js";
import {
  END_MONITORING_ACTION,
  lifecycleAction,
  MAKE_ADULT_ACTION,
} from "../src/slack/alerts.js";

/**
 * The alert channel is where these land. They name the person and their Person
 * ID so an administrator knows who to look at, and never an address. Their
 * keys are what lets the next run find the same finding again — and close it
 * when the sheet is fixed — so they must not depend on the wording.
 */

function row(id: number, overrides: Partial<Person> = {}): Person {
  return {
    id,
    person_id: null,
    slack_user_id: `U${id}`,
    email: `someone${id}@school.example`,
    full_name: `Roster ${id}`,
    role: "student",
    active: 1,
    screening_expires_on: null,
    training_expires_on: null,
    cori_expires_on: null,
    consent_release_expires_on: null,
    data_privacy_expires_on: null,
    mentor_ready_completed_on: null,
    slack_consent_expires_on: null,
    notes: null,
    created_at: "x",
    updated_at: "x",
    ...overrides,
  };
}

const names = {
  roster: new Map([
    [1, row(1, { person_id: "P0042" })],
    [2, row(2)],
  ]),
  sheet: new Map([["P0042", "Jordan Lee"]]),
};

const every: RosterFinding[] = [
  {
    kind: "sheet_undeclared",
    rosterId: 1,
    personId: "P0042",
    role: "student",
    reason: { kind: "inactive" },
  },
  {
    kind: "sheet_undeclared",
    rosterId: 1,
    personId: "P0042",
    role: "student",
    reason: { kind: "role", roles: ["Alumni"] },
  },
  {
    kind: "sheet_undeclared",
    rosterId: 2,
    personId: null,
    role: "adult",
    reason: { kind: "not_on_sheet" },
  },
  { kind: "roster_drift", rosterId: 1, personId: "P0042" },
  {
    kind: "sheet_conflict",
    personId: "P0042",
    rosterId: null,
    reason: "the sheet lists them as both Student and Mentor",
  },
];

describe("roster findings", () => {
  it("name the person and Person ID, and never an address", () => {
    for (const f of every) {
      const { summary } = rosterFinding(f, names);
      assert.ok(!summary.includes("example"), summary);
      if (f.personId) assert.match(summary, /P0042 Jordan Lee/);
    }
  });

  it("name a row not yet matched by its Slack account", () => {
    assert.match(rosterFinding(every[2]!, names).summary, /Roster 2 \(<@U2>\)/);
  });

  it("say why someone is undeclared, and that they are still monitored", () => {
    assert.match(
      rosterFinding(every[0]!, names).summary,
      /is Inactive on the lifecycle sheet\. hawk-mod is still monitoring them as a student/
    );
    assert.match(
      rosterFinding(every[1]!, names).summary,
      /is now Alumni on the lifecycle sheet/
    );
  });

  it("keep one key per person whatever the reason becomes", () => {
    assert.equal(rosterFindingKey(every[0]!), rosterFindingKey(every[1]!));
  });

  it("are all keys the roster run owns, and nothing else is", () => {
    for (const f of every) {
      const key = rosterFindingKey(f);
      assert.ok(
        ROSTER_FINDING_PREFIXES.some((p) => key.startsWith(p)),
        key
      );
    }
    // The user-group sync's roster_drift is not the run's to close.
    const groupDrift = "roster_drift:U1:student:adult";
    assert.ok(!ROSTER_FINDING_PREFIXES.some((p) => groupDrift.startsWith(p)));
  });
});

describe("which findings offer a button that lowers monitoring", () => {
  it("offers End monitoring on sheet_undeclared", () => {
    const f = rosterFinding(every[0]!, names);
    assert.equal(
      lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey })?.actionId,
      END_MONITORING_ACTION
    );
  });

  it("offers Make adult only on the sheet's roster_drift", () => {
    const f = rosterFinding(every[3]!, names);
    assert.equal(
      lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey })?.actionId,
      MAKE_ADULT_ACTION
    );
    assert.equal(
      lifecycleAction({
        kind: "roster_drift",
        dedupe_key: "roster_drift:U1:student:adult",
      }),
      null
    );
  });

  it("offers nothing on a conflict or anything else", () => {
    const f = rosterFinding(every[4]!, names);
    assert.equal(
      lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey }),
      null
    );
    assert.equal(
      lifecycleAction({ kind: "adult_student_dm", dedupe_key: "x" }),
      null
    );
  });
});
