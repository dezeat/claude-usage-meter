import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {} from "./aggregate.js";
export const SCHEMA_VERSION = 1;
function isLockedError(err) {
    return err instanceof Error && err.message.toLowerCase().includes("locked");
}
// Block the thread for ms without busy-spinning. node:sqlite is synchronous, so
// the WAL-switch retry cannot await a timer.
function sleepSync(ms) {
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
function enableWal(db) {
    for (let attempt = 0;; attempt++) {
        try {
            db.exec("PRAGMA journal_mode = WAL");
            return;
        }
        catch (err) {
            if (attempt >= WAL_SWITCH_ATTEMPTS - 1 || !isLockedError(err))
                throw err;
            sleepSync(5 + Math.floor(Math.random() * 20));
        }
    }
}
// The DB is the cross-session store, one row per Claude Code session keyed by
// session_id (the transcript UUID). It replaces the rewritten index.json: a
// whole-file writeFileSync raced across parallel worktree renders and dropped
// sessions (last-writer-wins). Each session is now persisted with a single
// atomic upsert, so concurrent updateIndex calls no longer clobber each other.
export function openDb(dbPath) {
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
      session_id  TEXT PRIMARY KEY,
      path        TEXT NOT NULL,
      branch      TEXT,
      model_class TEXT,
      cost_usd    REAL,
      last_ts     INTEGER,
      byte_offset INTEGER NOT NULL,
      month       TEXT,
      tokens_json TEXT,
      machine_id  TEXT
    )
  `);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return db;
}
export function schemaVersion(db) {
    const row = db.prepare("PRAGMA user_version").get();
    return row?.user_version ?? 0;
}
function asUsage(value) {
    const u = typeof value === "object" && value !== null
        ? value
        : {};
    const n = (x) => (typeof x === "number" ? x : 0);
    return {
        inputTokens: n(u.inputTokens),
        outputTokens: n(u.outputTokens),
        cacheReadTokens: n(u.cacheReadTokens),
        cacheCreationTokens: n(u.cacheCreationTokens),
    };
}
function parseTokens(json) {
    if (json === null || json === "")
        return {};
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return {};
    }
    if (typeof parsed !== "object" || parsed === null)
        return {};
    const out = {};
    for (const [model, usage] of Object.entries(parsed)) {
        out[model] = asUsage(usage);
    }
    return out;
}
function toSessionRow(raw) {
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
    };
}
export function getSession(db, sessionId) {
    const raw = db
        .prepare("SELECT * FROM sessions WHERE session_id = ?")
        .get(sessionId);
    return raw === undefined ? undefined : toSessionRow(raw);
}
export function allSessions(db) {
    const rows = db
        .prepare("SELECT * FROM sessions")
        .all();
    return rows.map(toSessionRow);
}
// COUNT(*) grouped by model_class for one calendar month, computed in SQL so a
// render never has to load every session row just to tally them (matters once
// the statusline re-runs every few seconds). Returns raw counts keyed by class.
export function countSessionsByClassForMonth(db, month) {
    const rows = db
        .prepare(`SELECT model_class, COUNT(*) AS n
         FROM sessions
        WHERE month = ?
        GROUP BY model_class`)
        .all(month);
    const out = new Map();
    for (const row of rows)
        out.set(row.model_class ?? "unknown", row.n);
    return out;
}
// Per-class count of sessions whose last_ts is within windowMs of nowMs. Live is
// independent of month scope by design — a session active across a month
// boundary still counts here. The comparison is done in SQL against last_ts only;
// there is no process-liveness probe (not available from transcripts).
export function countLiveSessionsByClass(db, nowMs, windowMs) {
    const rows = db
        .prepare(`SELECT model_class, COUNT(*) AS n
         FROM sessions
        WHERE ? - last_ts < ?
        GROUP BY model_class`)
        .all(nowMs, windowMs);
    const out = new Map();
    for (const row of rows)
        out.set(row.model_class ?? "unknown", row.n);
    return out;
}
// All sessions in one calendar month carrying the per-class fields a spend
// rollup needs. The cost lives in a SQL column and could be SUMmed in the
// query, but the per-model token totals are opaque JSON the store must fold in
// JS — so a single month-scoped query returns the rows and the caller groups by
// model_class. Ordering is by class to keep the fold deterministic.
export function monthClassSpendRows(db, month) {
    const rows = db
        .prepare(`SELECT model_class, cost_usd, tokens_json
         FROM sessions
        WHERE month = ?
        ORDER BY model_class`)
        .all(month);
    return rows.map((row) => ({
        modelClass: row.model_class ?? "unknown",
        costUsd: row.cost_usd ?? 0,
        tokens: parseTokens(row.tokens_json),
    }));
}
// A single atomic upsert per session: this is the race fix. Two concurrent
// updateIndex runs touching different session_ids both persist; neither can
// overwrite the other the way the whole-file JSON rewrite did.
export function upsertSession(db, row) {
    db.prepare(`INSERT INTO sessions
       (session_id, path, branch, model_class, cost_usd, last_ts,
        byte_offset, month, tokens_json, machine_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(session_id) DO UPDATE SET
       path        = excluded.path,
       branch      = excluded.branch,
       model_class = excluded.model_class,
       cost_usd    = excluded.cost_usd,
       last_ts     = excluded.last_ts,
       byte_offset = excluded.byte_offset,
       month       = excluded.month,
       tokens_json = excluded.tokens_json`).run(row.sessionId, row.path, row.branch, row.modelClass, row.costUsd, row.lastTs, row.byteOffset, row.month, JSON.stringify(row.tokens));
}
