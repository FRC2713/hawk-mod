import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import {
  formatSlackCopies,
  type ReadCopy,
} from "../src/domain/lifecycle/slackGroupReport.js";
import {
  decideSlackCopies,
  planSlackCopies,
  type FoundSlackGroup,
  type SlackCopy,
} from "../src/domain/lifecycle/slackGroups.js";

/**
 * What `/hawkmod lifecycle slack-groups` prints: who would be added, removed
 * or held, each group's default channels, and — while SLACK_GROUP_IDS is
 * empty — every user group in Slack with its ID.
 */

const AS_OF = "2026-09-28";

function student(personId: string): SheetPerson {
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
      slackUserId: null,
      lead: false,
      slackConsentExpiry: null,
    },
    adminRoles: [],
    parentEmails: [],
  };
}

const people = [
  student("P0020"),
  student("P0021"),
  { ...student("P0022"), status: "inactive" as const },
];
const slackIds = new Map([
  ["P0020", "U0020"],
  ["P0021", "U0021"],
  ["P0022", "U0022"],
]);

function report(opts: {
  read: Partial<Record<SlackCopy, ReadCopy>>;
  found?: Partial<Record<SlackCopy, FoundSlackGroup>>;
  disabled?: SlackCopy[];
}) {
  const plans = planSlackCopies({
    people,
    slackIds,
    actual: { "grp-students": ["U0020", "U0022", "UOTHER"] },
    asOf: AS_OF,
  });
  return formatSlackCopies({
    plans,
    decisions: decideSlackCopies({ plans, found: opts.found ?? {} }),
    read: opts.read,
    disabled: new Set(opts.disabled ?? []),
    workspace: [
      {
        id: "S0STUDENTS",
        handle: "students",
        name: "Students",
        disabled: false,
      },
      { id: "S0OLD", handle: "old-team", name: "Old team", disabled: true },
    ],
    names: new Map(people.map((p) => [p.personId, p.name])),
    accounts: new Map([["UOTHER", "Someone Else"]]),
    dryRun: true,
  });
}

const students: ReadCopy = {
  id: "S0STUDENTS",
  handle: "students",
  count: 3,
  channels: ["#general (C0GENERAL)", "#students (C0STUDENTS)"],
  byHandle: true,
};

describe("the Slack groups dry run", () => {
  const text = report({ read: { "grp-students": students } });

  it("names who would be added and who is held, and why", () => {
    assert.match(text, /Would add: 1\n {6}P0021 Student P0021/);
    assert.match(text, /P0022 Student P0022: Inactive on the sheet/);
    assert.match(text, /Someone Else \(UOTHER\): not on the sheet/);
    assert.match(text, /Would add: 1 · would remove .*: 0 · held .*: 2/);
  });

  it("shows each group's default channels by name and ID", () => {
    assert.match(
      text,
      /Default channels: #general \(C0GENERAL\), #students \(C0STUDENTS\)/
    );
  });

  it("says a group found by handle has no ID yet, and lists Slack's groups", () => {
    assert.match(text, /NO ID YET: .*Put S0STUDENTS in SLACK_GROUP_IDS/);
    assert.match(text, /@students {2}S0STUDENTS {2}Students/);
    assert.match(text, /@old-team {2}S0OLD {2}Old team {2}\(disabled\)/);
  });

  it("never lets a group found by handle be applied", () => {
    const plans = planSlackCopies({
      people,
      slackIds,
      actual: { "grp-students": ["U0020"] },
      asOf: AS_OF,
    });
    const d = decideSlackCopies({ plans, found: {} }).find(
      (x) => x.copy === "grp-students"
    );
    assert.equal(d?.kind === "held" && d.why, "missing");
  });

  it("reports copies Slack has no group for, and disabled ones", () => {
    const t = report({ read: {}, disabled: ["grp-mentors"] });
    assert.match(t, /@students \(grp-students\): no ID yet .* skipped/);
    assert.match(t, /@mentors \(grp-mentors\): disabled in Slack/);
    assert.match(t, /Would add: 0/);
  });

  it("flags an ID that leads to a group with another handle", () => {
    const t = report({
      read: {
        "grp-students": { ...students, handle: "mentors", byHandle: false },
      },
      found: { "grp-students": { id: "S0STUDENTS", handle: "mentors" } },
    });
    assert.match(t, /WRONG GROUP: its ID belongs to @mentors, not @students/);
  });

  it("says a group with no default channels has none", () => {
    const t = report({
      read: { "grp-students": { ...students, channels: [] } },
    });
    assert.match(t, /Default channels: none/);
  });
});
