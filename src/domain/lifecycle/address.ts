/**
 * When two email addresses reach the same inbox. Gmail ignores dots in the
 * part before the @, and anything after a `+`, and `googlemail.com` is
 * `gmail.com`: `h.smith@gmail.com`, `hsmith@gmail.com` and
 * `hsmith+team@googlemail.com` are one account. Google Groups stores such a
 * member under the account's own spelling, whichever one was added — so a
 * parent on the sheet as `h.smith@gmail.com` sat in grp-parents as
 * `hsmith@gmail.com`, was "added" again every hour (Google answered "already
 * a member"), and held as an address nobody lists (#142, 2026-09-29).
 *
 * This is for comparing only. Anything sent to Google — an add, a removal —
 * uses the address as the sheet or the group has it. Every other domain is
 * compared lower-cased and otherwise as written: whether dots matter there is
 * that domain's business, and guessing would merge two different people.
 */
export function addressKey(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return a;
  const domain = a.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return a;
  const local = a.slice(0, at).split("+")[0]!.replace(/\./g, "");
  return `${local}@gmail.com`;
}
