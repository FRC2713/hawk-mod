import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import {
  planSlackIds,
  type SlackAccount,
} from "../src/domain/lifecycle/slackIds.js";
import { guardWrites, type CellWrite } from "../src/google/sheets.js";

let row = 2;

function mentor(
  personId: string,
  rhrEmail: string | null,
  slackUserId: string | null = null
): SheetPerson {
  return {
    personId,
    name: personId,
    personalEmail: null,
    status: "active",
    roles: ["Mentor"],
    mentor: {
      row: row++,
      rhrEmail,
      slackUserId,
      yptExpiry: null,
      screeningExpiry: null,
      coriExpiry: null,
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

function student(
  personId: string,
  schoolEmail: string | null,
  slackUserId: string | null = null
): SheetPerson {
  return {
    personId,
    name: personId,
    personalEmail: null,
    status: "active",
    roles: ["Student"],
    mentor: null,
    student: {
      row: row++,
      schoolEmail,
      slackUserId,
      lead: false,
      slackConsentExpiry: null,
    },
    adminRoles: [],
    parentEmails: [],
  };
}

const account = (
  id: string,
  email: string | null,
  live = true
): SlackAccount => ({
  id,
  email,
  live,
});

const kinds = (people: SheetPerson[], accounts: SlackAccount[]) =>
  planSlackIds(people, accounts).map((d) => [d.personId, d.kind]);

describe("Slack ID write-back", () => {
  it("fills a blank cell from an exact email match", () => {
    const [d] = planSlackIds(
      [mentor("P0010", "ana@redhawkrobotics.org")],
      [account("U1", "Ana@RedHawkRobotics.org")]
    );
    assert.equal(d?.kind, "write");
    assert.equal(d?.kind === "write" && d.slackUserId, "U1");
    assert.equal(d?.tab, "Mentor_Details");
  });

  it("matches a student by school email, into Student_Details", () => {
    const [d] = planSlackIds(
      [student("P0020", "kid@school.example")],
      [account("U2", "kid@school.example")]
    );
    assert.equal(d?.kind, "write");
    assert.equal(d?.tab, "Student_Details");
  });

  it("leaves a correct cell alone", () => {
    assert.deepEqual(
      kinds(
        [mentor("P0010", "ana@redhawkrobotics.org", "U1")],
        [account("U1", "ana@redhawkrobotics.org")]
      ),
      [["P0010", "unchanged"]]
    );
  });

  it("reports someone with no Slack account, and writes nothing", () => {
    assert.deepEqual(kinds([mentor("P0010", "ana@redhawkrobotics.org")], []), [
      ["P0010", "not_in_slack"],
    ]);
  });

  it("never matches a deactivated account or a bot", () => {
    assert.deepEqual(
      kinds(
        [mentor("P0010", "ana@redhawkrobotics.org")],
        [account("U1", "ana@redhawkrobotics.org", false)]
      ),
      [["P0010", "not_in_slack"]]
    );
  });

  it("never overwrites an ID that disagrees with the match", () => {
    const [d] = planSlackIds(
      [mentor("P0010", "ana@redhawkrobotics.org", "U9")],
      [account("U1", "ana@redhawkrobotics.org"), account("U9", "other@x.org")]
    );
    assert.equal(d?.kind, "conflict");
    assert.equal(
      d?.kind === "conflict" && d.reason,
      "the email matches a different Slack account"
    );
  });

  it("reports a recorded ID whose account is gone", () => {
    const [d] = planSlackIds(
      [mentor("P0010", "ana@redhawkrobotics.org", "U9")],
      [account("U9", "ana@redhawkrobotics.org", false)]
    );
    assert.equal(
      d?.kind === "conflict" && d.reason,
      "the recorded Slack ID is not an active Slack account"
    );
  });

  it("reports a hand-entered ID whose account has another email", () => {
    const [d] = planSlackIds(
      [mentor("P0010", "ana@redhawkrobotics.org", "U9")],
      [account("U9", "ana.personal@gmail.example")]
    );
    assert.equal(
      d?.kind === "conflict" && d.reason,
      "the recorded Slack account has a different email"
    );
  });

  it("writes neither row when one address is typed for two people", () => {
    assert.deepEqual(
      kinds(
        [
          mentor("P0010", "ana@redhawkrobotics.org"),
          mentor("P0011", "ana@redhawkrobotics.org"),
        ],
        [account("U1", "ana@redhawkrobotics.org")]
      ),
      [
        ["P0010", "conflict"],
        ["P0011", "conflict"],
      ]
    );
  });

  it("will not hand out an ID another row already holds", () => {
    assert.deepEqual(
      kinds(
        [
          mentor("P0010", "ana@redhawkrobotics.org"),
          mentor("P0011", "ben@redhawkrobotics.org", "U1"),
        ],
        [account("U1", "ana@redhawkrobotics.org")]
      ),
      [
        ["P0010", "conflict"],
        ["P0011", "conflict"],
      ]
    );
  });
});

describe("guarded sheet writes", () => {
  const write = (personId: string, row: number): CellWrite => ({
    tab: "Mentor_Details",
    row,
    header: "Slack User ID",
    personId,
    value: "U1",
  });

  // Row 1 is the header; each array is a column from row 1 down.
  const sheetNow =
    (ids: string[], slack: string[]) => (_tab: string, header: string) =>
      header === "Person ID"
        ? ["Person ID", ...ids]
        : ["Slack User ID", ...slack];

  it("writes when the row still belongs to the same person and is blank", () => {
    const { ok, skipped } = guardWrites(
      [write("P0010", 2)],
      sheetNow(["P0010"], [""])
    );
    assert.equal(ok.length, 1);
    assert.equal(skipped.length, 0);
  });

  it("skips a row that someone sorted or inserted above", () => {
    // Planned when P0010 was on row 2; someone has since inserted P0011.
    const { ok, skipped } = guardWrites(
      [write("P0010", 2)],
      sheetNow(["P0011", "P0010"], ["", ""])
    );
    assert.equal(ok.length, 0);
    assert.equal(skipped[0]?.reason, "the row now holds someone else");
  });

  it("skips a cell someone filled in meanwhile", () => {
    const { skipped } = guardWrites(
      [write("P0010", 2)],
      sheetNow(["P0010"], ["U7"])
    );
    assert.equal(skipped[0]?.reason, "the cell is no longer blank");
  });

  it("skips a row that no longer exists", () => {
    const { skipped } = guardWrites(
      [write("P0010", 5)],
      sheetNow(["P0010"], [])
    );
    assert.equal(skipped.length, 1);
  });
});
