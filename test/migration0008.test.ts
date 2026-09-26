import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { isScreenedAdult } from "../src/domain/rules/screening.js";
import type { Person } from "../src/domain/people.js";

/**
 * The one test that touches SQL, because this migration rewrites every
 * screening date on record, and a conversion that errs late would count an
 * unscreened adult toward the two-adult rule. It runs the real migration files
 * against an in-memory database; nothing else here needs a database.
 */
const dir = join(import.meta.dirname, "..", "migrations");
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

function migratedTo(last: string) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const f of files) {
    if (f > last) break;
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
  return db;
}

function before0008() {
  const db = migratedTo("0007");
  const insert = db.prepare(
    `INSERT INTO people (email, full_name, role, active, ypp_completed_on,
       ypt_completed_on, cori_completed_on, mentor_ready_on, created_at,
       updated_at)
     VALUES (?, ?, 'adult', 1, ?, ?, ?, ?, 'x', 'x')`
  );
  return { db, insert };
}

function apply0008(db: Database.Database) {
  const f = files.find((x) => x.startsWith("0008_"));
  assert.ok(f, "migration 0008 exists");
  db.exec(readFileSync(join(dir, f), "utf8"));
}

type Row = Pick<
  Person,
  | "screening_expires_on"
  | "training_expires_on"
  | "cori_expires_on"
  | "mentor_ready_completed_on"
>;

const row = (db: Database.Database, email: string) =>
  db
    .prepare<[string], Row>(
      `SELECT screening_expires_on, training_expires_on, cori_expires_on,
              mentor_ready_completed_on FROM people WHERE email = ?`
    )
    .get(email)!;

describe("migration 0008: completion dates become expiry dates", () => {
  it("gives the background screening three years, not four (#17)", () => {
    const { db, insert } = before0008();
    insert.run("a@x.org", "A", "2023-09-25", null, null, null);
    apply0008(db);
    assert.equal(row(db, "a@x.org").screening_expires_on, "2026-09-25");
  });

  it("does not count someone screened 3 years and 1 day ago (#17)", () => {
    const { db, insert } = before0008();
    insert.run("a@x.org", "A", "2023-09-25", "2026-08-13", "2025-01-01", null);
    apply0008(db);
    const p = db
      .prepare<[], Person>("SELECT * FROM people WHERE email = 'a@x.org'")
      .get()!;
    // Under the old 4-year window this adult was still screened.
    assert.equal(isScreenedAdult(p, "2026-09-25"), true);
    assert.equal(isScreenedAdult(p, "2026-09-26"), false);
  });

  it("expires training on the next 1 August, not a year on", () => {
    const { db, insert } = before0008();
    insert.run("aug@x.org", "A", null, "2026-08-13", null, null);
    insert.run("jul@x.org", "B", null, "2027-07-20", null, null);
    insert.run("on@x.org", "C", null, "2026-08-01", null, null);
    apply0008(db);
    assert.equal(row(db, "aug@x.org").training_expires_on, "2027-08-01");
    // Errs early: counted toward the season it was taken in.
    assert.equal(row(db, "jul@x.org").training_expires_on, "2027-08-01");
    assert.equal(row(db, "on@x.org").training_expires_on, "2027-08-01");
  });

  it("never lets a leap-day date slip into March", () => {
    const { db, insert } = before0008();
    insert.run("leap@x.org", "A", "2024-02-29", null, "2024-02-29", null);
    apply0008(db);
    const r = row(db, "leap@x.org");
    assert.equal(r.screening_expires_on, "2027-02-28");
    assert.equal(r.cori_expires_on, "2027-02-28");
  });

  it("keeps Mentor Ready as the date it was earned", () => {
    const { db, insert } = before0008();
    insert.run("mr@x.org", "A", null, null, null, "2025-10-01");
    apply0008(db);
    assert.equal(row(db, "mr@x.org").mentor_ready_completed_on, "2025-10-01");
  });

  it("records that the dates were computed, and by what rule", () => {
    const { db, insert } = before0008();
    insert.run("a@x.org", "A", "2024-01-01", "2026-01-01", null, null);
    apply0008(db);
    const changes = db
      .prepare<[], { field: string; source: string }>(
        "SELECT field, source FROM screening_changes ORDER BY field"
      )
      .all();
    assert.deepEqual(changes, [
      { field: "screening_expires_on", source: "migration" },
      { field: "training_expires_on", source: "migration" },
    ]);
  });

  it("drops the old columns, so nothing reads them under the old meaning", () => {
    const { db } = before0008();
    apply0008(db);
    const columns = db
      .prepare<[], { name: string }>("PRAGMA table_info(people)")
      .all()
      .map((c) => c.name);
    for (const old of [
      "ypp_completed_on",
      "ypt_completed_on",
      "cori_completed_on",
      "mentor_ready_on",
    ]) {
      assert.ok(!columns.includes(old), old);
    }
  });
});
