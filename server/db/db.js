import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.js';

/**
 * Thin synchronous wrapper around node:sqlite.
 * All writes that belong together go through db.tx(fn) so they commit or roll back as one.
 */
export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

  let depth = 0;
  const db = {
    file,
    raw,
    get: (sql, ...params) => stmt(sql).get(...clean(params)),
    all: (sql, ...params) => stmt(sql).all(...clean(params)),
    run: (sql, ...params) => stmt(sql).run(...clean(params)),
    exec: (sql) => raw.exec(sql),
    /** Run fn inside a transaction. Nested calls join the outer transaction via savepoints. */
    tx(fn) {
      const name = `sp_${depth}`;
      if (depth === 0) raw.exec('BEGIN IMMEDIATE');
      else raw.exec(`SAVEPOINT ${name}`);
      depth++;
      try {
        const out = fn();
        depth--;
        if (depth === 0) raw.exec('COMMIT');
        else raw.exec(`RELEASE ${name}`);
        return out;
      } catch (err) {
        depth--;
        if (depth === 0) raw.exec('ROLLBACK');
        else raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    },
    inTx: () => depth > 0,
    close: () => raw.close(),
  };

  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.all('SELECT id FROM schema_migrations').map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.tx(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    });
  }
}

/** JSON column helpers. */
export const j = (v) => JSON.stringify(v ?? null);
export const pj = (s, fallback = null) => {
  if (s === null || s === undefined || s === '') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
