import { APP_NAME } from "../brand.js";
import { listFindings, listPeople, lastAuditRun } from "../db/repo.js";
import { severityEmoji } from "../domain/findings.js";
import { requiresEnrollment } from "../domain/people.js";
import { postToAlertChannel } from "../slack/alerts.js";

/** One message a day, only when there is something open. Silence means clean. */
export async function postDigest(): Promise<void> {
  const open = listFindings("open");
  if (open.length === 0) return;

  const lines = open
    .slice(0, 20)
    .map(
      (f) =>
        `${severityEmoji(f.severity)} *#${f.id}* \`${f.kind}\` — ${f.summary}`
    );
  const extra = open.length > 20 ? `\n…and ${open.length - 20} more.` : "";

  await postToAlertChannel(
    `*${APP_NAME}: ${open.length} open finding(s)*\n${lines.join("\n")}${extra}`
  );
}

/**
 * "An audit right we never exercise is worth nothing." This is the calendar
 * entry that makes the quarterly spot-check happen, with the coverage number
 * attached so the reviewer knows what fraction of DMs the log could even see.
 */
export async function postQuarterlyReminder(): Promise<void> {
  const people = listPeople(true);
  const adults = people.filter(requiresEnrollment);
  const last = lastAuditRun("quarterly");

  await postToAlertChannel(
    [
      "*Quarterly youth-protection audit is due.*",
      `Roster: ${people.filter((p) => p.role === "student").length} students, ${adults.length} adults expected to be enrolled.`,
      last?.signed_off_at
        ? `Last sign-off: ${last.signed_off_at.slice(0, 10)}.`
        : "No previous audit has been signed off.",
      "",
      "Runbook: `docs/runbooks/quarterly-audit.md`.",
      "Start with `/hawkmod status`, then work the open findings.",
    ].join("\n")
  );
}
