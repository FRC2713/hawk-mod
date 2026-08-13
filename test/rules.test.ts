import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addYears, daysBetween } from "../src/domain/dates.js";
import type { Person, Role } from "../src/domain/people.js";
import {
  consentStatus,
  mayHoldAccount,
  type Consent,
} from "../src/domain/rules/consent.js";
import {
  isScreenedAdult,
  screeningStatus,
} from "../src/domain/rules/screening.js";
import { classifyConversation } from "../src/domain/rules/dmPolicy.js";
import { evaluateTwoAdultRule } from "../src/domain/rules/twoAdults.js";

let nextId = 1;

function person(role: Role, overrides: Partial<Person> = {}): Person {
  const id = nextId++;
  return {
    id,
    slack_user_id: `U${String(id).padStart(3, "0")}`,
    email: `p${id}@example.org`,
    full_name: `Person ${id}`,
    role,
    active: 1,
    ypp_completed_on: null,
    ypt_completed_on: null,
    mentor_ready_on: null,
    cori_completed_on: null,
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Current on everything FIRST and Massachusetts require. */
function screened(role: Role = "adult"): Person {
  return person(role, {
    ypp_completed_on: "2024-01-15",
    ypt_completed_on: "2026-01-15",
    cori_completed_on: "2024-06-01",
  });
}

function consent(personId: number, overrides: Partial<Consent> = {}): Consent {
  return {
    id: nextId++,
    person_id: personId,
    signed_on: "2026-02-01",
    expires_on: "2027-02-01",
    form_version: "2026.1",
    guardian_name: "Guardian",
    guardian_email: null,
    document_ref: null,
    recorded_by: "test",
    revoked_on: null,
    created_at: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("dates", () => {
  it("keeps a Feb 29 anniversary inside February", () => {
    assert.equal(addYears("2024-02-29", 1), "2025-02-28");
    assert.equal(addYears("2024-02-29", 4), "2028-02-29");
  });

  it("adds plain years", () => {
    assert.equal(addYears("2026-06-01", 3), "2029-06-01");
    assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30);
  });
});

describe("consent", () => {
  it("is not required of adults", () => {
    const adult = person("adult");
    assert.equal(consentStatus(adult, [], "2026-08-12").state, "not_required");
  });

  it("is missing when no form was ever filed", () => {
    const student = person("student");
    const status = consentStatus(student, [], "2026-08-12");
    assert.equal(status.state, "missing");
    assert.equal(mayHoldAccount(status), false);
  });

  it("expires a year after signature", () => {
    const student = person("student");
    const c = consent(student.id, {
      signed_on: "2025-03-01",
      expires_on: "2026-03-01",
    });
    assert.equal(consentStatus(student, [c], "2026-02-28").state, "valid");
    assert.equal(consentStatus(student, [c], "2026-03-02").state, "expired");
  });

  it("takes the most recent signature, not the first one found", () => {
    const student = person("student");
    const old = consent(student.id, {
      signed_on: "2025-03-01",
      expires_on: "2026-03-01",
    });
    const fresh = consent(student.id, {
      signed_on: "2026-03-01",
      expires_on: "2027-03-01",
    });
    const status = consentStatus(student, [old, fresh], "2026-08-12");
    assert.equal(status.state, "valid");
    assert.equal(mayHoldAccount(status), true);
  });

  it("honours a revocation", () => {
    const student = person("student");
    const c = consent(student.id, { revoked_on: "2026-05-01" });
    assert.equal(consentStatus(student, [c], "2026-08-12").state, "revoked");
  });

  it("ignores consents belonging to somebody else", () => {
    const student = person("student");
    const other = person("student");
    assert.equal(
      consentStatus(student, [consent(other.id)], "2026-08-12").state,
      "missing"
    );
  });
});

describe("screening", () => {
  it("expires training annually and CORI after three years", () => {
    const p = person("adult", {
      ypp_completed_on: "2024-01-01",
      ypt_completed_on: "2025-01-01",
      cori_completed_on: "2023-01-01",
    });
    const status = screeningStatus(p, "2026-08-12");
    assert.equal(status.current, false);
    assert.deepEqual(status.expired.map((e) => e.item).sort(), [
      "CORI + fingerprints",
      "Youth Protection Training",
    ]);
  });

  it("keeps the background screening valid longer than the training", () => {
    const p = person("adult", {
      ypp_completed_on: "2024-01-01",
      ypt_completed_on: "2026-01-01",
      cori_completed_on: "2024-01-01",
    });
    assert.equal(screeningStatus(p, "2026-08-12").current, true);
  });

  /**
   * Mentor Ready is optional per FIRST — a path whose Youth Protection
   * Training component is the only part required for clearance. Requiring it
   * would block adults who have done everything actually asked of them.
   */
  it("does not require Mentor Ready to count as screened", () => {
    const p = person("adult", {
      ypp_completed_on: "2024-01-01",
      ypt_completed_on: "2026-01-01",
      cori_completed_on: "2024-01-01",
      mentor_ready_on: null,
    });
    const status = screeningStatus(p, "2026-08-12");
    assert.equal(status.current, true);
    assert.deepEqual(status.optionalOutstanding, ["Mentor Ready"]);
  });

  it("reports what was never recorded separately from what lapsed", () => {
    const p = person("adult", { ypp_completed_on: "2026-01-01" });
    const status = screeningStatus(p, "2026-08-12");
    assert.deepEqual(status.missing.sort(), [
      "CORI + fingerprints",
      "Youth Protection Training",
    ]);
    assert.equal(status.expired.length, 0);
  });

  it("does not count students, inactive people, or unknown accounts as adults", () => {
    assert.equal(isScreenedAdult(screened("adult"), "2026-08-12"), true);
    assert.equal(isScreenedAdult(person("student"), "2026-08-12"), false);
    assert.equal(isScreenedAdult({ slackUserId: "U999" }, "2026-08-12"), false);
    const inactive = screened("adult");
    inactive.active = 0;
    assert.equal(isScreenedAdult(inactive, "2026-08-12"), false);
  });
});

describe("DM policy", () => {
  const asOf = "2026-08-12";

  it("ignores conversations with no student in them", () => {
    const verdict = classifyConversation("im", [screened(), screened()], asOf);
    assert.equal(verdict.monitored, false);
    assert.equal(verdict.violation, null);
  });

  it("flags any 1:1 between an adult and a student", () => {
    const verdict = classifyConversation(
      "im",
      [screened(), person("student")],
      asOf
    );
    assert.equal(verdict.monitored, true);
    assert.equal(verdict.violation, "one_to_one_adult_student");
    assert.equal(verdict.severity, "violation");
  });

  it("flags a 1:1 even when the adult is fully screened and senior", () => {
    const verdict = classifyConversation(
      "im",
      [screened("district_observer"), person("student")],
      asOf
    );
    assert.equal(verdict.violation, "one_to_one_adult_student");
  });

  it("allows a group DM with two screened adults", () => {
    const verdict = classifyConversation(
      "mpim",
      [screened(), screened(), person("student")],
      asOf
    );
    assert.equal(verdict.monitored, true);
    assert.equal(verdict.violation, null);
  });

  it("flags a group DM whose second adult is unscreened", () => {
    const verdict = classifyConversation(
      "mpim",
      [screened(), person("adult"), person("student")],
      asOf
    );
    assert.equal(verdict.violation, "group_without_second_adult");
  });

  it("treats an account that is not on the roster as a violation", () => {
    const verdict = classifyConversation(
      "mpim",
      [screened(), screened(), person("student"), { slackUserId: "U999" }],
      asOf
    );
    assert.equal(verdict.violation, "unknown_participant_with_student");
  });

  it("does not record student-only conversations at all", () => {
    const verdict = classifyConversation(
      "mpim",
      [person("student"), person("student"), person("student")],
      asOf
    );
    assert.equal(verdict.monitored, false);
    assert.equal(verdict.violation, null);
  });

  it("does not record a 1:1 between two students", () => {
    const verdict = classifyConversation(
      "im",
      [person("student"), person("student")],
      asOf
    );
    assert.equal(verdict.monitored, false);
    assert.equal(verdict.violation, null);
  });

  it("records any:any once one adult and one student are both present", () => {
    const verdict = classifyConversation(
      "mpim",
      [
        screened(),
        screened(),
        screened("district_observer"),
        person("student"),
        person("student"),
        person("student"),
      ],
      asOf
    );
    assert.equal(verdict.monitored, true);
    assert.equal(verdict.violation, null);
    assert.equal(verdict.studentIds.length, 3);
    assert.equal(verdict.adultIds.length, 3);
  });
});

describe("two screened adults", () => {
  const asOf = "2026-08-12";

  it("passes a channel with no students regardless of screening", () => {
    const result = evaluateTwoAdultRule(
      {
        channelId: "C1",
        channelName: "adults",
        isPrivate: true,
        members: [person("adult")],
      },
      asOf
    );
    assert.equal(result.ok, true);
  });

  it("fails a student channel with a single screened adult", () => {
    const result = evaluateTwoAdultRule(
      {
        channelId: "C2",
        channelName: "build",
        isPrivate: false,
        members: [screened(), person("adult"), person("student")],
      },
      asOf
    );
    assert.equal(result.ok, false);
    assert.equal(result.screenedAdultIds.length, 1);
    assert.equal(result.unscreenedAdultIds.length, 1);
  });

  it("passes a student channel with two screened adults", () => {
    const result = evaluateTwoAdultRule(
      {
        channelId: "C3",
        channelName: "build",
        isPrivate: false,
        members: [screened(), screened("district_observer"), person("student")],
      },
      asOf
    );
    assert.equal(result.ok, true);
    assert.equal(result.studentCount, 1);
  });
});
