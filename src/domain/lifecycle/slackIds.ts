import type { SheetPerson } from "./sheet.js";

/** The two tabs that carry a `Slack User ID` column. */
export type SlackIdTab = "Mentor_Details" | "Student_Details";

/** What the matcher needs to know about a Slack account. */
export type SlackAccount = {
  id: string;
  email: string | null;
  /** Deactivated in Slack, or a bot: never a match for a person. */
  live: boolean;
};

type Target = { personId: string; tab: SlackIdTab; row: number };

export type SlackIdDecision =
  /** The cell is blank and exactly one live account has this email. */
  | (Target & { kind: "write"; slackUserId: string })
  /** The cell already holds the account that matches. */
  | (Target & { kind: "unchanged"; slackUserId: string })
  /**
   * Typed by hand, for a live account whose email is not the identity email
   * — the usual reason anyone types one. Trusted, as the roster trusts it
   * (docs/lifecycle-sync.md, "Cutover"): the typing is the statement.
   */
  | (Target & { kind: "typed"; slackUserId: string })
  /** No live account has this email yet: not invited, or not joined. */
  | (Target & { kind: "not_in_slack" })
  /**
   * The cell holds something the match does not support. Never overwritten:
   * a person may have typed it in, and hawk-mod has no way to know which of
   * the two is right.
   */
  | (Target & {
      kind: "conflict";
      recorded: string | null;
      found: string | null;
      reason: string;
    });

/**
 * Decides, for every Mentor_Details and Student_Details row, whether to fill in
 * its Slack User ID. Pure; the caller lists Slack accounts and does the writes.
 *
 * Matching is by the address that tab owns — RHR Email for a mentor, School
 * Email for a student — and nothing looser. A wrong Slack ID is worse than a
 * missing one: the roster will join on it, so a mismatch would attach one
 * person's monitoring and findings to someone else. So this only ever fills a
 * blank cell with an exact, unambiguous match, and everything else is reported
 * for a person to look at.
 */
export function planSlackIds(
  people: readonly SheetPerson[],
  accounts: readonly SlackAccount[]
): SlackIdDecision[] {
  const liveByEmail = new Map<string, string>();
  const liveIds = new Set<string>();
  for (const a of accounts) {
    if (!a.live) continue;
    liveIds.add(a.id);
    if (a.email) liveByEmail.set(a.email.toLowerCase(), a.id);
  }

  const targets: (Target & {
    email: string | null;
    recorded: string | null;
  })[] = [];
  for (const p of people) {
    if (p.mentor) {
      targets.push({
        personId: p.personId,
        tab: "Mentor_Details",
        row: p.mentor.row,
        email: p.mentor.rhrEmail,
        recorded: p.mentor.slackUserId,
      });
    }
    if (p.student) {
      targets.push({
        personId: p.personId,
        tab: "Student_Details",
        row: p.student.row,
        email: p.student.schoolEmail,
        recorded: p.student.slackUserId,
      });
    }
  }

  // One Slack account can be one person. If two rows would end up with the
  // same ID — the same address typed for two people, or an ID copied by hand
  // — neither gets written until someone sorts out which is which.
  const claims = new Map<string, number>();
  for (const t of targets) {
    const id = t.recorded ?? (t.email ? liveByEmail.get(t.email) : undefined);
    if (id) claims.set(id, (claims.get(id) ?? 0) + 1);
  }

  return targets.map(({ email, recorded, ...target }): SlackIdDecision => {
    const found = (email && liveByEmail.get(email)) ?? null;
    const id = recorded ?? found;
    if (id && (claims.get(id) ?? 0) > 1) {
      return {
        ...target,
        kind: "conflict",
        recorded,
        found,
        reason: "the same Slack account matches more than one row",
      };
    }
    if (recorded) {
      if (recorded === found) {
        return { ...target, kind: "unchanged", slackUserId: recorded };
      }
      // Nothing contradicts it: the account is live and no other account
      // holds the identity email. A different account holding that email
      // is still a conflict — two accounts, one person, which is worth a look.
      if (liveIds.has(recorded) && !found) {
        return { ...target, kind: "typed", slackUserId: recorded };
      }
      return {
        ...target,
        kind: "conflict",
        recorded,
        found,
        reason: !liveIds.has(recorded)
          ? "the recorded Slack ID is not an active Slack account"
          : "the email matches a different Slack account",
      };
    }
    if (found) return { ...target, kind: "write", slackUserId: found };
    return { ...target, kind: "not_in_slack" };
  });
}
