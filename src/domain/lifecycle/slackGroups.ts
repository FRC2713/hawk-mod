import type { IsoDate } from "../dates.js";
import { belongs, intendedGroups, type PersonGroup } from "./groups.js";
import { leaving, planRefusal, type LeavingReason } from "./groupPlan.js";
import type { SheetPerson } from "./sheet.js";

/**
 * The Slack user groups that copy a Google group (docs/lifecycle-sync.md,
 * "Copied to Slack (E)"). Each is computed by the same `intendedGroups` as its
 * Google group, so the two cannot disagree about who belongs — restricted to
 * people with a Slack account, because a mentor not yet invited is in the
 * Google group and absent from the Slack one, which is not a difference.
 *
 * What a copy is *for* is its default channels: adding someone to @students
 * adds them to the channels a student should be in. That is why onboarding
 * wants this automated, and why joining @mentors waits for CORI like joining
 * grp-mentors does.
 */
export const SLACK_COPIES = [
  "grp-students",
  "grp-mentors",
  "grp-student-leads",
  "grp-mentor-leads",
  "grp-ra",
] as const satisfies readonly PersonGroup[];

export type SlackCopy = (typeof SLACK_COPIES)[number];

/**
 * Each copy's Slack user group, by its permanent ID — never by handle, the
 * same rule as channels and Google Groups (decided 2026-09-28). A handle can
 * be renamed in Slack; the ID cannot. `handle` is what the ID must lead to:
 * an ID pasted onto the wrong line leads to a group with another handle, and
 * nothing is applied to it.
 *
 * An empty `id` is a copy with no Slack group yet; it is reported and skipped.
 */
export const SLACK_GROUP_IDS: Record<
  SlackCopy,
  { id: string; handle: string }
> = {
  "grp-students": { id: "", handle: "students" },
  "grp-mentors": { id: "", handle: "mentors" },
  "grp-student-leads": { id: "", handle: "student-leads" },
  "grp-mentor-leads": { id: "", handle: "mentor-leads" },
  "grp-ra": { id: "", handle: "ra-adults" },
};

/** A Slack account in a copy, and whose it is on the sheet, if anyone's. */
export type SlackMember = { slackUserId: string; personId: string | null };

/**
 * Why a member is kept until an administrator removes them — the Google
 * reasons that can apply to a Slack account. There is no `other_address`: a
 * person has one Slack account on the roster, and a second account is
 * nobody's on the sheet.
 */
export type SlackHeldReason = LeavingReason | "not_on_sheet";

export type SlackHeldMember = SlackMember & { reason: SlackHeldReason };

export type SlackCopyPlan = {
  copy: SlackCopy;
  add: SlackMember[];
  /** Removed by Apply: a lead or RA flag turned off, nothing else. */
  remove: SlackMember[];
  /** Kept until their own finding's button removes them. */
  held: SlackHeldMember[];
  /** Why `add` and `remove` must not be applied, or null. */
  refusal: string | null;
};

/**
 * What Apply would do to each Slack copy. Pure: sheet people, their Slack
 * accounts and each group's current members in, a plan out.
 *
 * The rule is the Google one (decided 2026-09-28). Someone the sheet puts in
 * a copy is added — including someone removed from it by hand, so a hand
 * removal does not stick. Someone leaving (Inactive, role gone, CORI lapsed)
 * or an account the sheet does not account for is **held**: kept, never
 * removed by Apply, and removed only from their own finding. Only a lead or
 * RA flag turned off is removed by Apply. Apply is a click either way; the
 * difference is that a person leaving gets a decision with their own name on
 * it rather than one line in a list.
 *
 * A held person is kept where they are and never added anywhere: someone who
 * removes a leaver by hand is not undone.
 *
 * `slackIds` is Person ID → the Slack account the roster matched, and only
 * accounts that can be added: the caller leaves out deactivated ones.
 */
