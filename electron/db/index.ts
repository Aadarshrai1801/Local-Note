import { DatabaseSync } from 'node:sqlite'
import { createLogger } from '../lib/log'
import { getPaths } from '../lib/paths'

/**
 * SQLite access via Node's built-in `node:sqlite` module.
 *
 * Using the bundled driver (rather than better-sqlite3) means Local Note has
 * NO native modules: `npm install` never needs a C++ toolchain, which is what
 * makes "clone and run" work on a clean Windows machine.
 */

const log = createLogger('db')

export type SqlValue = string | number | bigint | null | Uint8Array

let db: DatabaseSync | null = null

const SCHEMA_VERSION = 1

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS meetings (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  duration_ms    INTEGER,
  audio_path     TEXT,
  summary        TEXT,
  brief_notes    TEXT,
  brief_docs     TEXT,
  brief_summary  TEXT,
  summarized_at  INTEGER,
  summary_status TEXT NOT NULL DEFAULT 'pending',
  summary_error  TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at DESC);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id            TEXT PRIMARY KEY,
  meeting_id    TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  speaker_label TEXT,
  source        TEXT NOT NULL DEFAULT 'mixed',
  start_ms      INTEGER NOT NULL DEFAULT 0,
  end_ms        INTEGER NOT NULL DEFAULT 0,
  text          TEXT NOT NULL,
  confidence    REAL,
  corrected     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_segments_meeting ON transcript_segments(meeting_id, start_ms);

CREATE TABLE IF NOT EXISTS action_items (
  id         TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  assignee   TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id, position);

