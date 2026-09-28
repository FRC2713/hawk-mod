import { dedupeKey, type NewFinding } from "../findings.js";
import type { GroupPlanResult, HeldReason } from "./groupPlan.js";
import type { GroupName } from "./groups.js";

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
 */

export type HeldEntry = {
  group: GroupName;
  address: string;
  reason: HeldReason;
};

export type HeldSubject = {
  /** The finding's dedupe key; also what the button re-finds at the click. */
  key: string;
  kind: "group_member_held" | "cori_lapsed";
  /** Whose these entries are; null for an address the sheet cannot place. */
  personId: string | null;
  /** The address, for a subject with no Person ID. */
  address: string | null;
  entries: HeldEntry[];
};

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

export function heldSubjects(plans: readonly GroupPlanResult[]): HeldSubject[] {
  const byKey = new Map<string, Omit<HeldSubject, "key" | "kind">>();
  for (const plan of plans) {
    for (const h of plan.held) {
      const personId =
        h.reason === "not_on_sheet" ? null : (h.personIds[0] ?? null);
      const subject = personId ?? `address:${h.address}`;
      const s = byKey.get(subject) ?? {
        personId,
        address: personId ? null : h.address,
        entries: [],
      };
      s.entries.push({
        group: plan.group,
        address: h.address,
        reason: h.reason,
      });
      byKey.set(subject, s);
    }
  }
  return [...byKey.entries()].map(([subject, s]) => {
    const coriOnly = s.entries.every((e) => e.reason === "no_access");
    const kind = coriOnly ? "cori_lapsed" : "group_member_held";
    return { ...s, kind, key: dedupeKey(kind, subject) };
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
  }
): NewFinding {
  const own = s.entries.filter((e) => e.reason !== "parent_not_listed");
  const parents = s.entries.filter((e) => e.reason === "parent_not_listed");
  const groups = [...new Set(own.map((e) => e.group))].join(", ");
  const base = {
    dedupeKey: s.key,
    severity: "warn" as const,
    subjectRef: s.personId ?? (s.address ? maskAddress(s.address) : null),
    detail: {
      personId: s.personId,
      entries: s.entries.map((e) => ({ group: e.group, reason: e.reason })),
    },
  };

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
    return {
      ...base,
      kind: "cori_lapsed",
      summary:
        `${who} does not have CORI current, and is still in ${groups}. ` +
        `Nothing was removed; they rejoin on their own once a current CORI ` +
        `Expiry is on the sheet.` +
        (opts.inSlack(s.personId)
          ? " If they are removed, an administrator must also take them out of " +
            "Slack: hawk-mod cannot, on Slack Pro."
          : ""),
    };
  }

  const why = WHY[(own[0] ?? parents[0])!.reason as keyof typeof WHY];
  const where = [
    own.length ? `still in ${groups}` : "",
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
