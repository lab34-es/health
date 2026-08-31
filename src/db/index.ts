import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HealthError } from '../util/errors.js';

export type Db = Database.Database;

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * Opens the context database, creating and migrating it if needed.
 *
 * The file is named database.sql by the brief even though it holds SQLite's
 * binary format rather than SQL text; that is the documented contract, so it
 * is kept.
 */
export function openDatabase(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });

  let db: Db;
  try {
    db = new Database(path);
  } catch (error) {
    throw new HealthError(`Cannot open ${path}: ${(error as Error).message}`);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file.slice(0, file.indexOf('_')), 10);
    if (!Number.isFinite(version)) {
      throw new HealthError(`Migration "${file}" does not start with a version number`);
    }
    if (applied.has(version)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration is one transaction: a half-applied schema is worse than
    // no migration at all.
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString());
    })();
  }
}
