import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Finding } from "../src/domain/findings.js";
import type { OnboardingRequest } from "../src/domain/lifecycle/onboarding.js";
import {
  inviteAddressLine,
  isOnboardingKind,
  onboardingFinding,
  onboardingPrefixes,
} from "../src/domain/lifecycle/onboardingFindings.js";
import {
  reminderText,
  welcomeActions,
  welcomeText,
} from "../src/domain/lifecycle/welcome.js";
import { digestBlocks } from "../src/jobs/digest.js";
import { findingBlocks, ONBOARDING_ON_IT_ACTION } from "../src/slack/alerts.js";

// A database of this file's own, for the few repo functions tested below;
// nothing opens it until the first of them runs.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hawk-mod-onboarding-"));
const repo = await import("../src/db/repo.js");

/**
 * Step 6, part 3: onboarding requests posted as findings, the welcome and
 * reminder to new adults, and the morning report's count.
 */

const invite: OnboardingRequest = {
  kind: "slack_invite",
  personId: "P0101",
  name: "Alex Student",
  role: "student",
  address: "alex@school.example",
};

function asFinding(r: OnboardingRequest, over: Partial<Finding> = {}): Finding {
  const f = onboardingFinding(r);
  return {
    id: 7,
    kind: f.kind,
    dedupe_key: f.dedupeKey,
    severity: f.severity,
    summary: f.summary,
    detail: f.detail === undefined ? null : JSON.stringify(f.detail),
    subject_person_id: null,
    subject_ref: f.subjectRef ?? null,
    status: "open",
    first_seen_at: "2026-09-29T00:00:00.000Z",
    last_seen_at: "2026-09-29T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    alert_ts: null,
    alert_channel: null,
    ...over,
  };
}

