import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { applyMigration, ensureMigrationsTable } from "../src/db/client.js";

/**
 * Migration 0009 rebuilds `people`, the parent of every ON DELETE CASCADE in
 * the schema. Done wrong, it deletes every consent, role change and screening
 * change on record while appearing to succeed — the first version of it did.
 * So this runs it through the runner's own `applyMigration`, from a connection
 * with foreign keys on as `db()` opens one, and checks the children are all
 * still there and still point at `people`.
 */
const dir = join(import.meta.dirname, "..", "migrations");
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

function apply(db: Database.Database, file: string) {
  applyMigration(db, file, readFileSync(join(dir, file), "utf8"));
}

function before0009() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  ensureMigrationsTable(db);
  for (const f of files) if (f < "0009") apply(db, f);
  const now = "2026-09-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO people (id, slack_user_id, email, full_name, role, active,
       cori_expires_on, created_at, updated_at)
     VALUES (7, 'U7', 'mentor@example.org', 'A Mentor', 'adult', 1,
       '2028-01-01', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO consents (person_id, signed_on, expires_on, form_version,
       guardian_name, recorded_by, created_at)
     VALUES (7, '2026-08-01', '2027-08-01', 'v1', 'G', 'x', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO role_changes (person_id, from_role, to_role, source, changed_at)
     VALUES (7, NULL, 'adult', 'csv', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO screening_changes (person_id, field, to_value, source,
       recorded_by, changed_at)
     VALUES (7, 'cori_expires_on', '2028-01-01', 'csv', 'x', ?)`
  ).run(now);
  return db;
}

function after0009() {
  const db = before0009();
  apply(
    db,
    files.find((f) => f.startsWith("0009_"))!
  );
  return db;
}

const count = (db: Database.Database, table: string) =>
  db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n;

describe("migration 0009: the roster can be built from the sheet", () => {
  it("keeps every row and date, under the same id", () => {
    const db = after0009();
    const p = db
      .prepare<[], { id: number; email: string; cori_expires_on: string }>(
        "SELECT id, email, cori_expires_on FROM people"
      )
      .all();
    assert.deepEqual(p, [
      { id: 7, email: "mentor@example.org", cori_expires_on: "2028-01-01" },
    ]);
  });

  it("deletes nothing that hangs off people", () => {
    const db = after0009();
    assert.equal(count(db, "consents"), 1);
    assert.equal(count(db, "role_changes"), 1);
    assert.equal(count(db, "screening_changes"), 1);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  });

  it("needs its first line: without it, consents are deleted", () => {
    // Why the runner's foreign_keys marker exists, shown rather than asserted.
    const db = before0009();
    const f = files.find((x) => x.startsWith("0009_"))!;
    const sql = readFileSync(join(dir, f), "utf8");
    applyMigration(db, f, sql.slice(sql.indexOf("\n") + 1));
    assert.equal(count(db, "consents"), 0);
  });

  it("leaves the children pointing at people, not the old table", () => {
    const db = after0009();
    const sql = db
      .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master")
      .all()
      .map((r) => r.sql ?? "")
      .join("\n");
    assert.ok(!sql.includes("people_new"));
    // Foreign keys are back on, and the cascade reaches the new table.
    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    db.prepare("DELETE FROM people WHERE id = 7").run();
    assert.equal(count(db, "consents"), 0);
  });

  it("allows a person with no identity email, and more than one", () => {
    const db = after0009();
    const insert = db.prepare(
      `INSERT INTO people (person_id, full_name, role, created_at, updated_at)
       VALUES (?, 'X', 'adult', 'x', 'x')`
    );
    insert.run("P0101");
    insert.run("P0102");
    assert.equal(count(db, "people"), 3);
  });

  it("keeps email and Person ID unique", () => {
    const db = after0009();
    const insert = db.prepare(
      `INSERT INTO people (person_id, email, full_name, role, created_at,
         updated_at)
       VALUES (?, ?, 'X', 'adult', 'x', 'x')`
    );
    assert.throws(() => insert.run("P0200", "MENTOR@example.org"), /UNIQUE/);
    insert.run("P0201", null);
    assert.throws(() => insert.run("P0201", null), /UNIQUE/);
  });

  it("adds the student's Slack consent expiry, blank for everyone today", () => {
    const db = after0009();
    const r = db
      .prepare<
        [],
        { person_id: string | null; slack_consent_expires_on: string | null }
      >("SELECT person_id, slack_consent_expires_on FROM people")
      .get()!;
    assert.deepEqual(r, { person_id: null, slack_consent_expires_on: null });
  });
});
