import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  labelOf,
  personLabel,
  personLabels,
  shortName,
  shortNameOf,
} from "../src/domain/lifecycle/labels.js";
import { planLifecycle } from "../src/domain/lifecycle/plan.js";
import { formatPlan } from "../src/domain/lifecycle/planReport.js";
import {
  SHEET_TABS,
  type Header,
  type SheetData,
  type SheetRow,
  type SheetTab,
} from "../src/domain/lifecycle/schema.js";
import { parseSheet } from "../src/domain/lifecycle/sheet.js";
import { formatSlackIds } from "../src/domain/lifecycle/slackIds.js";

/**
 * How every lifecycle preview names a person (#74): Person ID, short name and
 * role, `P0101 Alex S. (Student)`. The short name is enough to spot the wrong
 * person, and the Person ID still says exactly who. Never a full name, never
 * an address. (Names here are made up.)
 */

function row<T extends SheetTab>(
  tab: T,
  n: number,
  values: Partial<Record<Header<T>, string>>
): SheetRow<T> {
  const blank = Object.fromEntries(SHEET_TABS[tab].map((h) => [h, ""]));
  return { ...blank, ...values, _row: n } as SheetRow<T>;
}

/** One People row per entry, each a Student with a School Email. */
function sheet(people: Partial<Record<Header<"People">, string>>[]): SheetData {
  return {
    People: people.map((p, i) =>
      row("People", i + 2, { "Active/Inactive": "Active", ...p })
    ),
    People_Roles: people.map((p, i) =>
      row("People_Roles", i + 2, {
        "Person ID": p["Person ID"],
        Role: "Student",
      })
    ),
    Mentor_Details: [],
    Mentor_Admin_Roles: [],
    Student_Details: people.map((p, i) =>
      row("Student_Details", i + 2, {
        "Person ID": p["Person ID"],
        "School Email": `s${i}@school.example`,
      })
    ),
    Emergency_Contacts: [],
  };
}

describe("a short name", () => {
  it("is the first name and the last name's initial", () => {
    assert.equal(shortName("Alex", "Samplewood"), "Alex S.");
  });

  it("takes the initial of a last name of several words from its first", () => {
    assert.equal(shortName("Maren", "Van Der Berg"), "Maren V.");
    assert.equal(shortName("Lucía", "García López"), "Lucía G.");
  });

  it("skips punctuation and capitalises the initial", () => {
    assert.equal(shortName("Pat", "O'Brien"), "Pat O.");
    assert.equal(shortName("Wim", "'t Hooft"), "Wim T.");
    assert.equal(shortName("Ana", "de la Cruz"), "Ana D.");
  });

  it("is the first name alone with no last name, the initial alone with no first", () => {
    assert.equal(shortName("Alex", ""), "Alex");
    assert.equal(shortName("", "Samplewood"), "S.");
  });

  it("is null with no name at all", () => {
    assert.equal(shortName("", ""), null);
    assert.equal(shortName("  ", " "), null);
  });

  it("is cut down as well as can be from a combined roster name", () => {
    assert.equal(shortNameOf("Alex Samplewood"), "Alex S.");
    // The word after the first: right for a last name of several words.
    assert.equal(shortNameOf("Maren Van Der Berg"), "Maren V.");
    assert.equal(shortNameOf("Alex"), "Alex");
    assert.equal(shortNameOf(""), null);
    assert.equal(shortNameOf(null), null);
  });
});

describe("the sheet parse", () => {
  const parsed = parseSheet(
    sheet([
      {
        "Person ID": "P0101",
        "Legal First Name": "Alexandra",
        "Preferred First Name": "Alex",
        "Legal Last Name": "Samplewood",
      },
      {
        "Person ID": "P0102",
        "Legal First Name": "Jordan",
        "Legal Last Name": "Van Der Berg",
      },
      { "Person ID": "P0103", "Legal First Name": "Casey" },
      { "Person ID": "P0104" },
    ])
  );
  const short = (id: string) =>
    parsed.people.find((p) => p.personId === id)?.shortName;

  it("prefers the preferred first name, else the legal one", () => {
    assert.equal(short("P0101"), "Alex S.");
    assert.equal(short("P0102"), "Jordan V.");
  });

  it("builds it from the cells, not the combined name", () => {
    // `name` is one string; splitting it on spaces would give `B.` here.
    const p = parsed.people.find((x) => x.personId === "P0102")!;
    assert.equal(p.name, "Jordan Van Der Berg");
    assert.equal(p.shortName, "Jordan V.");
  });

  it("has no last initial with no last name, and nothing with no name", () => {
    assert.equal(short("P0103"), "Casey");
    // The parse falls back to the Person ID as the name; the short name does
    // not, so a label never prints the ID twice.
    assert.equal(short("P0104"), null);
    assert.equal(personLabels(parsed.people).get("P0104"), "P0104 (Student)");
  });
});

describe("a label", () => {
  it("is the Person ID, short name and every role", () => {
    assert.equal(
      personLabel("P0101", "Alex S.", ["Student"]),
      "P0101 Alex S. (Student)"
    );
    assert.equal(
      personLabel("P0101", "Alex S.", ["Mentor", "Alumni"]),
      "P0101 Alex S. (Mentor, Alumni)"
    );
    assert.equal(personLabel("P0101", null, []), "P0101");
  });

  it("names someone the sheet no longer has from a fallback name, with no role", () => {
    const labels = personLabels([
      { personId: "P0101", shortName: "Alex S.", roles: ["Student"] },
    ]);
    assert.equal(
      labelOf(labels, "P0101", "Ignored Name"),
      "P0101 Alex S. (Student)"
    );
    assert.equal(labelOf(labels, "P0199", "Finley Rowe"), "P0199 Finley R.");
    assert.equal(labelOf(labels, "P0199"), "P0199");
  });
});

describe("the lifecycle plan and slack-ids reports", () => {
  const parsed = parseSheet(
    sheet([
      {
        "Person ID": "P0101",
        "Legal First Name": "Alex",
        "Legal Last Name": "Samplewood",
      },
    ])
  );
  const labels = personLabels(parsed.people);

  it("name people in the plan's lists, and no address without --members", () => {
    // A sheet problem names its person the same way.
    const withProblem = parseSheet(
      sheet([
        {
          "Person ID": "P0101",
          "Legal First Name": "Alex",
          "Legal Last Name": "Samplewood",
          "Personal Email": "not an address",
        },
      ])
    );
    const text = formatPlan(
      planLifecycle(withProblem, "2026-11-10"),
      personLabels(withProblem.people),
      false
    );
    assert.match(
      text,
      /People row 2, P0101 Alex S\. \(Student\): Personal Email is not an email address/
    );
    assert.ok(!text.includes("Samplewood"), text);
    assert.ok(!text.includes("@"), text);
    assert.match(
      formatPlan(planLifecycle(parsed, "2026-11-10"), labels, true),
      /s0@school\.example/
    );
  });

  it("name people in the slack-ids report, by cell", () => {
    const lines = formatSlackIds(
      [
        {
          kind: "write",
          personId: "P0101",
          tab: "Student_Details",
          row: 2,
          slackUserId: "U0101",
        },
      ],
      labels
    );
    assert.ok(
      lines.includes(
        "  P0101 Alex S. (Student), Student_Details row 2 -> U0101"
      ),
      lines.join("\n")
    );
    assert.ok(!lines.join("\n").includes("Samplewood"));
  });
});
