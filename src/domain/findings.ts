export const FINDING_KINDS = [
  /** A DM/group DM that the conduct agreement does not permit. */
  "adult_student_dm",
  /** A student channel below two screened adults. */
  "lone_adult_channel",
  /** A Slack account for a student with no current parental consent. */
  "unconsented_account",
  /** A Slack account with no roster row at all. */
  "unknown_account",
  /** A adult whose screening has lapsed or was never recorded. */
  "screening_lapsed",
  /** A adult who has never authorized hawk-mod — their DMs are invisible. */
  "adult_not_enrolled",
  /** A previously enrolled adult whose token stopped working. */
  "enrollment_revoked",
  /** Fewer than two workspace owners, or a student holding admin (§6). */
  "workspace_config",
  /** A Slack user group moved someone out of `student`. */
  "roster_drift",
  /** Someone is in both the students and the adults user group. */
  "usergroup_conflict",
  /** A student authorized hawk-mod, which would expose their peer DMs. */
  "student_enrolled",
] as const;

export type FindingKind = (typeof FINDING_KINDS)[number];
export type Severity = "info" | "warn" | "violation";
export type FindingStatus = "open" | "acknowledged" | "resolved";

export type Finding = {
  id: number;
  kind: FindingKind;
  dedupe_key: string;
  severity: Severity;
  summary: string;
  detail: string | null;
  subject_person_id: number | null;
  subject_ref: string | null;
  status: FindingStatus;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  alert_ts: string | null;
};

export type NewFinding = {
  kind: FindingKind;
  dedupeKey: string;
  severity: Severity;
  summary: string;
  detail?: unknown;
  subjectPersonId?: number | null;
  subjectRef?: string | null;
};

/**
 * The identity of a finding across sweeps. Two sweeps that notice the same
 * problem must land on the same key, or the alert channel becomes noise and
 * nobody reads it — which is the failure mode §4.4 warns about.
 */
export function dedupeKey(kind: FindingKind, ...parts: string[]): string {
  return [kind, ...parts].join(":");
}

const EMOJI: Record<Severity, string> = {
  info: ":information_source:",
  warn: ":warning:",
  violation: ":rotating_light:",
};

export function severityEmoji(s: Severity): string {
  return EMOJI[s];
}
