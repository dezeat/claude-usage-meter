import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { type ModelUsage } from "./aggregate.js";

export const SCHEMA_VERSION = 4;

// The two account-wide rate-limit windows persisted in account_limits. The
// context window is deliberately NOT here: it is legitimately per-session, so it
// always renders from the local payload, never the shared store.
export type LimitWindowKind = "five_hour" | "seven_day";

// One account-wide rate-limit observation, last-writer-wins by observedAt. Unlike
// the per-session sessions rows, the 5h/7d windows describe a single shared truth
// every session sees the same way, so the freshest observation is the best
// estimate — a single LWW row, not one per session (Discussion #63, Part 1).
export interface AccountLimitRow {
  kind: LimitWindowKind;
  usedPercentage: number;
  resetsAt: number;
  observedAt: number;
}

export interface SessionRow {
  sessionId: string;
  path: string;
  branch: string;
  modelClass: string;
  tokens: Record<string, ModelUsage>;
  costUsd: number;
  lastTs: number;
  byteOffset: number;
  month: string;
  // NULL for a top-level session; the parent session id for a subagent row
  // (ADR-0001). The row is still keyed by its own file basename.
  parentSessionId: string | null;
}

function isLockedError(err: unknown): boolean {
  return err instanceof Error && err.message.toLowerCase().includes("locked");
}

// Block the thread for ms without busy-spinning. node:sqlite is synchronous, so
// the WAL-switch retry cannot await a timer.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Switching a fresh DB to WAL needs a brief exclusive lock. Two processes
// opening the same new file at the same instant each hold a lock the other
// needs, so SQLite returns SQLITE_BUSY *immediately* and deliberately skips the
// busy handler to avoid the deadlock — busy_timeout cannot rescue this one. But
// WAL is a persistent property of the file: once any process wins the switch,
// every later open inherits it and the pragma is a no-op. So retry with jittered
// backoff until a winner emerges (or it is already WAL).
const WAL_SWITCH_ATTEMPTS = 50;
function enableWal(db: DatabaseSync): void {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      if (attempt >= WAL_SWITCH_ATTEMPTS - 1 || !isLockedError(err)) throw err;
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
}

function isDuplicateColumnError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.toLowerCase().includes("duplicate column")
  );
}

// Two worktrees can race to migrate the same fresh DB, so every migration step is
// idempotent and tolerates the "already done" error a loser sees. `IF NOT EXISTS`
// covers the table/index DDL; the v1->v2 ALTER has no such clause and surfaces as
// "duplicate column" on the second writer, which we swallow.

// v2 -> v3: the account-wide rate-limit store (Discussion #63, Part 1) and the
// read-path indexes (#63, H3). The sessions table has only its session_id PRIMARY
// KEY, so every month/class/liveness aggregate is a full scan; these indexes turn
// them into O(matching rows). Created once here, gated by user_version, so a hot
// idle tick never re-runs the DDL. CREATE INDEX/TABLE IF NOT EXISTS keeps the
// concurrent-open race a no-op rather than a throw.
function migrateToV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_limits (
      window_kind     TEXT PRIMARY KEY,
      used_percentage REAL,
      resets_at       INTEGER,
      observed_at     INTEGER NOT NULL
    )
  `);
  createReadIndexes(db);
}

// v3 -> v4: a generic key/value table for cross-tick scalars the store needs to
// remember between statusline processes (each render is a fresh process). The
// hot-path sweep debounce (Discussion #63, H1) persists its project-dir mtime
// watermark here. IF NOT EXISTS keeps the concurrent-worktree open a no-op.
function migrateToV4(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

// The composite (month, model_class) covers both month-scoped aggregates
// (countSessionsByClassForMonth, monthClassSpendRows); last_ts covers the live
// query. parent_session_id is in the month index's leading filter via month, but
// the liveness filter also tests it — keeping it out keeps the index narrow and
// the residual predicate cheap.
function createReadIndexes(db: DatabaseSync): void {
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_month_class ON sessions (month, model_class)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_last_ts ON sessions (last_ts)",
  );
}

// Upgrade an older on-disk DB in place along a version ladder. A fresh DB starts at
// user_version 0 and walks every step; a pre-existing one resumes at its stored
// version. Each step is idempotent (see the race note above), so a freshly CREATEd
// table re-applying a step is harmless. busy_timeout covers schema-lock contention,
// like the WAL switch.
function migrateSchema(db: DatabaseSync): void {
  const version = schemaVersion(db);

  // v1 -> v2 adds parent_session_id for subagent attribution (ADR-0001).
  if (version < 2) {
    try {
      db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
    } catch (err) {
      if (!isDuplicateColumnError(err)) throw err;
    }
    db.exec("PRAGMA user_version = 2");
  }

  if (version < 3) {
    migrateToV3(db);
    db.exec("PRAGMA user_version = 3");
  }

  if (version < 4) {
    migrateToV4(db);
    db.exec("PRAGMA user_version = 4");
  }
}

// The DB is the cross-session store, one row per Claude Code session keyed by
// session_id (the transcript UUID). It replaces the rewritten index.json: a
// whole-file writeFileSync raced across parallel worktree renders and dropped
// sessions (last-writer-wins). Each session is now persisted with a single
// atomic upsert, so concurrent updateIndex calls no longer clobber each other.
export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);

  // busy_timeout makes contended writers wait for the WAL lock (writes
  // serialise under WAL) instead of throwing SQLITE_BUSY. The WAL switch itself
  // is a deadlock case the timeout can't cover, so it gets its own retry.
  db.exec("PRAGMA busy_timeout = 5000");
  enableWal(db);

  // machine_id is reserved for a future cross-machine collector (S05 board
  // section 3). It is written NULL and never read by this story's code;
  // dropping it would require a schema migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id        TEXT PRIMARY KEY,
      path              TEXT NOT NULL,
      branch            TEXT,
      model_class       TEXT,
      cost_usd          REAL,
      last_ts           INTEGER,
      byte_offset       INTEGER NOT NULL,
      month             TEXT,
      tokens_json       TEXT,
      parent_session_id TEXT,
      machine_id        TEXT
    )
  `);

  migrateSchema(db);

  return db;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as unknown as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

