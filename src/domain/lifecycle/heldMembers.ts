import type { IsoDate } from "../dates.js";
import { dedupeKey, type NewFinding } from "../findings.js";
import { hasAccess } from "./groups.js";
import type { SheetPerson } from "./sheet.js";
import type { GroupPlanResult, HeldReason } from "./groupPlan.js";
import type { GroupName } from "./groups.js";
import {
  SLACK_GROUP_IDS,
  type SlackCopy,
  type SlackCopyPlan,
  type SlackHeldReason,
} from "./slackGroups.js";

/**
 * Everyone a groups run left where they are, gathered into one alert per
 * person — or per address, when the sheet cannot say whose it is — each with
 * a button that removes them from the groups they are held in (step 4,
 * part 4). Pure, so the gathering and the wording are tested without Google.
 *
 * A departing student's alert carries their parents' grp-parents entries too:
 * a parent no Active student lists any more is held under the students who
 * still list them. A sibling who is still Active keeps the parent listed, so
 * that parent is never held at all.
 *
 * A mentor held only because their CORI is not current is `cori_lapsed`, and
 * its button removes them from the mentor groups: "joining waits for CORI; a
 * lapse waits for a person" (docs/lifecycle-sync.md).
 *
 * Alerts name the person and Person ID. An address the sheet does not account
 * for has neither, so it is shown partly hidden — enough to find it among a
 * group's members in the Admin console, not the whole address in Slack.
 *
 * The Slack user group copies (step 5) hold people by the same rule, and are
 * gathered into the same alerts: one per person, whether they are held in a
 * Google Group, a Slack group or both, so one click removes them from all of
 * it. A Slack account the sheet does not know gets its own alert, named by
 * its Slack name — a Slack account is not a private address.
 *
 * Step 6's safety net joins the same alert: an Active mentor with a live
 * Slack account and no current CORI is `cori_lapsed` whether or not they are
 * in any group — one alert per mentor, not one per place they are (decided
 * 2026-09-29). Slack Pro cannot restrict a member, so for the Slack account
 * the alert asks a person to deactivate it; hawk-mod removes nothing there.
 */

export type HeldEntry = {
  group: GroupName;
  address: string;
  reason: HeldReason;
};

/** Someone held in a Slack user group copy. */
export type SlackHeldEntry = {
  copy: SlackCopy;
  slackUserId: string;
  reason: SlackHeldReason;
};

export type HeldSubject = {
  /** The finding's dedupe key; also what the button re-finds at the click. */
  key: string;
  kind: "group_member_held" | "cori_lapsed";
  /** Whose these entries are; null for an address or account the sheet cannot place. */
  personId: string | null;
  /** The address, for a Google subject with no Person ID. */
  address: string | null;
  /** The Slack account, for a Slack subject with no Person ID. */
  slackUserId: string | null;
  /** Held in Google Groups. */
  entries: HeldEntry[];
  /** Held in Slack user group copies. */
  slack: SlackHeldEntry[];
  /** An Active mentor with a live Slack account and no current CORI. */
  inSlackWithoutCori: boolean;
};

/**
 * Active mentors with a live Slack account and no current CORI — the Slack
 * half of "may have access", which Slack Pro cannot enforce. A student who
 * also mentors is a student, and gated by consent instead.
 */
export function mentorsInSlackWithoutCori(
  people: readonly SheetPerson[],
  hasLiveSlack: (p: SheetPerson) => boolean,
  asOf: IsoDate
): string[] {
  return people
    .filter(
      (p) =>
        p.status === "active" &&
        p.roles.includes("Mentor") &&
        !p.roles.includes("Student") &&
        !hasAccess(p, asOf) &&
        hasLiveSlack(p)
    )
    .map((p) => p.personId)
    .sort();
}

export const HELD_MEMBER_PREFIXES = [
  "group_member_held:",
  "cori_lapsed:",
] as const;

