import type { SheetPerson } from "./sheet.js";

/**
 * Who someone is, in a lifecycle preview: `P0101 Alex S. (Student)`.
 *
 * Every preview an administrator reads before applying a change names each
 * person this way (#74). A list of bare Person IDs cannot be checked without
 * opening the sheet and looking each one up, so the check meant to catch a
 * mistake tended not to happen. The Person ID still identifies them exactly —
 * two people can both be `Alex S.` — and `/hawkmod whois` gives the rest.
 *
 * The short form, rather than the full name, because these replies travel:
 * they are pasted into an import session (`import-people`), and a first name
 * and an initial are enough to spot the wrong person without putting every
 * student's full name wherever the reply goes. Addresses never appear: that
 * rule is unchanged, and only the CLI's `--members` prints one.
 *
 * Why naming people here is safe at all: every preview is an ephemeral reply
 * to an administrator (the slash command is gated on `administrator()`), the
 * hourly runs discard the text, and `slack_groups_differ` — the one preview
 * posted as an alert — is in the alert channel, which already names people.
 */

/** Person ID → label, for the reports. */
export type PersonLabels = ReadonlyMap<string, string>;

function initial(last: string): string | null {
  // The first letter, so `'t Hooft` is `T.` and `O'Brien` is `O.`.
  const c = last.match(/\p{L}/u)?.[0] ?? Array.from(last)[0];
  return c ? `${c.toUpperCase()}.` : null;
}

/**
 * Preferred first name (the caller picks it over the legal one) and the legal
 * last name's initial: `Alex S.`. The two are taken apart because the last
 * name can be several words (`Van Der Berg` is `V.`), which no split of a
 * combined name gets right. Null when there is no name at all.
 */
export function shortName(first: string, last: string): string | null {
  const f = first.trim();
  const l = last.trim();
  const parts = [f, l ? initial(l) : null].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/**
 * The best that can be done with a combined name, for roster rows the sheet
 * no longer has: the first word, and the initial of the word after it. The
 * second word rather than the last, so `Van Der Berg` and a double surname
 * (`García López`) both give the right initial; a double first name gives
 * the second one's instead, which still says who it is.
 */
export function shortNameOf(
  fullName: string | null | undefined
): string | null {
  const words = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return shortName(words[0]!, words.slice(1).join(" "));
}

/** `P0101 Alex S. (Student)`; the name or the role left out when there is none. */
export function personLabel(
  personId: string,
  short: string | null,
  roles: readonly string[]
): string {
  return (
    personId +
    (short ? ` ${short}` : "") +
    (roles.length ? ` (${roles.join(", ")})` : "")
  );
}

/** Every person on the sheet, labelled. */
export function personLabels(
  people: readonly Pick<SheetPerson, "personId" | "shortName" | "roles">[]
): PersonLabels {
  return new Map(
    people.map((p) => [
      p.personId,
      personLabel(p.personId, p.shortName, p.roles),
    ])
  );
}

/**
 * The label for a Person ID. Someone the sheet no longer has (a roster row
 * whose Person ID is gone) is named from `fallbackName`, cut down the same
 * way and with no role, since the sheet gives none; with neither, the bare ID.
 */
export function labelOf(
  labels: PersonLabels,
  personId: string,
  fallbackName?: string | null
): string {
  return (
    labels.get(personId) ?? personLabel(personId, shortNameOf(fallbackName), [])
  );
}