CREATE TABLE IF NOT EXISTS dictionary_terms (
  id          TEXT PRIMARY KEY,
  term        TEXT NOT NULL,
  replacement TEXT,
  notes       TEXT,
  created_at  INTEGER NOT NULL,
  hit_count   INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dictionary_term ON dictionary_terms(lower(term));

CREATE TABLE IF NOT EXISTS speaker_names (
  meeting_id    TEXT NOT NULL,
  speaker_label TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  PRIMARY KEY (meeting_id, speaker_label)
);

CREATE TABLE IF NOT EXISTS voice_profiles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  centroid        TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  dim             INTEGER NOT NULL,
  sample_count    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  segment_id TEXT PRIMARY KEY REFERENCES transcript_segments(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_meeting ON embeddings(meeting_id);

-- Full-text search over transcript segments. Kept in sync by triggers so the
-- app never has to remember to reindex. 'porter' stemming makes "budgets"
-- match "budget".
--
-- These are ordinary FTS5 tables, so the index is maintained with plain
-- DELETE/INSERT on the shadow table rather than FTS5's special 'delete'
-- command (which is only valid for external-content and contentless tables).
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text,
  segment_id UNINDEXED,
  meeting_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS meeting_fts USING fts5(
  title,
  summary,
  meeting_id UNINDEXED,
  tokenize = 'porter unicode61'
);
`

/**
 * Triggers are dropped and recreated on every startup rather than guarded with
 * IF NOT EXISTS.
 *
 * Trigger bodies are part of the schema, so a change to them must reach
 * databases that already exist. Recreating them is cheap and makes the on-disk
 * definition always match this file, which matters while the schema is still
 * evolving.
 */
const TRIGGERS = `
DROP TRIGGER IF EXISTS transcript_segments_ai;
DROP TRIGGER IF EXISTS transcript_segments_ad;
DROP TRIGGER IF EXISTS transcript_segments_au;
DROP TRIGGER IF EXISTS meetings_ai;
DROP TRIGGER IF EXISTS meetings_ad;
DROP TRIGGER IF EXISTS meetings_au;

CREATE TRIGGER transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_fts(rowid, text, segment_id, meeting_id)
  VALUES (new.rowid, new.text, new.id, new.meeting_id);
END;

CREATE TRIGGER transcript_segments_ad AFTER DELETE ON transcript_segments BEGIN
  DELETE FROM transcript_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER transcript_segments_au AFTER UPDATE ON transcript_segments BEGIN
  DELETE FROM transcript_fts WHERE rowid = old.rowid;
  INSERT INTO transcript_fts(rowid, text, segment_id, meeting_id)
  VALUES (new.rowid, new.text, new.id, new.meeting_id);
END;

CREATE TRIGGER meetings_ai AFTER INSERT ON meetings BEGIN
  INSERT INTO meeting_fts(rowid, title, summary, meeting_id)
  VALUES (new.rowid, new.title, COALESCE(new.summary, ''), new.id);
END;

CREATE TRIGGER meetings_ad AFTER DELETE ON meetings BEGIN
  DELETE FROM meeting_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER meetings_au AFTER UPDATE ON meetings BEGIN
  DELETE FROM meeting_fts WHERE rowid = old.rowid;
  INSERT INTO meeting_fts(rowid, title, summary, meeting_id)
  VALUES (new.rowid, new.title, COALESCE(new.summary, ''), new.id);
END;
`

export function getDb(): DatabaseSync {
  if (db) return db

  const { dbPath } = getPaths()
  log.info(`opening database at ${dbPath}`)
  db = new DatabaseSync(dbPath)

  // `exec` runs the multi-statement schema; node:sqlite allows this outside a
  // transaction.
  db.exec(SCHEMA)
  db.exec(TRIGGERS)

  const current = getMeta('schema_version')
  if (current === null) {
    setMeta('schema_version', String(SCHEMA_VERSION))
  } else if (Number(current) > SCHEMA_VERSION) {
    log.warn(
      `database schema version ${current} is newer than this build (${SCHEMA_VERSION}); ` +
        'some features may behave unexpectedly.'
    )
  }

  log.info(`database ready (schema v${current ?? SCHEMA_VERSION})`)
  return db
}

export function closeDb(): void {
  if (!db) return
  try {
    db.close()
  } catch (error) {
    log.warn('failed to close database cleanly', error)
  }
  db = null
}

/* ------------------------------------------------------------------ */
/* Meta / settings helpers                                             */
/* ------------------------------------------------------------------ */

export function getMeta(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined
  return row?.value ?? null
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

export function deleteMeta(key: string): void {
  getDb().prepare('DELETE FROM meta WHERE key = ?').run(key)
}

/* ------------------------------------------------------------------ */
/* Small helpers used by the repositories                              */
/* ------------------------------------------------------------------ */

/** node:sqlite only accepts null/number/bigint/string/Uint8Array. */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0
}

export function fromSqlBool(value: unknown): boolean {
  return value === 1 || value === true
}

/** Converts an optional string to NULL when empty, keeping the DB tidy. */
export function nullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Wraps a multi-statement write in a transaction. node:sqlite has no
 * transaction helper, so this issues BEGIN/COMMIT manually and rolls back on
 * error — important for bulk transcript inserts.
 */
export function transaction<T>(fn: () => T): T {
  const handle = getDb()
  handle.exec('BEGIN')
  try {
    const result = fn()
    handle.exec('COMMIT')
    return result
  } catch (error) {
    try {
      handle.exec('ROLLBACK')
    } catch {
      /* the transaction may already be aborted */
    }
    throw error
  }
}

/**
 * Typed wrapper around a prepared statement.
 *
 * `node:sqlite` returns rows as `Record<string, SQLOutputValue>`, which cannot
 * be cast directly to a row interface. Routing every query through these
 * generic helpers keeps the rest of the codebase free of double casts.
 */
export interface TypedStatement {
  all<T>(...params: SqlValue[]): T[]
  get<T>(...params: SqlValue[]): T | undefined
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

export function prepare(sql: string): TypedStatement {
  const statement = getDb().prepare(sql)
  return {
    all<T>(...params: SqlValue[]): T[] {
      return statement.all(...params) as unknown as T[]
    },
    get<T>(...params: SqlValue[]): T | undefined {
      return statement.get(...params) as unknown as T | undefined
    },
    run(...params: SqlValue[]) {
      return statement.run(...params)
    }
  }
}

/** Convenience helpers for one-off queries. */
export function queryAll<T>(sql: string, ...params: SqlValue[]): T[] {
  return prepare(sql).all<T>(...params)
}

export function queryOne<T>(sql: string, ...params: SqlValue[]): T | undefined {
  return prepare(sql).get<T>(...params)
}

/** Generates a sortable, collision-resistant id. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 10)
  return `${prefix}_${time}${random}`
}
