import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addYears, daysBetween, today } from "../src/domain/dates.js";
import type { Person, Role } from "../src/domain/people.js";
import { consentStatus, mayHoldAccount } from "../src/domain/rules/consent.js";
import {
  isScreenedAdult,
  latestAnnualExpiry,
  screeningEntryErrors,
  screeningStatus,
} from "../src/domain/rules/screening.js";
import { classifyConversation } from "../src/domain/rules/dmPolicy.js";
import { evaluateTwoAdultRule } from "../src/domain/rules/twoAdults.js";

let nextId = 1;

function person(role: Role, overrides: Partial<Person> = {}): Person {
  const id = nextId++;
  return {
    id,
    person_id: null,
    slack_user_id: `U${String(id).padStart(3, "0")}`,
    email: `p${id}@example.org`,
    full_name: `Person ${id}`,
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

/** Current on everything FIRST and Massachusetts require, as expiry dates. */
function screened(role: Role = "adult"): Person {
  return person(role, {
    screening_expires_on: "2027-01-15",
    training_expires_on: "2027-08-01",
    cori_expires_on: "2027-06-01",
  });
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
  const student = (expires: string | null) =>
    person("student", { slack_consent_expires_on: expires });

  it("is not required of adults", () => {
    assert.equal(
      consentStatus(person("adult"), "2026-08-12").state,
      "not_required"
    );
  });

  it("is missing when the sheet has no Slack Consent Expiry", () => {
    const status = consentStatus(student(null), "2026-08-12");
    assert.equal(status.state, "missing");
    assert.equal(mayHoldAccount(status), false);
  });

  it("is valid through the expiry date itself, and not a day after", () => {
    const s = student("2027-08-01");
    assert.equal(consentStatus(s, "2027-08-01").state, "valid");
    assert.equal(mayHoldAccount(consentStatus(s, "2027-08-01")), true);
    assert.equal(consentStatus(s, "2027-08-02").state, "expired");
    assert.equal(mayHoldAccount(consentStatus(s, "2027-08-02")), false);
  });

  it("reads a withdrawal as the date cleared or moved into the past", () => {
    assert.equal(consentStatus(student(null), "2026-09-28").state, "missing");
    assert.equal(
      consentStatus(student("2026-09-01"), "2026-09-28").state,
      "expired"
    );
  });

  it("uses the date as the sheet has it, computing nothing", () => {
    // Signed in September, runs to the next 1 August like every annual item.
    const status = consentStatus(student("2027-08-01"), "2026-09-28");
    assert.deepEqual(status, { state: "valid", expiresOn: "2027-08-01" });
  });
});

describe("screening", () => {
  const AS_OF = "2026-09-26";

  it("reads expiry dates as given, valid through the day itself", () => {
    const p = person("adult", {
      screening_expires_on: "2029-01-01",
      training_expires_on: "2027-08-01",
      cori_expires_on: "2028-01-01",
    });
    assert.equal(screeningStatus(p, "2027-08-01").current, true);
    assert.deepEqual(screeningStatus(p, "2027-08-02").expired, [
      { item: "Youth Protection Training", expiredOn: "2027-08-01" },
    ]);
  });

  it("reports what was never recorded separately from what lapsed", () => {
    const p = person("adult", {
      screening_expires_on: "2026-01-01",
      training_expires_on: null,
      cori_expires_on: null,
    });
    const status = screeningStatus(p, AS_OF);
    assert.deepEqual(status.missing, [
      "Youth Protection Training",
      "CORI + fingerprints",
    ]);
    assert.deepEqual(status.expired, [
      { item: "Background Screening", expiredOn: "2026-01-01" },
    ]);
  });

  /**
   * FRC2713/hawk-mod#17. FIRST renews the background screening at 36
   * months; a screening expiry further out than that is a typo, and a typo
   * must not extend someone's clearance.
   */
  it("refuses a screening expiry more than three years out", () => {
    const ok = screened();
    ok.screening_expires_on = "2029-09-26";
    assert.equal(screeningStatus(ok, AS_OF).current, true);

    const typo = screened();
    typo.screening_expires_on = "2029-09-27";
    const status = screeningStatus(typo, AS_OF);
    assert.equal(status.current, false);
    assert.deepEqual(status.implausible, [
      { item: "Background Screening", expiresOn: "2029-09-27" },
    ]);
    assert.equal(isScreenedAdult(typo, AS_OF), false);
  });

  it("refuses an annual expiry beyond the next season", () => {
    // On 26 Sep 2026 the latest real training expiry is 1 Aug 2028: the next
    // rollover, plus one season for training counted toward the following one.
    const p = screened();
    p.training_expires_on = "2028-08-01";
    assert.equal(screeningStatus(p, AS_OF).current, true);
    p.training_expires_on = "2029-08-01";
    assert.equal(screeningStatus(p, AS_OF).current, false);
  });

  it("finds the rollover on the right side of 1 August", () => {
    assert.equal(latestAnnualExpiry("2026-07-31"), "2027-08-01");
    assert.equal(latestAnnualExpiry("2026-08-01"), "2028-08-01");
    assert.equal(latestAnnualExpiry("2026-09-26"), "2028-08-01");
  });

  /**
   * Consent & Release is registration, Data Privacy is data handling, and
   * Mentor Ready is encouraged rather than required. Blocking on any of them
   * would flag adults who have done everything the safety rules ask.
   */
  it("reports Consent & Release, Data Privacy and Mentor Ready, never blocks", () => {
    const p = screened();
    p.consent_release_expires_on = "2026-08-01";
    const status = screeningStatus(p, AS_OF);
    assert.equal(status.current, true);
    assert.deepEqual(status.optionalOutstanding, [
      "Consent & Release",
      "Data Privacy for Mentors",
      "Mentor Ready",
    ]);
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

describe("recording screening dates", () => {
  const AS_OF = "2026-09-26";

  it("accepts an expiry in the past: recording a lapse is legitimate", () => {
    assert.deepEqual(
      screeningEntryErrors({ training_expires_on: "2025-08-01" }, AS_OF),
      {}
    );
  });

  it("refuses an expiry further out than the item lasts", () => {
    const errors = screeningEntryErrors(
      {
        training_expires_on: "2030-08-01",
        screening_expires_on: "2031-01-01",
        cori_expires_on: "2029-09-26",
      },
      AS_OF
    );
    assert.deepEqual(Object.keys(errors).sort(), [
      "screening_expires_on",
      "training_expires_on",
    ]);
  });

  it("refuses a Mentor Ready completion in the future", () => {
    assert.ok(
      screeningEntryErrors({ mentor_ready_completed_on: "2026-09-27" }, AS_OF)
        .mentor_ready_completed_on
    );
  });
});

describe("today", () => {
  it("is the date in the team's timezone, not UTC", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 9:30pm Eastern on 26 Sep is already 27 Sep in UTC.
      assert.equal(today(new Date("2026-09-27T01:30:00Z")), "2026-09-26");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
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
