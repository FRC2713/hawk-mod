import { db } from "./client.js";
import { decrypt, encrypt } from "../crypto.js";
import { nowIso } from "../domain/dates.js";
import type { Consent } from "../domain/rules/consent.js";
import type {
  Finding,
  FindingKind,
  FindingStatus,
  NewFinding,
} from "../domain/findings.js";
import type { Person, Role } from "../domain/people.js";

/* ------------------------------------------------------------------ people */

export type PersonInput = {
  email: string;
  fullName: string;
  role: Role;
  slackUserId?: string | null;
  active?: boolean;
  yppCompletedOn?: string | null;
  mentorReadyOn?: string | null;
  coriCompletedOn?: string | null;
  notes?: string | null;
};

/** Upsert by email — the roster's stable identity, since Slack ids arrive later. */
export function upsertPerson(input: PersonInput): Person {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO people (slack_user_id, email, full_name, role, active,
                           ypp_completed_on, mentor_ready_on, cori_completed_on,
                           notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET
         slack_user_id     = COALESCE(excluded.slack_user_id, people.slack_user_id),
         full_name         = excluded.full_name,
         role              = excluded.role,
         active            = excluded.active,
         ypp_completed_on  = COALESCE(excluded.ypp_completed_on, people.ypp_completed_on),
         mentor_ready_on   = COALESCE(excluded.mentor_ready_on, people.mentor_ready_on),
         cori_completed_on = COALESCE(excluded.cori_completed_on, people.cori_completed_on),
         notes             = COALESCE(excluded.notes, people.notes),
         updated_at        = excluded.updated_at`
    )
    .run(
      input.slackUserId ?? null,
      input.email,
      input.fullName,
      input.role,
      input.active === false ? 0 : 1,
      input.yppCompletedOn ?? null,
      input.mentorReadyOn ?? null,
      input.coriCompletedOn ?? null,
      input.notes ?? null,
      now,
      now
    );
  const person = personByEmail(input.email);
  if (!person) throw new Error(`Upsert failed for ${input.email}`);
  return person;
}

export function personByEmail(email: string): Person | undefined {
  return db()
    .prepare<[string], Person>("SELECT * FROM people WHERE email = ?")
    .get(email);
}

export function personBySlackId(slackUserId: string): Person | undefined {
  return db()
    .prepare<[string], Person>("SELECT * FROM people WHERE slack_user_id = ?")
    .get(slackUserId);
}

export function personById(id: number): Person | undefined {
  return db()
    .prepare<[number], Person>("SELECT * FROM people WHERE id = ?")
    .get(id);
}

export function listPeople(activeOnly = true): Person[] {
  const sql = activeOnly
    ? "SELECT * FROM people WHERE active = 1 ORDER BY full_name"
    : "SELECT * FROM people ORDER BY full_name";
  return db().prepare<[], Person>(sql).all();
}

export function linkSlackAccount(personId: number, slackUserId: string): void {
  db()
    .prepare("UPDATE people SET slack_user_id = ?, updated_at = ? WHERE id = ?")
    .run(slackUserId, nowIso(), personId);
}

/** Roster rows keyed by Slack id, for resolving conversation participants. */
export function peopleBySlackId(): Map<string, Person> {
  const map = new Map<string, Person>();
  for (const p of listPeople(false)) {
    if (p.slack_user_id) map.set(p.slack_user_id, p);
  }
  return map;
}

/**
 * Changes a role and records why, in one transaction. The `role_changes` row
 * is the point: Slack's audit log is Enterprise Grid only, so without this
 * there would be no trail of who was monitored when.
 */
export function setPersonRole(args: {
  personId: number;
  toRole: Role;
  source: string;
  detail?: unknown;
}): void {
  const now = nowIso();
  const person = personById(args.personId);
  if (!person) throw new Error(`No person ${args.personId}`);
  db().transaction(() => {
    db()
      .prepare("UPDATE people SET role = ?, updated_at = ? WHERE id = ?")
      .run(args.toRole, now, args.personId);
    db()
      .prepare(
        `INSERT INTO role_changes (person_id, slack_user_id, from_role, to_role,
                                   source, detail, changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        args.personId,
        person.slack_user_id,
        person.role,
        args.toRole,
        args.source,
        args.detail === undefined ? null : JSON.stringify(args.detail),
        now
      );
  })();
}

/**
 * Creates a roster row for a Slack account that is in a user group but was
 * never imported. Email may be absent, so the row is keyed on the Slack id —
 * this is what stops a group member from silently resolving to "unknown".
 */