function asUsage(value: unknown): ModelUsage {
  const u =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const n = (x: unknown): number => (typeof x === "number" ? x : 0);
  return {
    inputTokens: n(u.inputTokens),
    outputTokens: n(u.outputTokens),
    cacheReadTokens: n(u.cacheReadTokens),
    cacheCreationTokens: n(u.cacheCreationTokens),
  };
}

function parseTokens(json: string | null): Record<string, ModelUsage> {
  if (json === null || json === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    out[model] = asUsage(usage);
  }
  return out;
}

interface RawSessionRow {
  session_id: string;
  path: string;
  branch: string | null;
  model_class: string | null;
  cost_usd: number | null;
  last_ts: number | null;
  byte_offset: number;
  month: string | null;
  tokens_json: string | null;
  parent_session_id: string | null;
}

function toSessionRow(raw: RawSessionRow): SessionRow {
  return {
    sessionId: raw.session_id,
    path: raw.path,
    branch: raw.branch ?? "",
    modelClass: raw.model_class ?? "unknown",
    costUsd: raw.cost_usd ?? 0,
    lastTs: raw.last_ts ?? 0,
    byteOffset: raw.byte_offset,
    month: raw.month ?? "unknown",
    tokens: parseTokens(raw.tokens_json),
    parentSessionId: raw.parent_session_id,
  };
}

export function getSession(
  db: DatabaseSync,
  sessionId: string,
): SessionRow | undefined {
  const raw = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId) as unknown as RawSessionRow | undefined;
  return raw === undefined ? undefined : toSessionRow(raw);
}

export function allSessions(db: DatabaseSync): SessionRow[] {
  const rows = db
    .prepare("SELECT * FROM sessions")
    .all() as unknown as RawSessionRow[];
  return rows.map(toSessionRow);
}

interface ClassCountRow {
  model_class: string | null;
  n: number;
}

// COUNT(*) grouped by model_class for one calendar month, computed in SQL so a
// render never has to load every session row just to tally them (matters once
// the statusline re-runs every few seconds). Returns raw counts keyed by class.
export function countSessionsByClassForMonth(
  db: DatabaseSync,
  month: string,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT model_class, COUNT(*) AS n
         FROM sessions
        WHERE month = ? AND parent_session_id IS NULL
        GROUP BY model_class`,
    )
    .all(month) as unknown as ClassCountRow[];
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.model_class ?? "unknown", row.n);
  return out;
}

// Per-class count of sessions whose last_ts is within windowMs of nowMs. Live is
// independent of month scope by design — a session active across a month
// boundary still counts here. The comparison is done in SQL against last_ts only;
// there is no process-liveness probe (not available from transcripts).
export function countLiveSessionsByClass(
  db: DatabaseSync,
  nowMs: number,
  windowMs: number,
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT model_class, COUNT(*) AS n
         FROM sessions
        WHERE ? - last_ts < ? AND parent_session_id IS NULL
        GROUP BY model_class`,
    )
    .all(nowMs, windowMs) as unknown as ClassCountRow[];
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.model_class ?? "unknown", row.n);
  return out;
}