/** `kid@home.example` → `k…@home.example`. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "…";
  return `${address[0]}…${address.slice(at)}`;
}

export function heldSubjects(
  plans: readonly GroupPlanResult[],
  slackPlans: readonly SlackCopyPlan[] = [],
  inSlackWithoutCori: readonly string[] = []
): HeldSubject[] {
  const byKey = new Map<string, Omit<HeldSubject, "key" | "kind">>();
  const subject = (
    id: string,
    fresh: () => Omit<HeldSubject, "key" | "kind">
  ) => {
    const s = byKey.get(id) ?? fresh();
    byKey.set(id, s);
    return s;
  };
  for (const plan of plans) {
    for (const h of plan.held) {
      const personId =
        h.reason === "not_on_sheet" ? null : (h.personIds[0] ?? null);
      subject(personId ?? `address:${h.address}`, () => ({
        personId,
        address: personId ? null : h.address,
        slackUserId: null,
        entries: [],
        slack: [],
        inSlackWithoutCori: false,
      })).entries.push({
        group: plan.group,
        address: h.address,
        reason: h.reason,
      });
    }
  }
  for (const plan of slackPlans) {
    for (const h of plan.held) {
      subject(h.personId ?? `slack:${h.slackUserId}`, () => ({
        personId: h.personId,
        address: null,
        slackUserId: h.personId ? null : h.slackUserId,
        entries: [],
        slack: [],
        inSlackWithoutCori: false,
      })).slack.push({
        copy: plan.copy,
        slackUserId: h.slackUserId,
        reason: h.reason,
      });
    }
  }
  for (const personId of inSlackWithoutCori) {
    subject(personId, () => ({
      personId,
      address: null,
      slackUserId: null,
      entries: [],
      slack: [],
      inSlackWithoutCori: false,
    })).inSlackWithoutCori = true;
  }
  return [...byKey.entries()].map(([id, s]) => {
    // Vacuously true for a mentor held nowhere but in Slack itself.
    const coriOnly = [...s.entries, ...s.slack].every(
      (e) => e.reason === "no_access"
    );
    const kind = coriOnly ? "cori_lapsed" : "group_member_held";
    return { ...s, kind, key: dedupeKey(kind, id) };
  });
}

const WHY: Record<Exclude<HeldReason, "not_on_sheet">, string> = {
  inactive: "is Inactive on the lifecycle sheet",
  status_unknown:
    "has a blank or unknown Active/Inactive on the lifecycle sheet",
  role_gone: "no longer holds the role these groups are for",
  no_access: "does not have CORI current",
  other_address: "is in a group under a second address of theirs",
  parent_not_listed: "is no longer an Active student",
};

export function heldMemberFinding(
  s: HeldSubject,
  opts: {
    names: ReadonlyMap<string, string>;
    /** Whether this Person ID has a Slack account, for the reminder. */
    inSlack: (personId: string) => boolean;
    /** Slack user ID → name, for an account the sheet does not know. */
    slackNames?: ReadonlyMap<string, string>;
  }
): NewFinding {
  const own = s.entries.filter((e) => e.reason !== "parent_not_listed");
  const parents = s.entries.filter((e) => e.reason === "parent_not_listed");
  const groups = [
    ...new Set([
      ...own.map((e) => e.group),
      ...s.slack.map((e) => `@${SLACK_GROUP_IDS[e.copy].handle}`),
    ]),
  ].join(", ");
  const base = {
    dedupeKey: s.key,
    severity: "warn" as const,
    subjectRef:
      s.personId ??
      (s.address ? maskAddress(s.address) : null) ??
      s.slackUserId,
    detail: {
      personId: s.personId,
      entries: s.entries.map((e) => ({ group: e.group, reason: e.reason })),
      ...(s.slack.length
        ? { slack: s.slack.map((e) => ({ copy: e.copy, reason: e.reason })) }
        : {}),
      ...(s.inSlackWithoutCori ? { inSlackWithoutCori: true } : {}),
    },
  };

  if (!s.personId && s.slackUserId) {
    const name = opts.slackNames?.get(s.slackUserId);
    return {
      ...base,
      kind: "group_member_held",
      summary:
        `A Slack account the lifecycle sheet does not account for, ` +
        `${name ? `${name} (${s.slackUserId})` : s.slackUserId}, is in ` +
        `${groups}. Nothing was removed.`,
    };
  }

  if (!s.personId) {
    return {
      ...base,
      kind: "group_member_held",
      summary:
        `An address the lifecycle sheet does not account for, ` +
        `${maskAddress(s.address ?? "")}, is in ${groups}. Nothing was removed.`,
    };
  }

  const name = opts.names.get(s.personId);
  const who = name ? `${s.personId} ${name}` : s.personId;
  if (s.kind === "cori_lapsed") {
    const where = groups
      ? `is still in ${groups}` +
        (s.inSlackWithoutCori ? ", and has a Slack account" : "")
      : "has a Slack account";
    const rejoin = groups
      ? " They rejoin on their own once a current CORI Expiry is on the sheet" +
        (opts.inSlack(s.personId)
          ? " (the Slack groups when an administrator clicks Apply)."
          : ".")
      : "";
    const slack = s.inSlackWithoutCori
      ? " Slack Pro cannot restrict a member: an administrator should " +
        "deactivate their Slack account until a current CORI Expiry is on " +
        "the sheet, or enter it there if CORI is done."
      : "";
    return {
      ...base,
      kind: "cori_lapsed",
      summary:
        `${who} does not have CORI current, and ${where}. Nothing was ` +
        `removed.${rejoin}${slack}`,
    };
  }

  const why =
    WHY[(own[0] ?? parents[0] ?? s.slack[0])!.reason as keyof typeof WHY];
  const where = [
    groups ? `still in ${groups}` : "",
    parents.length
      ? `${parents.length === 1 ? "a parent" : `${parents.length} parents`} ` +
        `still in grp-parents`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  return {
    ...base,
    kind: "group_member_held",
    summary: `${who} ${why}: ${where}. Nothing was removed.`,
  };
}
