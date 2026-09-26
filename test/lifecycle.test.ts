import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addresses, intendedGroups } from "../src/domain/lifecycle/groups.js";
import { planLifecycle } from "../src/domain/lifecycle/plan.js";
import {
  locateHeaders,
  SHEET_TABS,
  type Header,
  type SheetData,
  type SheetRow,
  type SheetTab,
} from "../src/domain/lifecycle/schema.js";
import { parseSheet } from "../src/domain/lifecycle/sheet.js";
import { columnLetter } from "../src/google/sheets.js";

const AS_OF = "2026-09-25";

/** A row with every allowlisted column blank except the ones given. */
function row<T extends SheetTab>(
  tab: T,
  n: number,
  values: Partial<Record<Header<T>, string>>
): SheetRow<T> {
  const blank = Object.fromEntries(SHEET_TABS[tab].map((h) => [h, ""]));
  return { ...blank, ...values, _row: n } as SheetRow<T>;
}

type Spec = {
  id: string;
  status?: string;
  roles?: string[];
  mentor?: Partial<Record<Header<"Mentor_Details">, string>>;
  student?: Partial<Record<Header<"Student_Details">, string>>;
  personalEmail?: string;
};

const CLEARED = {
  "YPT Expiry": "2027-08-01",
  "Background Screening Expiry": "2028-05-01",
  "CORI Expiry": "2028-01-01",
};

/** Builds all five tabs from a list of people, one row each where needed. */
function sheet(...specs: Spec[]): SheetData {
  const data: SheetData = {
    People: [],
    People_Roles: [],
    Mentor_Details: [],
    Mentor_Admin_Roles: [],
    Student_Details: [],
  };
  specs.forEach((s, i) => {
    const n = i + 2;
    data.People.push(
      row("People", n, {
        "Person ID": s.id,
        "Legal First Name": `First${s.id}`,
        "Legal Last Name": `Last${s.id}`,
        "Personal Email": s.personalEmail ?? "",
        "Active/Inactive": s.status ?? "Active",
      })
    );
    for (const r of s.roles ?? []) {
      data.People_Roles.push(
        row("People_Roles", data.People_Roles.length + 2, {
          "Person ID": s.id,
          Role: r,
        })
      );
    }
    if (s.mentor) {
      data.Mentor_Details.push(
        row("Mentor_Details", data.Mentor_Details.length + 2, {
          "Person ID": s.id,
          "RHR Email": `${s.id.toLowerCase()}@redhawkrobotics.org`,
          ...s.mentor,
        })
      );
    }
    if (s.student) {
      data.Student_Details.push(
        row("Student_Details", data.Student_Details.length + 2, {
          "Person ID": s.id,
          "School Email": `${s.id.toLowerCase()}@school.example`,
          ...s.student,
        })
      );
    }
  });
  return data;
}

const mentor = (id: string, extra: Spec["mentor"] = {}): Spec => ({
  id,
  roles: ["Mentor"],
  mentor: { ...CLEARED, ...extra },
});

const student = (id: string, extra: Spec["student"] = {}): Spec => ({
  id,
  roles: ["Student"],
  student: extra,
});

describe("lifecycle sheet shape", () => {
  it("finds allowlisted headers wherever they are", () => {
    const { columns, problem } = locateHeaders("People_Roles", [
      "Notes",
      " Role ",
      "Person ID",
    ]);
    assert.equal(problem, null);
    assert.equal(columns.get("Role"), 1);
    assert.equal(columns.get("Person ID"), 2);
  });

  it("refuses a renamed column rather than reading it as blank", () => {
    // The rename this whole naming exercise was about: read as blank, the old
    // header would make every mentor unscreened.
    const headers = SHEET_TABS.Mentor_Details.map((h) =>
      h === "YPT Expiry" ? "YPP Expiry" : h
    );
    const { problem } = locateHeaders("Mentor_Details", headers);
    assert.deepEqual(problem?.missing, ["YPT Expiry"]);
  });

  it("refuses a header that appears twice", () => {
    const { problem } = locateHeaders("People_Roles", [
      "Person ID",
      "Role",
      "Role",
    ]);
    assert.deepEqual(problem?.duplicated, ["Role"]);
  });

  it("names columns past Z the way Sheets does", () => {
    assert.equal(columnLetter(0), "A");
    assert.equal(columnLetter(25), "Z");
    assert.equal(columnLetter(26), "AA");
    assert.equal(columnLetter(51), "AZ");
    assert.equal(columnLetter(52), "BA");
  });
});