describe("onboarding requests as findings", () => {
  it("asks for a Google account by Person ID and name, with no address", () => {
    const f = onboardingFinding({
      kind: "google_account",
      personId: "P0042",
      name: "Jordan Lee",
      address: null,
    });
    assert.equal(f.kind, "onboarding_google_account");
    assert.equal(f.dedupeKey, "onboarding_google_account:P0042");
    assert.equal(
      f.summary,
      "Create a Google account for P0042 Jordan Lee, then type the address " +
        "into their RHR Email on the lifecycle sheet."
    );
  });

  it("names the RHR Email the account is to be created at", () => {
    const f = onboardingFinding({
      kind: "google_account",
      personId: "P0073",
      name: "Alexa Mentor",
      address: "alexa@rhr.example",
    });
    assert.equal(f.dedupeKey, "onboarding_google_account:P0073");
    assert.equal(
      f.summary,
      "Create a Google account for P0073 Alexa Mentor at alexa@rhr.example, " +
        "the RHR Email on the lifecycle sheet. If that address is a typo, " +
        "fix the sheet instead."
    );
  });

  it("keeps a student's School Email out of the summary", () => {
    const f = onboardingFinding(invite);
    assert.doesNotMatch(f.summary, /@/);
    assert.equal(
      f.summary,
      "Invite P0101 Alex Student (student) to Slack, at the address below."
    );
  });

  it("puts the address only on the posted request, while it is open", () => {
    assert.equal(
      inviteAddressLine(asFinding(invite)),
      "Address to invite: `alex@school.example`"
    );
    const open = JSON.stringify(findingBlocks(asFinding(invite)).blocks);
    assert.match(open, /alex@school\.example/);
    const done = JSON.stringify(
      findingBlocks(asFinding(invite, { status: "resolved" })).blocks
    );
    assert.doesNotMatch(done, /alex@school\.example/);
  });

  it("is one request per person for Slack, whether invite or reactivate", () => {
    const again = onboardingFinding({
      kind: "slack_reactivate",
      personId: "P0101",
      name: "Alex Student",
      role: "student",
      slackUserId: "U9",
    });
    assert.equal(again.dedupeKey, onboardingFinding(invite).dedupeKey);
    assert.match(
      again.summary,
      /^Reactivate P0101 Alex Student's Slack account/
    );
  });

  it("names each RHR Email problem, and the primary address for an alias", () => {
    const f = onboardingFinding({
      kind: "rhr_email",
      personId: "P0043",
      name: "Sam Park",
      problem: { kind: "alias", primaryEmail: "sam.park@rhr.example" },
    });
    assert.equal(f.severity, "warn");
    assert.match(f.summary, /primary address, sam\.park@rhr\.example\.$/);
  });

  it("closes account requests only after a run that read Google", () => {
    assert.deepEqual(onboardingPrefixes(true), [
      "onboarding_google_account:",
      "onboarding_rhr_email:",
      "onboarding_slack_invite:",
    ]);
    assert.deepEqual(onboardingPrefixes(false), ["onboarding_slack_invite:"]);
  });

  it("offers I'm on it, and no Acknowledge or Resolve", () => {
    const text = JSON.stringify(findingBlocks(asFinding(invite)).blocks);
    assert.match(text, new RegExp(ONBOARDING_ON_IT_ACTION));
    assert.match(text, /I'm on it/);
    assert.doesNotMatch(text, /Acknowledge|"Resolve"/);
    assert.match(text, /closes by itself once they are in Slack/);
  });

  it("says a Google account request closes when Google has the account", () => {
    const google = asFinding({
      kind: "google_account",
      personId: "P0073",
      name: "Alexa Mentor",
      address: "alexa@rhr.example",
    });
    const text = JSON.stringify(findingBlocks(google).blocks);
    assert.match(text, /closes by itself once Google has the account/);
    assert.doesNotMatch(text, /Slack shows it/);
  });

  it("is told apart from every other finding", () => {
    assert.ok(isOnboardingKind("onboarding_slack_invite"));
    assert.ok(!isOnboardingKind("adult_not_enrolled"));
  });
});

describe("the welcome and the reminder", () => {
  const sent = (m: Record<string, Record<string, string>>) =>
    new Map(Object.entries(m));
  const today = "2026-10-06";

  it("records adults already in Slack and sends them nothing, the first time", () => {
    assert.deepEqual(
      welcomeActions(
        [
          { slackUserId: "U1", enrolled: false },
          { slackUserId: "U2", enrolled: true },
        ],
        sent({}),
        { firstRun: true, today }
      ),
      [{ slackUserId: "U1", kind: "baseline" }]
    );
  });

  it("welcomes an adult who arrives afterwards", () => {
    assert.deepEqual(
      welcomeActions([{ slackUserId: "U3", enrolled: false }], sent({}), {
        firstRun: false,
        today,
      }),
      [{ slackUserId: "U3", kind: "welcome" }]
    );
  });

  it("never messages a baseline adult", () => {
    assert.deepEqual(
      welcomeActions(
        [{ slackUserId: "U1", enrolled: false }],
        sent({ U1: { baseline: "2026-09-01" } }),
        { firstRun: false, today }
      ),
      []
    );
  });

  it("reminds once, seven days after the welcome, and not on the sixth", () => {
    const adults = [{ slackUserId: "U3", enrolled: false }];
    assert.deepEqual(
      welcomeActions(adults, sent({ U3: { welcome: "2026-09-30" } }), {
        firstRun: false,
        today,
      }),
      []
    );
    assert.deepEqual(
      welcomeActions(adults, sent({ U3: { welcome: "2026-09-29" } }), {
        firstRun: false,
        today,
      }),
      [{ slackUserId: "U3", kind: "reminder" }]
    );
    assert.deepEqual(
      welcomeActions(
        adults,
        sent({ U3: { welcome: "2026-09-01", reminder: "2026-09-08" } }),
        { firstRun: false, today }
      ),
      []
    );
  });

  it("stops the moment they enroll", () => {
    assert.deepEqual(
      welcomeActions(
        [{ slackUserId: "U3", enrolled: true }],
        sent({ U3: { welcome: "2026-09-01" } }),
        { firstRun: false, today }
      ),
      []
    );
  });

  it("says what is recorded, where to go, and where to ask", () => {
    const text = welcomeText("https://mod.example.org", "frc2713.slack.com");
    assert.match(text, /direct messages that include a student/);
    assert.match(text, /Conversations between adults are never recorded\./);
    assert.match(text, /https:\/\/mod\.example\.org/);
    assert.match(text, /enter \*frc2713\.slack\.com\*/);
    assert.match(text, /Ask in <#C71FBF5FG>\./);
  });

  it("leaves the workspace out rather than guess it", () => {
    assert.doesNotMatch(
      welcomeText("https://mod.example.org", null),
      /workspace,/
    );
    assert.doesNotMatch(
      reminderText("https://mod.example.org", null),
      /workspace:/
    );
  });
});

describe("the morning report", () => {
  it("counts onboarding requests and names nobody", () => {
    const text = JSON.stringify(
      digestBlocks([], { waiting: 3, taken: 1, channel: "C0ONBOARD" })
    );
    assert.match(
      text,
      /Onboarding\* — 3 requests waiting in <#C0ONBOARD>, 1 of them taken/
    );
    assert.doesNotMatch(text, /@/);
  });

  it("says nothing about onboarding when nothing waits", () => {
    assert.doesNotMatch(JSON.stringify(digestBlocks([])), /Onboarding/);
  });
});

describe("what is recorded (migration 0010)", () => {
  it("records each message once, and forgets a failed send", () => {
    assert.equal(
      repo.recordOnboardingMessage("U1", "welcome", "2026-09-29T12:00:00.000Z"),
      true
    );
    assert.equal(repo.recordOnboardingMessage("U1", "welcome"), false);
    repo.recordOnboardingMessage("U2", "baseline", "2026-09-29T12:00:00.000Z");
    assert.deepEqual(repo.onboardingMessagesSent().get("U1"), {
      welcome: "2026-09-29T12:00:00.000Z",
    });
    repo.forgetOnboardingMessage("U1", "welcome");
    assert.equal(repo.recordOnboardingMessage("U1", "welcome"), true);
  });

  it("remembers which channel an alert was posted in", () => {
    const { id } = repo.upsertFinding(onboardingFinding(invite));
    repo.setFindingAlertTs(id, "1790000000.000100", "C0ONBOARD");
    const f = repo.getFinding(id)!;
    assert.equal(f.alert_ts, "1790000000.000100");
    assert.equal(f.alert_channel, "C0ONBOARD");
  });
});
