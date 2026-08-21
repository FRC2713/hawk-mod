/**
 * Plans an edit to a Slack user group's membership.
 *
 * Slack sells no add-one/remove-one endpoint: `usergroups.users.update`
 * *replaces* the entire member list. So every edit is really "here is the
 * complete new membership", and the interesting question is what a caller is
 * about to overwrite. This module answers that question purely, from two sets,
 * so the answer can be shown to a human before anything is applied.
 *
 * Adding one person to a group is the degenerate case — `desired` is `current`
 * plus one — which is why the single-user command and the eventual
 * spreadsheet-driven sync share this and not just a naming convention.
 */

export type GroupPlan = {
  /** Slack ids to be added, sorted. */
  add: string[];
  /** Slack ids to be removed, sorted. */
  remove: string[];
  /** Slack ids already correct, sorted. */
  unchanged: string[];
  /** The full membership to send to Slack if this plan is applied, sorted. */
  result: string[];
  /**
   * Why this plan must not be applied, or `null` if it may be. A refusal is a
   * property of the plan itself, so a caller cannot apply one by forgetting to
   * check a separate flag.
   */
  refusal: string | null;
};

export type PlanLimits = {
  /**
   * The largest share of a group a single plan may remove, as a fraction of
   * current membership. Removing exactly one person is always allowed however
   * small the group, since that is a person deliberately naming a person.
   */
  maxRemovedFraction: number;
};

export const DEFAULT_LIMITS: PlanLimits = { maxRemovedFraction: 0.25 };

/**
 * Diffs intended membership against actual, and refuses plans that look like
 * an accident rather than an intention.
 *
 * The refusal exists because of what is on the other end of this: a Google
 * Sheet. A shifted header row, a filtered view someone forgot to clear, a
 * column of blanks — none of these read as errors, they read as "the roster is
 * now these four people", and applying that empties @students. A bulk plan that
 * removes most of a group is indistinguishable from a bad spreadsheet, so it is
 * refused and shown to a human rather than applied and reported.
 */
export function planGroupMembership(
  current: ReadonlySet<string>,
  desired: ReadonlySet<string>,
  limits: PlanLimits = DEFAULT_LIMITS
): GroupPlan {
  const add = [...desired].filter((id) => !current.has(id)).sort();
  const remove = [...current].filter((id) => !desired.has(id)).sort();
  const unchanged = [...current].filter((id) => desired.has(id)).sort();
  const result = [...desired].sort();

  return {
    add,
    remove,
    unchanged,
    result,
    refusal: refuse(current, result, remove, limits),
  };
}

function refuse(
  current: ReadonlySet<string>,
  result: string[],
  remove: string[],
  limits: PlanLimits
): string | null {
  if (result.length === 0) {
    // Slack rejects an empty `users` list outright (`no_users_provided`) — a
    // user group must keep at least one member. Saying so here turns an opaque
    // API error into a sentence that explains the situation.
    return current.size === 0
      ? "That group is empty and Slack will not accept an empty membership."
      : "Slack does not allow a user group to be emptied. Remove the group " +
          "itself in Slack if it is finished with.";
  }

  if (remove.length <= 1 || current.size === 0) return null;

  const fraction = remove.length / current.size;
  if (fraction > limits.maxRemovedFraction) {
    return (
      `This would remove ${remove.length} of ${current.size} members ` +
      `(${Math.round(fraction * 100)}%), which is more than a plan is allowed ` +
      `to remove at once. Check the source of this change before applying it.`
    );
  }

  return null;
}

/** The plan for adding one person — what the slash command builds. */
export function planAdd(
  current: ReadonlySet<string>,
  slackId: string,
  limits?: PlanLimits
): GroupPlan {
  return planGroupMembership(current, new Set([...current, slackId]), limits);
}

/** The plan for removing one person — what the slash command builds. */
export function planRemove(
  current: ReadonlySet<string>,
  slackId: string,
  limits?: PlanLimits
): GroupPlan {
  const desired = new Set(current);
  desired.delete(slackId);
  return planGroupMembership(current, desired, limits);
}

/**
 * Whether an edit ends someone's monitoring as a student, and so must carry a
 * written reason.
 *
 * Pure, and keyed on the group's *handle* rather than whatever the caller
 * typed. Slack sends an escaped mention as `<!subteam^S0614TY5A|adults>`, so a
 * command handler comparing the raw argument to a configured handle compares an
 * opaque id to a word and quietly never matches — which would mean the one gate
 * standing in front of the most consequential edit never fires.
 */
export function reducesMonitoring(args: {
  action: "add" | "remove";
  subjectRole: string;
  handle: string;
  adultHandle: string;
}): boolean {
  return (
    args.action === "add" &&
    args.subjectRole === "student" &&
    args.handle.replace(/^@/, "").toLowerCase() ===
      args.adultHandle.replace(/^@/, "").toLowerCase()
  );
}
