import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Finding } from "../src/domain/findings.js";
import type { SheetPerson } from "../src/domain/lifecycle/sheet.js";
import {
  decideSlackCopies,
  membershipAfter,
  planSlackCopies,
  SLACK_COPIES,
  SLACK_DIFFER_KEY,
  SLACK_DIFFER_PREFIX,
  SLACK_GROUP_IDS,
  slackCheckFailedFinding,
  slackDifferFinding,
  slackHeldFinding,
  type SlackCopyDecision,
} from "../src/domain/lifecycle/slackGroups.js";
import {
  ACK_ACTION,
  findingBlocks,
  lifecycleAction,
  SLACK_APPLY_ACTION,
  SLACK_APPLY_ANYWAY_ACTION,
} from "../src/slack/alerts.js";

/**
 * Step 5, part 3: every Slack group change is a click. The hourly check keeps
 * one `slack_groups_differ` finding with Apply; a refused copy gets its own
 * with Apply anyway; what Apply sends keeps everyone held.
 */

const AS_OF = "2026-09-28";

function student(personId: string, lead = false): SheetPerson {
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
      lead,
      slackConsentExpiry: null,
    },
    adminRoles: [],
    parentEmails: [],
  };
}

const u = (personId: string) => `U${personId.slice(1)}`;
const accounts = (people: SheetPerson[]) =>
  new Map(people.map((p) => [p.personId, u(p.personId)]));
const found = Object.fromEntries(
  SLACK_COPIES.map((c) => [c, SLACK_GROUP_IDS[c]])
);
const names = (people: SheetPerson[]) =>
  new Map(people.map((p) => [p.personId, p.name]));

function decide(
  people: SheetPerson[],
  actual: Parameters<typeof planSlackCopies>[0]["actual"]
) {
  return decideSlackCopies({
    plans: planSlackCopies({
      people,
      slackIds: accounts(people),
      actual,
      asOf: AS_OF,
    }),
    found,
  });
}

function finding(kind: Finding["kind"], key: string): Finding {
  return {
    id: 7,
    kind,
    dedupe_key: key,
    severity: "info",
    summary: "s",
    detail: null,
    subject_person_id: null,
    subject_ref: null,
    status: "open",
    first_seen_at: "",
    last_seen_at: "",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    alert_ts: null,
    alert_channel: null,
  };
}

type Button = { action_id: string; style?: string };
function buttons(f: Finding): Button[] {
  const { blocks } = findingBlocks(f);
  const actions = (blocks as { type: string; elements?: Button[] }[]).find(
    (b) => b.type === "actions"
  );
  return actions?.elements ?? [];
}