export function planSlackCopies(args: {
  people: readonly SheetPerson[];
  slackIds: ReadonlyMap<string, string>;
  /** Each copy's current members; a copy missing here is read as empty. */
  actual: Partial<Record<SlackCopy, Iterable<string>>>;
  asOf: IsoDate;
}): SlackCopyPlan[] {
  const { people, slackIds, asOf } = args;
  const intended = intendedGroups(people, asOf);
  const byId = new Map(people.map((p) => [p.personId, p]));
  const owner = new Map<string, SheetPerson>();
  for (const [personId, slackUserId] of slackIds) {
    const p = byId.get(personId);
    if (p) owner.set(slackUserId, p);
  }

  return SLACK_COPIES.map((copy): SlackCopyPlan => {
    const current = new Set(args.actual[copy] ?? []);

    const want = new Map<string, string>();
    for (const p of intended[copy]) {
      const id = slackIds.get(p.personId);
      if (id) want.set(id, p.personId);
    }

    const add: SlackMember[] = [];
    for (const [slackUserId, personId] of want) {
      if (!current.has(slackUserId)) add.push({ slackUserId, personId });
    }

    const remove: SlackMember[] = [];
    const held: SlackHeldMember[] = [];
    for (const slackUserId of current) {
      if (want.has(slackUserId)) continue;
      const p = owner.get(slackUserId);
      if (!p) {
        held.push({ slackUserId, personId: null, reason: "not_on_sheet" });
        continue;
      }
      // Still entitled to stay: grp-ra's lapsed screening.
      if (belongs(copy, p, asOf, false)) continue;
      const reason = leaving(copy, p, asOf);
      const member = { slackUserId, personId: p.personId };
      if (reason) held.push({ ...member, reason });
      else remove.push(member);
    }

    const desired = new Set(current);
    for (const m of add) desired.add(m.slackUserId);
    for (const m of remove) desired.delete(m.slackUserId);

    const byAccount = (x: SlackMember, y: SlackMember) =>
      x.slackUserId < y.slackUserId ? -1 : 1;
    return {
      copy,
      add: add.sort(byAccount),
      remove: remove.sort(byAccount),
      held: held.sort(byAccount),
      refusal: planRefusal(current, desired),
    };
  });
}

/** A Slack user group as read: its ID and its handle now. */
export type FoundSlackGroup = { id: string; handle: string };

export type SlackCopyDecision =
  | {
      copy: SlackCopy;
      kind: "apply";
      groupId: string;
      handle: string;
      add: SlackMember[];
      remove: SlackMember[];
    }
  | {
      copy: SlackCopy;
      kind: "held";
      why: "refused" | "wrong_group" | "missing";
      message: string;
    }
  | { copy: SlackCopy; kind: "nothing" };

/**
 * What Apply may do to each copy, from its plan. The three stops are the
 * Google ones: a **refused** plan waits for Apply anyway; an ID that leads to
 * a group with another handle is the **wrong group** and nothing overrides
 * it; a copy with no ID, or whose group Slack does not have, is **missing**.
 */
export function decideSlackCopies(args: {
  plans: readonly SlackCopyPlan[];
  /** Each copy's group as Slack has it now, looked up by its ID. */
  found: Partial<Record<SlackCopy, FoundSlackGroup>>;
  /** Copies an administrator has said to apply anyway, despite a refusal. */
  force?: ReadonlySet<SlackCopy>;
}): SlackCopyDecision[] {
  return args.plans.map((plan): SlackCopyDecision => {
    const { copy } = plan;
    const expected = SLACK_GROUP_IDS[copy];
    const found = args.found[copy];
    if (!found) {
      return {
        copy,
        kind: "held",
        why: "missing",
        message: expected.id
          ? `Slack has no user group ${expected.id}`
          : `no ID yet in SLACK_GROUP_IDS for @${expected.handle}`,
      };
    }
    if (found.handle.trim().toLowerCase() !== expected.handle) {
      return {
        copy,
        kind: "held",
        why: "wrong_group",
        message: `its ID belongs to @${found.handle}, not @${expected.handle}`,
      };
    }
    if (plan.refusal && !args.force?.has(copy)) {
      return { copy, kind: "held", why: "refused", message: plan.refusal };
    }
    if (!plan.add.length && !plan.remove.length) {
      return { copy, kind: "nothing" };
    }
    return {
      copy,
      kind: "apply",
      groupId: found.id,
      handle: found.handle,
      add: plan.add,
      remove: plan.remove,
    };
  });
}