export function createPersonFromSlack(args: {
  slackUserId: string;
  email: string | null;
  fullName: string;
  role: Role;
  source: string;
}): Person {
  const now = nowIso();
  const email = args.email ?? `${args.slackUserId}@slack.local`;
  db()
    .prepare(
      `INSERT INTO people (slack_user_id, email, full_name, role, active,
                           notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET
         slack_user_id = excluded.slack_user_id,
         updated_at    = excluded.updated_at`
    )
    .run(
      args.slackUserId,
      email,
      args.fullName,
      args.role,
      `created from Slack user group by ${args.source}`,
      now,
      now
    );
  const person = personBySlackId(args.slackUserId);
  if (!person)
    throw new Error(`Could not create person for ${args.slackUserId}`);
  db()
    .prepare(
      `INSERT INTO role_changes (person_id, slack_user_id, from_role, to_role,
                                 source, detail, changed_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`
    )
    .run(
      person.id,
      args.slackUserId,
      args.role,
      args.source,
      JSON.stringify({ created: true, email: args.email }),
      now
    );
  return person;
}

export const SCREENING_FIELDS = [
  "ypp_completed_on",
  "mentor_ready_on",
  "cori_completed_on",
] as const;

export type ScreeningField = (typeof SCREENING_FIELDS)[number];

/**
 * Writes screening dates and records who supplied each one. Only fields
 * actually passed are touched, so a modal that fills one date does not erase
 * the other two. Returns the fields that changed.
 */
