import { APP_NAME } from "../brand.js";
import { listFindings, listPeople, lastAuditRun } from "../db/repo.js";
import type { Finding, Severity } from "../domain/findings.js";
import { severityEmoji } from "../domain/findings.js";
import { requiresEnrollment } from "../domain/people.js";
import { postToAlertChannel } from "../slack/alerts.js";
import { isOnboardingKind } from "../domain/lifecycle/onboardingFindings.js";
import { onboardingChannel } from "../settings.js";

const DIGEST_CAP = 20;

const SEVERITY_ORDER: { severity: Severity; label: string }[] = [
  { severity: "violation", label: "Violations" },
  { severity: "warn", label: "Warnings" },
  { severity: "info", label: "Notices" },
];

/** Slack caps a section at 3000 characters; chunking keeps long summaries safe. */
function lineSections(lines: string[]): unknown[] {
  const sections: unknown[] = [];
  for (let i = 0; i < lines.length; i += 8) {
    sections.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.slice(i, i + 8).join("\n") },
    });
  }
  return sections;
}

/**
 * The digest names findings, never message content — same rule as the alerts
 * it summarizes. Grouped by severity so the reader triages top-down, and each
 * line stays short: the finding's own alert in this channel carries the kind,
 * the buttons, and the detail.
 */
export function digestBlocks(
  open: Finding[],
  onboarding: {
    waiting: number;
    taken: number;
    channel: string | undefined;
  } = {
    waiting: 0,
    taken: 0,
    channel: undefined,
  }
): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Morning report — ${open.length} open finding${open.length === 1 ? "" : "s"}`,
        emoji: true,
      },
    },
  ];

  let shown = 0;
  for (const { severity, label } of SEVERITY_ORDER) {
    const group = open.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    const room = Math.max(0, DIGEST_CAP - shown);
    const lines = group.slice(0, room).map((f) => `• *#${f.id}* ${f.summary}`);
    shown += lines.length;
    if (lines.length === 0) continue;
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${severityEmoji(severity)} *${label}* — ${group.length}`,
        },
      },
      ...lineSections(lines)
    );
  }

  // Counted, never listed: each request is a task in its own channel, and an
  // invite carries a student's address that has no business here.
  if (onboarding.waiting > 0) {
    const where = onboarding.channel ? ` in <#${onboarding.channel}>` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:clipboard: *Onboarding* — ${onboarding.waiting} request` +
          `${onboarding.waiting === 1 ? "" : "s"} waiting${where}` +
          (onboarding.taken ? `, ${onboarding.taken} of them taken` : ""),
      },
    });
  }

  if (open.length > shown) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `…and ${open.length - shown} more — \`/hawkmod findings\` has the full list.`,
      },
    });
  }

  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "Resolve or acknowledge on each finding's own alert in this " +
            "channel · `/hawkmod status` for coverage",
        },
      ],
    }
  );
  return blocks;
}

/** One message a day, only when there is something open. Silence means clean. */
export async function postDigest(): Promise<void> {
  const all = listFindings("open");
  const open = all.filter((f) => !isOnboardingKind(f.kind));
  const taken = listFindings("acknowledged").filter((f) =>
    isOnboardingKind(f.kind)
  ).length;
  const waiting = all.length - open.length + taken;
  if (open.length === 0 && waiting === 0) return;

  await postToAlertChannel(
    `${APP_NAME}: ${open.length} open finding(s)`,
    digestBlocks(open, { waiting, taken, channel: onboardingChannel().channel })
  );
}

/**
 * "An audit right we never exercise is worth nothing." This is the calendar
 * entry that makes the quarterly spot-check happen, with the coverage number
 * attached so the reviewer knows what fraction of DMs the log could even see.
 */
export async function postQuarterlyReminder(): Promise<void> {
  const people = listPeople(true);
  const students = people.filter((p) => p.role === "student").length;
  const adults = people.filter(requiresEnrollment).length;
  const open = listFindings("open").length;
  const last = lastAuditRun("quarterly");

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "Quarterly youth-protection audit is due",
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Students*\n${students}` },
        { type: "mrkdwn", text: `*Adults expected to enroll*\n${adults}` },
        {
          type: "mrkdwn",
          text: `*Last sign-off*\n${last?.signed_off_at ? last.signed_off_at.slice(0, 10) : "never"}`,
        },
        { type: "mrkdwn", text: `*Open findings*\n${open}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Start with `/hawkmod status`, then work the open findings.",
      },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "Runbook: `docs/runbooks/quarterly-audit.md`" },
      ],
    },
  ];

  await postToAlertChannel("Quarterly youth-protection audit is due.", blocks);
}