interface MonthClassRow {
  model_class: string | null;
  cost_usd: number | null;
  tokens_json: string | null;
}

export interface ClassSpendRow {
  modelClass: string;
  costUsd: number;
  tokens: Record<string, ModelUsage>;
}

// All sessions in one calendar month carrying the per-class fields a spend
// rollup needs. The cost lives in a SQL column and could be SUMmed in the
// query, but the per-model token totals are opaque JSON the store must fold in
// JS — so a single month-scoped query returns the rows and the caller groups by
// model_class. Ordering is by class to keep the fold deterministic. Subagent
// rows are intentionally NOT filtered: their spend counts under their own
// model_class (ADR-0002), even though they are not counted as sessions.
export function monthClassSpendRows(
  db: DatabaseSync,
  month: string,
): ClassSpendRow[] {
  const rows = db
    .prepare(
      `SELECT model_class, cost_usd, tokens_json
         FROM sessions
        WHERE month = ?
        ORDER BY model_class`,
    )
    .all(month) as unknown as MonthClassRow[];
  return rows.map((row) => ({
    modelClass: row.model_class ?? "unknown",
    costUsd: row.cost_usd ?? 0,
    tokens: parseTokens(row.tokens_json),
  }));
}

// A single atomic upsert per session: this is the race fix. Two concurrent
// updateIndex runs touching different session_ids both persist; neither can
// overwrite the other the way the whole-file JSON rewrite did.
export function upsertSession(db: DatabaseSync, row: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions
       (session_id, path, branch, model_class, cost_usd, last_ts,
        byte_offset, month, tokens_json, parent_session_id, machine_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       path              = excluded.path,
       branch            = excluded.branch,
       model_class       = excluded.model_class,
       cost_usd          = excluded.cost_usd,
       last_ts           = excluded.last_ts,
       byte_offset       = excluded.byte_offset,
       month             = excluded.month,
       tokens_json       = excluded.tokens_json,
       parent_session_id = excluded.parent_session_id`,
  ).run(
    row.sessionId,
    row.path,
    row.branch,
    row.modelClass,
    row.costUsd,
    row.lastTs,
    row.byteOffset,
    row.month,
    JSON.stringify(row.tokens),
    row.parentSessionId,
  );
}

interface RawAccountLimitRow {
  window_kind: string;
  used_percentage: number | null;
  resets_at: number | null;
  observed_at: number;
}

// Persist one account-wide window observation, last-writer-wins by observed_at.
// The `WHERE excluded.observed_at > observed_at` guard makes the upsert monotonic:
// a laggy session whose snapshot is older than the stored one cannot regress the
// shared value, so the row always holds the freshest observation (Discussion #63,
// Part 1). The conflict target is the window_kind primary key — exactly one row
// per window.
export function upsertAccountLimit(
  db: DatabaseSync,
  row: AccountLimitRow,
): void {
  db.prepare(
    `INSERT INTO account_limits
       (window_kind, used_percentage, resets_at, observed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(window_kind) DO UPDATE SET
       used_percentage = excluded.used_percentage,
       resets_at       = excluded.resets_at,
       observed_at     = excluded.observed_at
     WHERE excluded.observed_at > account_limits.observed_at`,
  ).run(row.kind, row.usedPercentage, row.resetsAt, row.observedAt);
}

function toAccountLimitRow(
  raw: RawAccountLimitRow,
): AccountLimitRow | undefined {
  if (raw.used_percentage === null || raw.resets_at === null) return undefined;
  if (raw.window_kind !== "five_hour" && raw.window_kind !== "seven_day") {
    return undefined;
  }
  return {
    kind: raw.window_kind,
    usedPercentage: raw.used_percentage,
    resetsAt: raw.resets_at,
    observedAt: raw.observed_at,
  };
}

// The freshest stored observation for one window, or undefined when the store has
// never seen it (first install, wiped DB). The caller degrades to the local
// payload on undefined — absence is not zero usage.
export function getAccountLimit(
  db: DatabaseSync,
  kind: LimitWindowKind,
): AccountLimitRow | undefined {
  const raw = db
    .prepare("SELECT * FROM account_limits WHERE window_kind = ?")
    .get(kind) as unknown as RawAccountLimitRow | undefined;
  return raw === undefined ? undefined : toAccountLimitRow(raw);
}

// One scalar the store carries across statusline processes (the meta kv table).
// Values are stored as opaque TEXT; the caller owns the encoding (e.g. the H1
// sweep watermark stamps a stringified nanosecond mtime). Undefined when the key
// was never written.
export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return raw?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