export function setScreeningDates(args: {
  personId: number;
  values: Partial<Record<ScreeningField, string | null>>;
  recordedBy: string;
  source: string;
}): ScreeningField[] {
  const person = personById(args.personId);
  if (!person) throw new Error(`No person ${args.personId}`);
  const now = nowIso();
  const changed: ScreeningField[] = [];

  db().transaction(() => {
    for (const field of SCREENING_FIELDS) {
      if (!(field in args.values)) continue;
      const to = args.values[field] ?? null;
      const from = person[field];
      if (from === to) continue;
      db()
        .prepare(`UPDATE people SET ${field} = ?, updated_at = ? WHERE id = ?`)
        .run(to, now, args.personId);
      db()
        .prepare(
          `INSERT INTO screening_changes (person_id, field, from_value, to_value,
                                          source, recorded_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(args.personId, field, from, to, args.source, args.recordedBy, now);
      changed.push(field);
    }
  })();

  return changed;
}

export function listScreeningChanges(limit = 100) {
  return db()
    .prepare<
      [number],
      {
        id: number;
        person_id: number;
        field: string;
        from_value: string | null;
        to_value: string | null;
        source: string;
        recorded_by: string;
        changed_at: string;
      }
    >("SELECT * FROM screening_changes ORDER BY changed_at DESC LIMIT ?")
    .all(limit);
}

export function listRoleChanges(limit = 100) {
  return db()
    .prepare<
      [number],
      {
        id: number;
        person_id: number;
        slack_user_id: string | null;
        from_role: string | null;
        to_role: string;
        source: string;
        detail: string | null;
        changed_at: string;
      }
    >("SELECT * FROM role_changes ORDER BY changed_at DESC LIMIT ?")
    .all(limit);
}

/* ---------------------------------------------------------------- consents */

export type ConsentInput = {
  personId: number;
  signedOn: string;
  expiresOn: string;
  formVersion: string;
  guardianName: string;
  guardianEmail?: string | null;
  documentRef?: string | null;
  recordedBy: string;
};

export function insertConsent(input: ConsentInput): void {
  db()
    .prepare(
      `INSERT INTO consents (person_id, signed_on, expires_on, form_version,
                             guardian_name, guardian_email, document_ref,
                             recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.personId,
      input.signedOn,
      input.expiresOn,
      input.formVersion,
      input.guardianName,
      input.guardianEmail ?? null,
      input.documentRef ?? null,
      input.recordedBy,
      nowIso()
    );
}

export function listConsents(): Consent[] {
  return db()
    .prepare<[], Consent>("SELECT * FROM consents ORDER BY signed_on DESC")
    .all();
}

export function revokeConsent(consentId: number, on: string): void {
  db()
    .prepare("UPDATE consents SET revoked_on = ? WHERE id = ?")
    .run(on, consentId);
}

/* ----------------------------------------------------------- installations */

export type StoredInstallation = {
  teamId: string;
  enterpriseId: string | null;
  slackUserId: string;
  kind: "bot" | "user";
  payload: Record<string, unknown>;
  scopes: string | null;
  installedAt: string;
  revokedAt: string | null;
};

type InstallationRow = {
  team_id: string;
  enterprise_id: string | null;
  slack_user_id: string;
  kind: "bot" | "user";
  payload_enc: string;
  scopes: string | null;
  installed_at: string;
  revoked_at: string | null;
};

/** Bot installations share one row per team; '-' keeps the UNIQUE index honest. */
export const BOT_USER_KEY = "-";

export function saveInstallation(args: {
  teamId: string;
  enterpriseId?: string | null;
  slackUserId: string;
  kind: "bot" | "user";
  payload: unknown;
  scopes?: string | null;
}): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO installations (team_id, enterprise_id, slack_user_id, kind,
                                  payload_enc, scopes, installed_at, updated_at,
                                  revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (team_id, kind, slack_user_id) DO UPDATE SET
         payload_enc = excluded.payload_enc,
         scopes      = excluded.scopes,
         updated_at  = excluded.updated_at,
         revoked_at  = NULL`
    )
    .run(
      args.teamId,
      args.enterpriseId ?? null,
      args.slackUserId,
      args.kind,
      encrypt(JSON.stringify(args.payload)),
      args.scopes ?? null,
      now,
      now
    );
}

function hydrate(row: InstallationRow): StoredInstallation {
  return {
    teamId: row.team_id,
    enterpriseId: row.enterprise_id,
    slackUserId: row.slack_user_id,
    kind: row.kind,
    payload: JSON.parse(decrypt(row.payload_enc)) as Record<string, unknown>,
    scopes: row.scopes,
    installedAt: row.installed_at,
    revokedAt: row.revoked_at,
  };
}

export function getInstallation(
  teamId: string,
  kind: "bot" | "user",
  slackUserId: string
): StoredInstallation | undefined {
  const row = db()
    .prepare<[string, string, string], InstallationRow>(
      `SELECT * FROM installations
       WHERE team_id = ? AND kind = ? AND slack_user_id = ?`
    )
    .get(teamId, kind, slackUserId);
  return row ? hydrate(row) : undefined;
}

/** Any bot installation; there is one workspace, so the first row is it. */
export function anyBotInstallation(): StoredInstallation | undefined {
  const row = db()
    .prepare<[], InstallationRow>(
      "SELECT * FROM installations WHERE kind = 'bot' AND revoked_at IS NULL LIMIT 1"
    )
    .get();
  return row ? hydrate(row) : undefined;
}

export function listUserInstallations(
  includeRevoked = false
): StoredInstallation[] {
  const sql = includeRevoked
    ? "SELECT * FROM installations WHERE kind = 'user'"
    : "SELECT * FROM installations WHERE kind = 'user' AND revoked_at IS NULL";
  return db().prepare<[], InstallationRow>(sql).all().map(hydrate);
}

export function markInstallationRevoked(
  teamId: string,
  kind: "bot" | "user",
  slackUserId: string
): void {
  db()
    .prepare(
      `UPDATE installations SET revoked_at = ?, updated_at = ?
       WHERE team_id = ? AND kind = ? AND slack_user_id = ?
         AND revoked_at IS NULL`
    )
    .run(nowIso(), nowIso(), teamId, kind, slackUserId);
}

export function deleteInstallation(
  teamId: string,
  kind: "bot" | "user",
  slackUserId: string
): void {
  db()
    .prepare(
      `DELETE FROM installations
       WHERE team_id = ? AND kind = ? AND slack_user_id = ?`
    )
    .run(teamId, kind, slackUserId);
}

/* ----------------------------------------------------------- conversations */

export type ConversationRow = {
  id: string;
  team_id: string;
  type: "im" | "mpim";
  participants: string;
  monitored: number;
  verdict: string | null;
  first_seen_at: string;
  last_evaluated_at: string;
  last_backfill_ts: string | null;
};

export function upsertConversation(args: {
  id: string;
  teamId: string;
  type: "im" | "mpim";
  participants: string[];
  monitored: boolean;
  verdict: unknown;
}): void {
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO conversations (id, team_id, type, participants, monitored,
                                  verdict, first_seen_at, last_evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         participants      = excluded.participants,
         monitored         = excluded.monitored,
         verdict           = excluded.verdict,
         last_evaluated_at = excluded.last_evaluated_at`
    )
    .run(
      args.id,
      args.teamId,
      args.type,
      JSON.stringify([...args.participants].sort()),
      args.monitored ? 1 : 0,
      JSON.stringify(args.verdict),
      now,
      now
    );
}

export function getConversation(id: string): ConversationRow | undefined {
  return db()
    .prepare<[string], ConversationRow>(
      "SELECT * FROM conversations WHERE id = ?"
    )
    .get(id);
}

export function listMonitoredConversations(): ConversationRow[] {
  return db()
    .prepare<[], ConversationRow>(
      "SELECT * FROM conversations WHERE monitored = 1 ORDER BY last_evaluated_at DESC"
    )
    .all();
}

export function setBackfillCursor(conversationId: string, ts: string): void {
  db()
    .prepare("UPDATE conversations SET last_backfill_ts = ? WHERE id = ?")
    .run(ts, conversationId);
}

/* --------------------------------------------------------------- messages */

export type MessageInput = {
  conversationId: string;
  ts: string;
  threadTs?: string | null;
  authorSlackId: string;
  authorPersonId?: number | null;
  text: string | null;
  charCount: number;
  files?: unknown;
  subtype?: string | null;
  source: "event" | "backfill";
  observedVia: string;
};

/**
 * Returns true when the row was new. Both adults in a group DM deliver the
 * same message, and backfill re-walks what events already caught, so the
 * (conversation_id, ts) uniqueness is what keeps the log from double-counting.
 */
export function insertMessage(input: MessageInput): boolean {
  const result = db()
    .prepare(
      `INSERT INTO dm_messages (conversation_id, ts, thread_ts, author_slack_id,
                                author_person_id, text, char_count, files,
                                subtype, source, observed_via, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, ts) DO NOTHING`
    )
    .run(
      input.conversationId,
      input.ts,
      input.threadTs ?? null,
      input.authorSlackId,
      input.authorPersonId ?? null,
      input.text,
      input.charCount,
      input.files ? JSON.stringify(input.files) : null,
      input.subtype ?? null,
      input.source,
      input.observedVia,
      nowIso()
    );
  return result.changes > 0;
}

/**
 * Keeps the superseded text; an edit must not erase what a message said.
 * Returns false when the original was never observed, so the caller can record
 * the edited version rather than losing the message entirely.
 */
export function applyEdit(
  conversationId: string,
  ts: string,
  newText: string | null,
  newCharCount: number
): boolean {
  const row = db()
    .prepare<[string, string], { id: number; text: string | null }>(
      "SELECT id, text FROM dm_messages WHERE conversation_id = ? AND ts = ?"
    )
    .get(conversationId, ts);
  if (!row) return false;
  const now = nowIso();
  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO dm_message_revisions (message_id, previous_text, replaced_at)
         VALUES (?, ?, ?)`
      )
      .run(row.id, row.text, now);
    db()
      .prepare(
        "UPDATE dm_messages SET text = ?, char_count = ?, edited_at = ? WHERE id = ?"
      )
      .run(newText, newCharCount, now, row.id);
  })();
  return true;
}

export function markMessageDeleted(conversationId: string, ts: string): void {
  db()
    .prepare(
      `UPDATE dm_messages SET deleted_at = ?
       WHERE conversation_id = ? AND ts = ? AND deleted_at IS NULL`
    )
    .run(nowIso(), conversationId, ts);
}

export function messageStats(conversationId: string): {
  total: number;
  deleted: number;
  edited: number;
  firstTs: string | null;
  lastTs: string | null;
} {
  const row = db()
    .prepare<
      [string],
      {
        total: number;
        deleted: number;
        edited: number;
        firstTs: string | null;
        lastTs: string | null;
      }
    >(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted,
              SUM(CASE WHEN edited_at IS NOT NULL THEN 1 ELSE 0 END) AS edited,
              MIN(ts) AS firstTs, MAX(ts) AS lastTs
       FROM dm_messages WHERE conversation_id = ?`
    )
    .get(conversationId);
  return (
    row ?? { total: 0, deleted: 0, edited: 0, firstTs: null, lastTs: null }
  );
}

/* --------------------------------------------------------------- findings */

/**
 * Re-detecting an open finding refreshes `last_seen_at` and nothing else.
 * Re-detecting a resolved one reopens it: a violation that comes back is not
 * the same as one somebody already dealt with.
 */
export function upsertFinding(f: NewFinding): { id: number; isNew: boolean } {
  const now = nowIso();
  const existing = db()
    .prepare<[string], Finding>("SELECT * FROM findings WHERE dedupe_key = ?")
    .get(f.dedupeKey);

  if (!existing) {
    const info = db()
      .prepare(
        `INSERT INTO findings (kind, dedupe_key, severity, summary, detail,
                               subject_person_id, subject_ref, status,
                               first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(
        f.kind,
        f.dedupeKey,
        f.severity,
        f.summary,
        f.detail === undefined ? null : JSON.stringify(f.detail),
        f.subjectPersonId ?? null,
        f.subjectRef ?? null,
        now,
        now
      );
    return { id: Number(info.lastInsertRowid), isNew: true };
  }

  const reopened = existing.status === "resolved";
  db()
    .prepare(
      `UPDATE findings
       SET last_seen_at = ?, summary = ?, detail = ?, severity = ?,
           status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
           resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END
       WHERE id = ?`
    )
    .run(
      now,
      f.summary,
      f.detail === undefined ? null : JSON.stringify(f.detail),
      f.severity,
      existing.id
    );
  return { id: existing.id, isNew: reopened };
}

export function listFindings(status?: FindingStatus): Finding[] {
  const sql = status
    ? "SELECT * FROM findings WHERE status = ? ORDER BY severity DESC, last_seen_at DESC"
    : "SELECT * FROM findings ORDER BY last_seen_at DESC";
  return status
    ? db().prepare<[string], Finding>(sql).all(status)
    : db().prepare<[], Finding>(sql).all();
}

export function getFinding(id: number): Finding | undefined {
  return db()
    .prepare<[number], Finding>("SELECT * FROM findings WHERE id = ?")
    .get(id);
}

export function findingByKey(key: string): Finding | undefined {
  return db()
    .prepare<[string], Finding>("SELECT * FROM findings WHERE dedupe_key = ?")
    .get(key);
}

export function resolveFinding(
  id: number,
  by: string,
  note: string,
  status: Exclude<FindingStatus, "open"> = "resolved"
): boolean {
  const info = db()
    .prepare(
      `UPDATE findings
       SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?
       WHERE id = ?`
    )
    .run(status, nowIso(), by, note, id);
  return info.changes > 0;
}

export function setFindingAlertTs(id: number, ts: string): void {
  db().prepare("UPDATE findings SET alert_ts = ? WHERE id = ?").run(ts, id);
}

/**
 * Closes findings of the given kinds that this sweep did not re-detect. Without
 * this the board's open list only ever grows and stops meaning anything.
 * Deliberately excludes `adult_student_dm`: a prohibited DM that happened is a
 * historical fact, and only a human should be able to close it.
 */
export function autoResolveMissing(
  kinds: FindingKind[],
  seenKeys: ReadonlySet<string>
): number[] {
  if (kinds.length === 0) return [];
  const placeholders = kinds.map(() => "?").join(",");
  const open = db()
    .prepare<string[], Finding>(
      `SELECT * FROM findings WHERE status != 'resolved' AND kind IN (${placeholders})`
    )
    .all(...kinds);
  const closed: number[] = [];
  for (const f of open) {
    if (seenKeys.has(f.dedupe_key)) continue;
    resolveFinding(f.id, "hawk-mod", "No longer detected by the sweep.");
    closed.push(f.id);
  }
  return closed;
}

export function countOpenByKind(): Record<string, number> {
  const rows = db()
    .prepare<[], { kind: FindingKind; n: number }>(
      "SELECT kind, COUNT(*) AS n FROM findings WHERE status = 'open' GROUP BY kind"
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

/* ------------------------------------------------------------- audit runs */

export function startAuditRun(kind: string): number {
  const info = db()
    .prepare("INSERT INTO audit_runs (kind, started_at) VALUES (?, ?)")
    .run(kind, nowIso());
  return Number(info.lastInsertRowid);
}

export function finishAuditRun(id: number, stats: unknown): void {
  db()
    .prepare("UPDATE audit_runs SET finished_at = ?, stats = ? WHERE id = ?")
    .run(nowIso(), JSON.stringify(stats), id);
}

export function signOffAuditRun(id: number, by: string, note: string): boolean {
  const info = db()
    .prepare(
      "UPDATE audit_runs SET signed_off_by = ?, signed_off_at = ?, note = ? WHERE id = ?"
    )
    .run(by, nowIso(), note, id);
  return info.changes > 0;
}

export function lastAuditRun(kind: string) {
  return db()
    .prepare<
      [string],
      { id: number; started_at: string; signed_off_at: string | null }
    >(
      `SELECT id, started_at, signed_off_at FROM audit_runs
       WHERE kind = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(kind);
}
