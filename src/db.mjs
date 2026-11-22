// The only module that touches SQLite (design record: the swap point if node:sqlite changes).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files(
  path TEXT PRIMARY KEY, size INTEGER, prefix_hash TEXT, prefix_len INTEGER, byte_offset INTEGER,
  lines INTEGER, status TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, file TEXT, line_no INTEGER, byte_offset INTEGER,
  session_id TEXT, uuid TEXT, hash TEXT, type TEXT, kind TEXT, ts INTEGER,
  sidechain INTEGER, branch TEXT, cwd TEXT,
  owner_prompt INTEGER, prompt_len INTEGER, interrupted INTEGER,
  n_tool_use INTEGER, tool_use_ids TEXT, rejected INTEGER, perm TEXT, hook_err INTEGER,
  pr_repo TEXT, pr_num INTEGER, link_to TEXT);
CREATE TABLE IF NOT EXISTS raw_events(event_id INTEGER PRIMARY KEY, raw TEXT);  -- kept apart so scans over events stay small
CREATE INDEX IF NOT EXISTS ev_file ON events(file);
CREATE UNIQUE INDEX IF NOT EXISTS ev_dedupe ON events(session_id, ifnull(uuid,''), hash);
CREATE INDEX IF NOT EXISTS ev_session ON events(session_id, ts);
CREATE TABLE IF NOT EXISTS prs(repo TEXT, num INTEGER, state TEXT, additions INTEGER,
  deletions INTEGER, merged_at INTEGER, ci TEXT, reverted INTEGER, PRIMARY KEY(repo,num));
`;

export function open(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') { try { chmodSync(path, 0o600); } catch {} }
  db.exec(DDL);
  const v = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  if (!v) db.prepare("INSERT INTO meta VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  else if (Number(v.value) !== SCHEMA_VERSION) throw new Error(`index schema ${v.value}, tool expects ${SCHEMA_VERSION}: delete the index and ingest again`);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