describe("lifecycle sheet parsing", () => {
  it("reassembles a person from their tabs", () => {
    const { people, problems } = parseSheet(
      sheet(
        mentor("P0010", {
          "Mentor Lead (Y/N)": "Y",
          "Slack User ID": "U123ABC",
        })
      )
    );
    assert.deepEqual(problems, []);
    assert.equal(people.length, 1);
    const [p] = people;
    assert.equal(p!.status, "active");
    assert.deepEqual(p!.roles, ["Mentor"]);
    assert.equal(p!.mentor?.rhrEmail, "p0010@redhawkrobotics.org");
    assert.equal(p!.mentor?.slackUserId, "U123ABC");
    assert.equal(p!.mentor?.lead, true);
    assert.equal(p!.mentor?.ra, false);
  });

  it("maps YPT Expiry to training and Background Screening Expiry to screening", () => {
    const [p] = parseSheet(
      sheet(
        mentor("P0010", {
          "YPT Expiry": "2027-08-01",
          "Background Screening Expiry": "2029-03-01",
        })
      )
    ).people;
    assert.equal(p!.mentor?.yptExpiry, "2027-08-01");
    assert.equal(p!.mentor?.screeningExpiry, "2029-03-01");
  });

  it("ignores the sample people and says so", () => {
    const { people, problems } = parseSheet(
      sheet(mentor("P0001"), student("P0002"), mentor("P0010"))
    );
    assert.deepEqual(
      people.map((p) => p.personId),
      ["P0010"]
    );
    assert.ok(problems.some((p) => p.message.includes("sample people")));
  });

  it("reports a date that is not YYYY-MM-DD, and reads it as blank", () => {
    const { people, problems } = parseSheet(
      sheet(mentor("P0010", { "CORI Expiry": "8/1/2027" }))
    );
    assert.equal(people[0]!.mentor?.coriExpiry, null);
    assert.deepEqual(
      problems.map((p) => [p.personId, p.message]),
      [["P0010", "CORI Expiry is not a YYYY-MM-DD date"]]
    );
  });

  it("rejects an impossible date", () => {
    const { problems } = parseSheet(
      sheet(mentor("P0010", { "YPT Expiry": "2027-02-30" }))
    );
    assert.equal(problems.length, 1);
  });

  it("keeps an unknown Active/Inactive distinct from either answer", () => {
    const { people, problems } = parseSheet(
      sheet({ ...mentor("P0010"), status: "Activ" })
    );
    assert.equal(people[0]!.status, "unknown");
    assert.equal(problems.length, 1);
  });

  it("keeps the first of two rows for one Person ID", () => {
    const data = sheet(mentor("P0010"));
    data.People.push(
      row("People", 9, { "Person ID": "P0010", "Active/Inactive": "Inactive" })
    );
    const { people, problems } = parseSheet(data);
    assert.equal(people.length, 1);
    assert.equal(people[0]!.status, "active");
    assert.deepEqual(
      problems.map((p) => p.message),
      ["Person ID appears twice"]
    );
  });

  it("reports detail rows for people the People tab does not have", () => {
    const data = sheet(mentor("P0010"));
    data.Student_Details.push(
      row("Student_Details", 5, { "Person ID": "P0099" })
    );
    const { problems } = parseSheet(data);
    assert.deepEqual(
      problems.map((p) => [p.personId, p.message]),
      [["P0099", "Person ID is not on the People tab"]]
    );
  });

  it("flags a person who is both Student and Mentor", () => {
    const { problems } = parseSheet(
      sheet({
        id: "P0010",
        roles: ["Student", "Mentor"],
        mentor: CLEARED,
        student: {},
      })
    );
    assert.ok(problems.some((p) => p.message === "both Student and Mentor"));
  });

  it("never puts a cell's value in a problem", () => {
    const secret = "someone@private.example";
    const { problems } = parseSheet(
      sheet(mentor("P0010", { "RHR Email": `not an email ${secret}` }))
    );
    assert.ok(problems.length > 0);
    for (const p of problems) assert.ok(!p.message.includes(secret));
  });

  it("skips blank rows", () => {
    const data = sheet(mentor("P0010"));
    data.People.push(row("People", 20, {}));
    data.People_Roles.push(row("People_Roles", 20, {}));
    assert.deepEqual(parseSheet(data).problems, []);
  });
});

