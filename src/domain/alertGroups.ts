import type { Finding, FindingKind } from "./findings.js";
import { severityEmoji } from "./findings.js";

/**
 * One alert for many findings of a kind, so that 1 August — when every
 * returning student's Slack Consent and every mentor's Youth Protection
 * Training run out on the same night — is one message per kind in the alert
 * channel, not forty (#86).
 *
 * Only the presentation is grouped. Each person keeps their own finding,
 * which the sweep closes by itself when it is fixed, and which an
 * administrator can still acknowledge or resolve by number. The summary has
 * no buttons at all: an "acknowledge all" would bury forty things that are
 * still true with one click, which is the problem #52 is already about.
 *
 * Only condition findings are grouped — those the sweep owns. A finding that
 * records something that happened (a DM) always gets its own alert.
 */

/** How many new findings of one kind, in one sweep, make a summary. */
export const GROUP_THRESHOLD = 4;

export type NewlyRaised = { id: number; kind: FindingKind };

/**
 * Which of a sweep's newly raised findings are posted on their own, and which
 * together. `groupable` is the kinds that may be grouped; anything else is
 * always a single. Order is kept, so a summary lists findings in the order
 * the sweep raised them.
 */
export function planPosting(
  raised: readonly NewlyRaised[],
  groupable: ReadonlySet<FindingKind>,
  threshold: number = GROUP_THRESHOLD
): { singles: number[]; groups: { kind: FindingKind; ids: number[] }[] } {
  const byKind = new Map<FindingKind, number[]>();
  for (const r of raised) {
    if (!groupable.has(r.kind)) continue;
    byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.id]);
  }
  const grouped = new Set<number>();
  const groups: { kind: FindingKind; ids: number[] }[] = [];
  for (const [kind, ids] of byKind) {
    if (ids.length < threshold) continue;
    groups.push({ kind, ids });
    for (const id of ids) grouped.add(id);
  }
  return {
    singles: raised.filter((r) => !grouped.has(r.id)).map((r) => r.id),
    groups,
  };
}

/**
 * The summary's words, redrawn whenever one of its findings changes: a
 * headline counting what is still open, one line per finding (a closed one
 * struck through, with who closed it), and a footer saying how to act on one.
 * `findings` are the ones the message was posted for, still sharing it.
 */
export function summaryText(
  kind: FindingKind,
  findings: readonly Pick<
    Finding,
    "id" | "severity" | "summary" | "status" | "resolved_by"
  >[]
): { headline: string; lines: string[]; footer: string } {
  const open = findings.filter((f) => f.status === "open").length;
  const total = findings.length;
  const severity = findings[0]?.severity ?? "warn";
  const emoji = open ? severityEmoji(severity) : ":white_check_mark:";
  const headline =
    open === 0
      ? `${emoji} *${kind}* — all ${total} found together are closed.`
      : `${emoji} *${kind}* — ${open} of ${total} found together still open.`;
  const lines = findings.map((f) => {
    if (f.status === "open") return `• #${f.id} ${f.summary}`;
    const verb = f.status === "resolved" ? "resolved" : "acknowledged";
    return (
      `• ~#${f.id} ${f.summary}~ ` +
      `_${verb}${f.resolved_by ? ` by ${f.resolved_by}` : ""}_`
    );
  });
  const footer =
    `${total} findings of one kind raised in one sweep, so they share this ` +
    `message. Each closes by itself once it is fixed; to close one by hand, ` +
    "`/hawkmod ack <id> <reason>` or `/hawkmod resolve <id> <reason>`.";
  return { headline, lines, footer };
}

/**
 * Lines packed into chunks Slack will take in one section block (3,000
 * characters), leaving room to spare.
 */
export function chunkLines(lines: readonly string[], max = 2800): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const raw of lines) {
    const line = raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
    if (current && current.length + 1 + line.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