describe("the Slack group IDs", () => {
  it("names every copy by a distinct Slack user group ID", () => {
    const ids = SLACK_COPIES.map((c) => SLACK_GROUP_IDS[c].id);
    for (const id of ids) assert.match(id, /^S[A-Z0-9]{8,}$/);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("the one Slack groups differ finding", () => {
  it("names who would be added to which group, and is absent when nothing differs", () => {
    const people = [student("P0020"), student("P0021")];
    const f = slackDifferFinding(
      decide(people, { "grp-students": [u("P0020")] }),
      names(people)
    );
    assert.equal(f?.dedupeKey, SLACK_DIFFER_KEY);
    assert.match(f!.summary, /\n• \*@students\* — add P0021 Student P0021\n/);
    assert.match(f!.summary, /Nobody leaving is removed/);

    assert.equal(
      slackDifferFinding(
        decide(people, { "grp-students": [u("P0020"), u("P0021")] }),
        names(people)
      ),
      null
    );
  });

  it("names a flag turned off as a removal", () => {
    const people = [
      student("P0020", true),
      student("P0021", true),
      student("P0022", true),
      student("P0023", true),
      student("P0024"),
    ];
    const f = slackDifferFinding(
      decide(people, {
        "grp-students": people.map((p) => u(p.personId)),
        "grp-student-leads": people.map((p) => u(p.personId)),
      }),
      names(people)
    );
    assert.match(
      f!.summary,
      /• \*@student-leads\* — remove P0024 Student P0024 \(lead\/RA flag off\)/
    );
  });

  it("leaves a refused copy out, for its own finding with Apply anyway", () => {
    const leads = ["P0020", "P0021", "P0022", "P0023"];
    const people = leads.map((id) => student(id));
    const decisions = decide(people, {
      "grp-students": leads.map(u),
      "grp-student-leads": leads.map(u),
    });
    assert.equal(slackDifferFinding(decisions, names(people)), null);
    const held = decisions.find(
      (d): d is Extract<SlackCopyDecision, { kind: "held" }> =>
        d.kind === "held" && d.copy === "grp-student-leads"
    )!;
    const f = slackHeldFinding(held);
    assert.equal(f.subjectRef, "grp-student-leads");
    assert.equal(
      lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey })?.actionId,
      SLACK_APPLY_ANYWAY_ACTION
    );
  });

  it("offers nothing on a wrong or missing group, or a failed check", () => {
    const wrong = slackHeldFinding({
      copy: "grp-students",
      kind: "held",
      why: "wrong_group",
      message: "its ID belongs to @mentors, not @students",
    });
    const failed = slackCheckFailedFinding("Slack said: ratelimited");
    for (const f of [wrong, failed]) {
      assert.ok(f.dedupeKey.startsWith(SLACK_DIFFER_PREFIX));
      assert.equal(
        lifecycleAction({ kind: f.kind, dedupe_key: f.dedupeKey }),
        null
      );
    }
  });
});

describe("the alert text", () => {
  it("puts each group on its own line, between a heading and what Apply does", () => {
    const people = [student("P0020"), student("P0021", true)];
    const f = slackDifferFinding(decide(people, {}), names(people))!;
    const lines = f.summary.split("\n");
    assert.equal(lines[0], "Slack groups differ from the lifecycle sheet.");
    assert.deepEqual(
      lines.slice(1, -1).map((l) => l.split(" — ")[0]),
      ["• *@students*", "• *@student-leads*"]
    );
    assert.match(lines.at(-1)!, /^Apply reads the sheet/);
  });

  it("is verbatim, so a group named in it is never turned into a mention", () => {
    const { blocks } = findingBlocks(
      finding("slack_groups_differ", SLACK_DIFFER_KEY)
    );
    const first = blocks[0] as { text: { verbatim?: boolean } };
    assert.equal(first.text.verbatim, true);
  });
});

describe("the Apply button", () => {
  it("is green and has no Acknowledge beside it, which would hide it", () => {
    const f = finding("slack_groups_differ", SLACK_DIFFER_KEY);
    const b = buttons(f);
    assert.deepEqual(
      b.map((x) => [x.action_id, x.style]),
      [[SLACK_APPLY_ACTION, "primary"]]
    );
    assert.ok(!b.some((x) => x.action_id === ACK_ACTION));
  });

  it("is gone once the finding is closed", () => {
    const f = {
      ...finding("slack_groups_differ", SLACK_DIFFER_KEY),
      status: "resolved" as const,
    };
    assert.deepEqual(buttons(f), []);
  });

  it("keeps Apply anyway beside Acknowledge, like every override", () => {
    const b = buttons(
      finding("slack_groups_differ", "slack_groups_differ:refused:grp-ra")
    );
    assert.deepEqual(
      b.map((x) => x.action_id),
      [SLACK_APPLY_ANYWAY_ACTION, ACK_ACTION]
    );
  });
});

describe("what Apply sends to Slack", () => {
  it("keeps everyone held, adds, and removes only a flag turned off", () => {
    const d: Extract<SlackCopyDecision, { kind: "apply" }> = {
      copy: "grp-student-leads",
      kind: "apply",
      groupId: "S0C5K1YN4U8",
      handle: "student-leads",
      add: [{ slackUserId: "U0030", personId: "P0030" }],
      remove: [{ slackUserId: "U0024", personId: "P0024" }],
    };
    assert.deepEqual(membershipAfter(["U0020", "U0024", "UHELD"], d), [
      "U0020",
      "U0030",
      "UHELD",
    ]);
  });

  it("never sends a list without someone held in it", () => {
    const inactive = { ...student("P0022"), status: "inactive" as const };
    const people = [student("P0020"), student("P0021"), inactive];
    const d = decide(people, {
      "grp-students": [u("P0020"), u("P0022")],
    }).find((x) => x.copy === "grp-students");
    assert.equal(d?.kind, "apply");
    if (d?.kind === "apply") {
      assert.deepEqual(membershipAfter([u("P0020"), u("P0022")], d), [
        "U0020",
        "U0021",
        "U0022",
      ]);
    }
  });
});
