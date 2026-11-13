import type { IsoDate } from "./dates.js";
import type { Person, Role } from "./people.js";
import { consentStatus } from "./rules/consent.js";

/**
 * The one line posted to `onboarding-channel` when anyone joins Slack (#86):
 * who they are on the lifecycle sheet and, for a student, where their Slack
 * Consent stands. Information, not a finding — the `unconsented_account` and
 * `unknown_account` findings are raised alongside it when they apply, and
 * this carries no buttons.
 *
 * It exists because a workspace with an approved sign-up domain lets a
 * student in with no invite, and the people who handle invites should hear
 * about it where they already look. Pure, so its words are tested.
 *
 * Names a person by Person ID and name, and an unknown account by its Slack
 * name — never by email: most of the people joining are minors, and the
 * channel is not the place for their addresses.
 */
export function joinNotice(
  person: Pick<
    Person,
    "person_id" | "full_name" | "role" | "slack_consent_expires_on"
  > | null,
  account: { id: string; name: string | null; realName: string | null },
  asOf: IsoDate
): string {
  if (!person) {
    const who = account.realName || account.name || account.id;
    const handle = account.name ? ` (@${account.name})` : "";
    return (
      `:wave: ${who}${handle} joined Slack, and is not on the lifecycle ` +
      `sheet.`
    );
  }
  const who = person.person_id
    ? `${person.person_id} ${person.full_name}`
    : person.full_name;
  const line = `:wave: ${who} (${ROLE_LABEL[person.role]}) joined Slack.`;
  if (person.role !== "student") return line;
  const consent = consentStatus(person, asOf);
  switch (consent.state) {
    case "valid":
      return `${line} Slack Consent form: current, to ${consent.expiresOn}.`;
    case "expired":
      return (
        `${line} :rotating_light: Slack Consent form: expired ` +
        `${consent.expiresOn}.`
      );
    default:
      return `${line} :rotating_light: Slack Consent form: missing.`;
  }
}

const ROLE_LABEL: Record<Role, string> = {
  student: "Student",
  adult: "Adult",
  district_observer: "District observer",
};
