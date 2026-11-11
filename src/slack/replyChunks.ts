/**
 * A long report as several code-block replies, split between lines.
 *
 * Slack truncates a message's text past 40,000 characters, and a lifecycle
 * preview names every person it touches — the first groups apply listed 180
 * joins — so a long one is split rather than cut off. Each piece is kept well
 * under the limit, and each is its own code block, so no piece opens a fence
 * another has to close. A slash command's `respond` may be used only five
 * times, so past that the last piece says what was left out rather than the
 * reply silently stopping.
 *
 * Pure, so it is tested without Slack.
 */

/** Characters per reply, fences included: a quarter of Slack's limit. */
export const REPLY_CHARS = 10_000;

/** How many times a slash command's response URL may be used. */
export const MAX_REPLIES = 5;

const FENCE = "```";

export function fencedReplies(
  text: string,
  opts: { chars?: number; max?: number } = {}
): string[] {
  const room = (opts.chars ?? REPLY_CHARS) - 2 * FENCE.length;
  const max = opts.max ?? MAX_REPLIES;

  // A line too long for one reply on its own is cut, so every piece fits.
  const lines = text
    .split("\n")
    .flatMap((l) =>
      l.length <= room
        ? [l]
        : Array.from({ length: Math.ceil(l.length / room) }, (_, i) =>
            l.slice(i * room, (i + 1) * room)
          )
    );

  const pieces: string[][] = [[]];
  let size = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (size + cost > room + 1 && pieces.at(-1)!.length) {
      pieces.push([]);
      size = 0;
    }
    pieces.at(-1)!.push(line);
    size += cost;
  }

  if (pieces.length > max) {
    const left = pieces.slice(max - 1).reduce((n, p) => n + p.length, 0);
    const note = `… and ${left} more line(s), not shown: Slack allows ${max} replies. Run it from the CLI to see all of it.`;
    pieces.splice(max - 1, pieces.length, [note]);
  }
  return pieces.map((p) => FENCE + p.join("\n") + FENCE);
}