describe("computed groups", () => {
  const people = parseSheet(
    sheet(
      mentor("P0010", { "Mentor Lead (Y/N)": "Y", "RA (Y/N)": "Y" }),
      mentor("P0011", { "Background Screening Expiry": "" }),
      mentor("P0012", { "YPT Expiry": "2026-08-01" }),
      student("P0020", { "Student Lead (Y/N)": "Y" }),
      student("P0021"),
      { ...student("P0022"), status: "Inactive" },
      { ...student("P0023"), status: "" },
      {
        id: "P0030",
        roles: ["Volunteer"],
        personalEmail: "vol@example.org",
      },
      {
        id: "P0040",
        roles: ["Alumni", "Mentor"],
        mentor: CLEARED,
        personalEmail: "alum@example.org",
      }
    )
  ).people;
  const groups = intendedGroups(people);
  const ids = (name: keyof typeof groups) =>
    groups[name].map((p) => p.personId).sort();

  it("puts only active people in groups", () => {
    assert.deepEqual(ids("grp-students"), ["P0020", "P0021"]);
  });

  it("derives leads and RA from the flags", () => {
    assert.deepEqual(ids("grp-mentor-leads"), ["P0010"]);
    assert.deepEqual(ids("grp-student-leads"), ["P0020"]);
    assert.deepEqual(ids("grp-ra"), ["P0010"]);
  });

  it("puts uncleared mentors in grp-all-team too; screening gates Slack", () => {
    // P0011 has no screening on file; P0012's training lapsed on 1 August.
    // Both are on the mailing list; the plan lists them as not cleared.
    assert.deepEqual(ids("grp-all-team"), [
      "P0010",
      "P0011",
      "P0012",
      "P0020",
      "P0021",
      "P0040",
    ]);
    const plan = planLifecycle({ people, problems: [] }, AS_OF);
    assert.deepEqual(
      plan.notCleared.map((m) => m.personId),
      ["P0011", "P0012"]
    );
  });

  it("counts an expiry date as still valid on the day itself", () => {
    const { people } = parseSheet(
      sheet(mentor("P0010", { "YPT Expiry": AS_OF }))
    );
    assert.deepEqual(
      planLifecycle({ people, problems: [] }, AS_OF).notCleared,
      []
    );
  });

  it("leaves volunteers and alumni out of grp-all-team", () => {
    assert.deepEqual(ids("grp-volunteers"), ["P0030"]);
    assert.ok(!ids("grp-all-team").includes("P0030"));
  });

  it("addresses a mentor who is also an alum by their RHR email", () => {
    assert.deepEqual(addresses(groups["grp-alumni"]), [
      "p0040@redhawkrobotics.org",
    ]);
  });

  it("never adds a student by their personal email", () => {
    // A student with no school address is left out and reported. Their
    // personal inbox is never where hawk-mod adds them — not to a group, and
    // so not to Slack.
    const { people } = parseSheet(
      sheet(
        {
          ...student("P0050", { "School Email": "" }),
          personalEmail: "kid@home.example",
        },
        {
          ...student("P0051"),
          personalEmail: "other@home.example",
        }
      )
    );
    const intended = intendedGroups(people);
    assert.deepEqual(addresses(intended["grp-students"]), [
      "p0051@school.example",
    ]);
    for (const members of Object.values(intended)) {
      for (const a of addresses(members))
        assert.ok(!a.endsWith("home.example"));
    }
    const plan = planLifecycle(
      parseSheet(
        sheet({
          ...student("P0050", { "School Email": "" }),
          personalEmail: "kid@home.example",
        })
      ),
      AS_OF
    );
    assert.deepEqual(plan.noAddress, ["P0050"]);
  });

  it("uses a student's school email even when they also hold another role", () => {
    const { people } = parseSheet(
      sheet({
        id: "P0052",
        roles: ["Student", "Alumni"],
        student: {},
        personalEmail: "alum@home.example",
      })
    );
    assert.deepEqual(addresses(intendedGroups(people)["grp-alumni"]), [
      "p0052@school.example",
    ]);
  });

  it("plans with reasons for each uncleared mentor", () => {
    const plan = planLifecycle(
      parseSheet(sheet(mentor("P0011", { "Background Screening Expiry": "" }))),
      AS_OF
    );
    assert.deepEqual(plan.notCleared, [
      { personId: "P0011", missing: ["Background Screening"] },
    ]);
  });
});
