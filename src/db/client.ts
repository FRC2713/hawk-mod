import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../config.js";
import { log } from "../logger.js";

export type Db = Database.Database;

let cached: Db | null = null;

/**
 * Walks up from this module until it finds `migrations/`, so the same code
 * works whether it is running from `src/` under tsx or from `dist/src/` in the
 * container — the two are at different depths.
 */
function migrationsDir(): string {
  if (process.env.MIGRATIONS_DIR) return resolve(process.env.MIGRATIONS_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate the migrations directory; set MIGRATIONS_DIR"
  );
}

/** The first line a migration that rebuilds a parent table starts with. */
const FOREIGN_KEYS_OFF = "-- foreign_keys: off";

/**
 * Applies one migration in its own transaction, and records it.
 *
 * A migration that rebuilds a table other tables reference — `people` — must
 * run with foreign keys off: dropping the old table with them on runs every ON
 * DELETE CASCADE, and consents and role history go with it. SQLite ignores
 * `PRAGMA foreign_keys` inside a transaction, so such a migration says so on
 * its first line and the runner turns them off around it — SQLite's documented
 * procedure for altering a table. `foreign_key_check` must then come back
 * empty, or the whole migration rolls back.
 */
export function applyMigration(db: Db, name: string, sql: string): void {
  const fkOff = sql.startsWith(FOREIGN_KEYS_OFF);
  if (fkOff) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(sql);
      if (fkOff) {
        const broken = db.pragma("foreign_key_check") as unknown[];
        if (broken.length) {
          throw new Error(
            `${name} left ${broken.length} broken foreign key(s)`
          );
        }
      }
      db.prepare(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)"
      ).run(name, new Date().toISOString());
    })();
  } finally {
    if (fkOff) db.pragma("foreign_keys = ON");
  }
}

export function ensureMigrationsTable(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`
  );
}

/**
 * Applies every migrations/NNNN_*.sql not yet recorded, in filename order,
 * each in its own transaction. Migrations that have shipped are never edited.
 */
function migrate(db: Db) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name)
  );
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    applyMigration(db, file, readFileSync(join(dir, file), "utf8"));
    log.info("migration applied", { file });
  }
}

export function db(): Db {
  if (cached) return cached;
  const dir = resolve(dataDir());
  mkdirSync(dir, { recursive: true });
  const conn = new Database(join(dir, "hawk-mod.db"));
  conn.pragma("journal_mode = WAL");
  // SQLite needs this per-connection or the ON DELETE CASCADEs silently do
  // nothing.
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  migrate(conn);
  cached = conn;
  return conn;
}
