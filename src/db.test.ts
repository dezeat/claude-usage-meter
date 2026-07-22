import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { updateIndex } from "./index-store.js";
import {
  openDb,
  schemaVersion,
  SCHEMA_VERSION,
  upsertSession,
  upsertSessionHeartbeat,
  getSession,
  upsertAccountLimit,
  getAccountLimit,
  getMeta,
  setMeta,
  countSessionsByClassForMonth,
  countLiveSessionsByClass,
  type SessionRow,
} from "./db.js";
import { DEFAULT_PRICING } from "./pricing.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "db-store-test-"));
}

function assistantLine(opts: {
  ts: string;
  branch: string;
  reqId: string;
  msgId: string;
  model: string;
  input: number;
  output: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    gitBranch: opts.branch,
    requestId: opts.reqId,
    message: {
      id: opts.msgId,
      model: opts.model,
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function writeTranscript(
  claudeProjects: string,
  name: string,
  lines: string[],
): void {
  const dir = join(claudeProjects, "-fake-midnight-marble");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), lines.join("\n") + "\n", "utf8");
}

test("two updateIndex runs over different claude dirs both persist to the shared DB", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");

  // Two separate claude dirs, each holding one distinct session, both pointed
  // at the SAME db file — the parallel-worktree scenario the JSON store lost.
  // This drives the real updateIndex path; the genuine same-instant contention
  // (WAL lock + busy_timeout) is proven by the two-process test below, since
  // updateIndex is synchronous-bodied and these two awaits run in sequence.
  const projectsA = join(tmp, "claudeA", "projects");
  const projectsB = join(tmp, "claudeB", "projects");
  writeTranscript(projectsA, "session-a.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "rA",
      msgId: "mA",
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
    }),
  ]);
  writeTranscript(projectsB, "session-b.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:01:00.000Z",
      branch: "feat/foo",
      reqId: "rB",
      msgId: "mB",
      model: "claude-opus-4-8",
      input: 200,
      output: 80,
    }),
  ]);

  await updateIndex(dbPath, projectsA, DEFAULT_PRICING);
  await updateIndex(dbPath, projectsB, DEFAULT_PRICING);

  // A final read must contain BOTH sessions — the JSON store would have had the
  // second updateIndex's whole-file write clobber the first session's row.
  const db = openDb(dbPath);
  const ids = (
    db.prepare("SELECT session_id FROM sessions").all() as Array<{
      session_id: string;
    }>
  ).map((r) => r.session_id);
  db.close();
  assert.deepEqual(
    ids.toSorted(),
    ["session-a", "session-b"],
    "both sessions are rows in the DB",
  );
});

// The honest race-fix proof: two real OS processes open the same DB file and
// upsert distinct sessions inside an overlapping busy-wait window, so their
// write transactions genuinely contend for the WAL lock at the same instant.
// The JSON store's whole-file last-writer-wins rewrite dropped one session in
// exactly this scenario; the atomic ON CONFLICT upsert + busy_timeout must
// leave both rows intact.
test("two concurrent OS processes upserting different sessions to one DB both persist", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");

  const dbModuleUrl = pathToFileURL(
    fileURLToPath(new URL("./db.js", import.meta.url)),
  ).href;
  const workerPath = join(tmp, "race-worker.mjs");
  writeFileSync(
    workerPath,
    `import { openDb, upsertSession } from ${JSON.stringify(dbModuleUrl)};
const [dbPath, id, modelClass] = process.argv.slice(2);
const db = openDb(dbPath);
// Busy-wait so both processes sit in their write window at the same instant.
const until = Date.now() + 100;
while (Date.now() < until) {}
upsertSession(db, {
  sessionId: id,
  path: "/fake/" + id + ".jsonl",
  branch: "main",
  modelClass,
  tokens: {},
  costUsd: 1,
  lastTs: Date.UTC(2026, 5, 13),
  byteOffset: 10,
  month: "2026-06",
  parentSessionId: null,
});
db.close();
`,
    "utf8",
  );

  function runWorker(id: string, modelClass: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [workerPath, dbPath, id, modelClass],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("error", reject);
      // node:sqlite prints an ExperimentalWarning to stderr; only a non-zero
      // exit (e.g. an unhandled SQLITE_BUSY) is a failure.
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`worker ${id} exited ${code}: ${stderr}`)),
      );
    });
  }

  await Promise.all([
    runWorker("proc-a", "sonnet"),
    runWorker("proc-b", "opus"),
  ]);

  const db = openDb(dbPath);
  const ids = (
    db.prepare("SELECT session_id FROM sessions").all() as Array<{
      session_id: string;
    }>
  ).map((r) => r.session_id);
  db.close();
  assert.deepEqual(
    ids.toSorted(),
    ["proc-a", "proc-b"],
    "both concurrently-written sessions survived — neither overwrote the other",
  );
});

test("the sessions table has a reserved machine_id column that this story's code never populates", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");
  const projects = join(tmp, "claude", "projects");
  writeTranscript(projects, "session-x.jsonl", [
    assistantLine({
      ts: "2026-06-13T12:00:00.000Z",
      branch: "main",
      reqId: "rX",
      msgId: "mX",
      model: "claude-haiku-4-5",
      input: 10,
      output: 5,
    }),
  ]);

  await updateIndex(dbPath, projects, DEFAULT_PRICING);

  const db = openDb(dbPath);
  const cols = (
    db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes("machine_id"), "machine_id column exists in schema");

  const rows = db.prepare("SELECT machine_id FROM sessions").all() as Array<{
    machine_id: string | null;
  }>;
  assert.ok(rows.length > 0, "at least one session row written");
  for (const r of rows) {
    assert.equal(
      r.machine_id,
      null,
      "machine_id is never populated this story",
    );
  }
  db.close();
});

test("the DB stamps a schema version so future migrations can branch on it", () => {
  const db = openDb(":memory:");
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  db.close();
});

function seedSession(
  db: DatabaseSync,
  id: string,
  modelClass: string,
  month: string,
  lastTs: number,
  parentSessionId: string | null = null,
  heartbeatMs: number | null = null,
): void {
  const row: SessionRow = {
    sessionId: id,
    path: `/fake/${id}.jsonl`,
    branch: "main",
    modelClass,
    tokens: {},
    costUsd: 0,
    lastTs,
    byteOffset: 0,
    month,
    parentSessionId,
    heartbeatMs,
  };
  upsertSession(db, row);
}

const LIVENESS_WINDOW_MS = 5 * 60 * 1000;

test("countSessionsByClassForMonth counts only the queried month grouped by class", () => {
  const db = openDb(":memory:");
  const ts = Date.UTC(2026, 5, 10);
  seedSession(db, "j1", "opus", "2026-06", ts);
  seedSession(db, "j2", "opus", "2026-06", ts);
  seedSession(db, "j3", "sonnet", "2026-06", ts);
  seedSession(db, "m1", "opus", "2026-05", Date.UTC(2026, 4, 10));
  seedSession(db, "m2", "haiku", "2026-05", Date.UTC(2026, 4, 10));

  const counts = countSessionsByClassForMonth(db, "2026-06");
  db.close();

  assert.strictEqual(counts.get("opus"), 2, "two June opus, May opus excluded");
  assert.strictEqual(counts.get("sonnet"), 1, "one June sonnet");
  assert.strictEqual(counts.get("haiku"), undefined, "May-only haiku excluded");
});

test("countLiveSessionsByClass counts only sessions within the window of now, per class", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  seedSession(db, "live-opus", "opus", "2026-06", now - 60 * 1000);
  seedSession(db, "live-sonnet", "sonnet", "2026-06", now - 2 * 60 * 1000);
  seedSession(db, "idle-opus", "opus", "2026-06", now - 10 * 60 * 1000);

  const live = countLiveSessionsByClass(db, now, LIVENESS_WINDOW_MS);
  db.close();

  assert.strictEqual(live.get("opus"), 1, "idle opus excluded from live tally");
  assert.strictEqual(live.get("sonnet"), 1, "live sonnet counted");
});

test("live SQL prefers heartbeat, falls back to last_ts, and expires exactly at the strict boundary", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const windowMs = 30_000;

  seedSession(db, "legacy", "opus", "2026-06", now - 1, null, null);
  seedSession(
    db,
    "heartbeat-wins",
    "sonnet",
    "2026-06",
    now - 1,
    null,
    now - windowMs,
  );
  seedSession(
    db,
    "inside",
    "haiku",
    "2026-06",
    now - 60_000,
    null,
    now - windowMs + 1,
  );

  const live = countLiveSessionsByClass(db, now, windowMs, "legacy");
  db.close();

  assert.strictEqual(live.get("opus"), undefined, "current session excluded");
  assert.strictEqual(
    live.get("sonnet"),
    undefined,
    "heartbeat at exactly the boundary is expired despite a fresh last_ts",
  );
  assert.strictEqual(live.get("haiku"), 1, "one millisecond inside is live");
});

test("a heartbeat update changes only heartbeat_ms and preserves transcript state", () => {
  const db = openDb(":memory:");
  seedSession(db, "active", "opus", "2026-06", 1234);
  const before = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get("active") as Record<string, unknown>;

  assert.strictEqual(
    upsertSessionHeartbeat(db, {
      sessionId: "active",
      path: "/fake/active.jsonl",
      heartbeatMs: 9000,
      parentSessionId: null,
    }),
    true,
  );
  assert.strictEqual(
    upsertSessionHeartbeat(db, {
      sessionId: "active",
      path: "/fake/active.jsonl",
      heartbeatMs: 8000,
      parentSessionId: null,
    }),
    false,
    "an older concurrent tick cannot regress the heartbeat",
  );
  const after = db
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .get("active") as Record<string, unknown>;

  assert.strictEqual(after.heartbeat_ms, 9000);
  for (const [key, value] of Object.entries(before)) {
    if (key === "heartbeat_ms") continue;
    assert.deepStrictEqual(after[key], value, `${key} was not clobbered`);
  }

  upsertSession(db, {
    sessionId: "active",
    path: "/fake/active.jsonl",
    branch: "next",
    modelClass: "opus",
    tokens: {},
    costUsd: 1,
    lastTs: 2000,
    byteOffset: 42,
    month: "2026-06",
    parentSessionId: null,
  });
  const refolded = db
    .prepare(
      "SELECT heartbeat_ms, byte_offset FROM sessions WHERE session_id = ?",
    )
    .get("active") as { heartbeat_ms: number; byte_offset: number };
  db.close();

  assert.strictEqual(refolded.byte_offset, 42, "transcript state advances");
  assert.strictEqual(
    refolded.heartbeat_ms,
    9000,
    "a later transcript upsert preserves the independent heartbeat",
  );
});

test("a first heartbeat atomically creates a minimal top-level session row", () => {
  const db = openDb(":memory:");
  assert.strictEqual(
    upsertSessionHeartbeat(db, {
      sessionId: "new-session",
      path: "/fake/new-session.jsonl",
      heartbeatMs: 5000,
      parentSessionId: null,
    }),
    true,
  );
  const row = db
    .prepare(
      `SELECT path, byte_offset, parent_session_id, heartbeat_ms,
              tokens_json, last_ts
         FROM sessions WHERE session_id = ?`,
    )
    .get("new-session") as {
    path: string;
    byte_offset: number;
    parent_session_id: string | null;
    heartbeat_ms: number;
    tokens_json: string | null;
    last_ts: number | null;
  };
  assert.strictEqual(getSession(db, "new-session")?.transcriptIndexed, false);
  db.close();

  assert.deepStrictEqual(
    { ...row },
    {
      path: "/fake/new-session.jsonl",
      byte_offset: 0,
      parent_session_id: null,
      heartbeat_ms: 5000,
      tokens_json: null,
      last_ts: null,
    },
  );
});

test("a first heartbeat persists the session's model class so the roster names it, not unknown", () => {
  const db = openDb(":memory:");
  upsertSessionHeartbeat(db, {
    sessionId: "fresh",
    path: "/fake/fresh.jsonl",
    heartbeatMs: 5000,
    parentSessionId: null,
    modelClass: "opus",
  });
  const row = getSession(db, "fresh");
  db.close();

  assert.strictEqual(
    row?.modelClass,
    "opus",
    "the heartbeat carries the class",
  );
  assert.strictEqual(
    row?.transcriptIndexed,
    false,
    "a classed heartbeat row is still skeletal: no transcript folded, so spend rollups skip it",
  );
});

test("a heartbeat fills a null model class but never regresses a transcript-derived one", () => {
  const db = openDb(":memory:");
  // A real folded transcript row: byte offset advanced, tokens present, class
  // authoritative. Its heartbeat is still null (a legacy/Stop-hook row).
  upsertSession(db, {
    sessionId: "folded",
    path: "/fake/folded.jsonl",
    branch: "main",
    modelClass: "opus",
    tokens: {
      "claude-opus-4-8": {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    },
    costUsd: 1,
    lastTs: 1000,
    byteOffset: 100,
    month: "2026-06",
    parentSessionId: null,
  });
  // A heartbeat carrying a different class must not overwrite the folded one —
  // the transcript is authoritative for model_class (ADR-0004 spirit).
  upsertSessionHeartbeat(db, {
    sessionId: "folded",
    path: "/fake/folded.jsonl",
    heartbeatMs: 2000,
    parentSessionId: null,
    modelClass: "sonnet",
  });
  const row = getSession(db, "folded");
  db.close();

  assert.strictEqual(
    row?.modelClass,
    "opus",
    "the folded class is not regressed",
  );
  assert.strictEqual(row?.heartbeatMs, 2000, "the heartbeat still lands");
});

test("live counting is independent of month — an across-rollover session still counts live", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 6, 1, 0, 1, 0);
  // last_ts is in June but within the window of a July now.
  seedSession(db, "edge", "opus", "2026-06", Date.UTC(2026, 5, 30, 23, 59, 0));

  const live = countLiveSessionsByClass(db, now, LIVENESS_WINDOW_MS);
  const juneCounts = countSessionsByClassForMonth(db, "2026-06");
  const julyCounts = countSessionsByClassForMonth(db, "2026-07");
  db.close();

  assert.strictEqual(
    live.get("opus"),
    1,
    "edge session is live at the rollover",
  );
  assert.strictEqual(
    juneCounts.get("opus"),
    1,
    "and belongs to June's month count",
  );
  assert.strictEqual(julyCounts.get("opus"), undefined, "not counted in July");
});

test("subagent rows (parent_session_id set) are excluded from month and live session counts", () => {
  const db = openDb(":memory:");
  const ts = Date.UTC(2026, 5, 10);
  seedSession(db, "parent", "opus", "2026-06", ts);
  // A haiku subagent under the opus parent: real spend, but not a session.
  seedSession(db, "agent-x", "haiku", "2026-06", ts, "parent");

  const counts = countSessionsByClassForMonth(db, "2026-06");
  const live = countLiveSessionsByClass(db, ts + 60 * 1000, LIVENESS_WINDOW_MS);
  db.close();

  assert.strictEqual(counts.get("opus"), 1, "the parent session is counted");
  assert.strictEqual(
    counts.get("haiku"),
    undefined,
    "the subagent is not counted as a session",
  );
  assert.strictEqual(live.get("opus"), 1);
  assert.strictEqual(
    live.get("haiku"),
    undefined,
    "the subagent is not counted as a live session",
  );
});

test("opening an existing v1 store walks the ladder to the current schema, adding parent_session_id and preserving rows", () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "v1.db");

  // Hand-build a v1 store: the old schema (no parent_session_id) at user_version 1.
  const v1 = new DatabaseSync(dbPath);
  v1.exec("PRAGMA journal_mode = WAL");
  v1.exec(
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT,
       model_class TEXT, cost_usd REAL, last_ts INTEGER,
       byte_offset INTEGER NOT NULL, month TEXT, tokens_json TEXT, machine_id TEXT)`,
  );
  v1.prepare(
    "INSERT INTO sessions (session_id, path, byte_offset, model_class, month) VALUES (?, ?, ?, ?, ?)",
  ).run("old", "/fake/old.jsonl", 5, "opus", "2026-06");
  v1.exec("PRAGMA user_version = 1");
  v1.close();

  const db = openDb(dbPath);
  // The ladder runs every step from the stored version up to the current schema,
  // so a v1 store lands on SCHEMA_VERSION (v2 parent_session_id, v3 account_limits
  // + read indexes, v4 meta, v5 heartbeat_ms).
  assert.strictEqual(
    schemaVersion(db),
    SCHEMA_VERSION,
    "the store is migrated to the current schema version",
  );
  const cols = (
    db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  assert.ok(cols.includes("parent_session_id"), "the v2 column was added");
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  assert.ok(tables.includes("account_limits"), "the v3 table was added");
  assert.ok(tables.includes("meta"), "the v4 meta table was added");
  const row = db
    .prepare(
      "SELECT session_id, parent_session_id FROM sessions WHERE session_id = ?",
    )
    .get("old") as { session_id: string; parent_session_id: string | null };
  assert.strictEqual(row.session_id, "old", "the pre-existing row survived");
  assert.strictEqual(
    row.parent_session_id,
    null,
    "and is treated as top-level",
  );
  db.close();
});

test("an empty account_limits store reads back undefined so the caller can fall back to the local payload", () => {
  const db = openDb(":memory:");
  assert.strictEqual(getAccountLimit(db, "five_hour"), undefined);
  assert.strictEqual(getAccountLimit(db, "seven_day"), undefined);
  db.close();
});

test("the freshest account-limit observation wins — a later observed_at overwrites an earlier one", () => {
  const db = openDb(":memory:");
  upsertAccountLimit(db, {
    kind: "five_hour",
    usedPercentage: 40,
    resetsAt: 1000,
    observedAt: 100,
  });
  upsertAccountLimit(db, {
    kind: "five_hour",
    usedPercentage: 55,
    resetsAt: 1200,
    observedAt: 200,
  });
  const row = getAccountLimit(db, "five_hour");
  db.close();
  assert.deepStrictEqual(row, {
    kind: "five_hour",
    usedPercentage: 55,
    resetsAt: 1200,
    observedAt: 200,
  });
});

test("a laggy account-limit observation with an older observed_at cannot regress the freshest stored value", () => {
  const db = openDb(":memory:");
  upsertAccountLimit(db, {
    kind: "seven_day",
    usedPercentage: 70,
    resetsAt: 9000,
    observedAt: 500,
  });
  // A second session whose snapshot is older than the stored one must not win.
  upsertAccountLimit(db, {
    kind: "seven_day",
    usedPercentage: 60,
    resetsAt: 8000,
    observedAt: 300,
  });
  const row = getAccountLimit(db, "seven_day");
  db.close();
  assert.strictEqual(row?.usedPercentage, 70, "older observation was rejected");
  assert.strictEqual(row?.observedAt, 500);
});

test("the 5h and 7d windows are stored independently under their own keys", () => {
  const db = openDb(":memory:");
  upsertAccountLimit(db, {
    kind: "five_hour",
    usedPercentage: 33,
    resetsAt: 100,
    observedAt: 10,
  });
  upsertAccountLimit(db, {
    kind: "seven_day",
    usedPercentage: 88,
    resetsAt: 700,
    observedAt: 10,
  });
  const five = getAccountLimit(db, "five_hour");
  const seven = getAccountLimit(db, "seven_day");
  db.close();
  assert.strictEqual(five?.usedPercentage, 33);
  assert.strictEqual(seven?.usedPercentage, 88);
});

test("a fresh store carries the month, legacy timestamp, and heartbeat liveness indexes", () => {
  const db = openDb(":memory:");
  const indexes = (
    db.prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  db.close();
  assert.ok(
    indexes.includes("idx_sessions_month_class"),
    "the (month, model_class) index exists",
  );
  assert.ok(
    indexes.includes("idx_sessions_last_ts"),
    "the last_ts index exists",
  );
  assert.ok(
    indexes.includes("idx_sessions_liveness"),
    "the heartbeat-first expression index exists",
  );
});

test("the heartbeat-first cutoff query uses the liveness expression index", () => {
  const db = openDb(":memory:");
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT model_class, COUNT(*) AS n
         FROM sessions
        WHERE COALESCE(heartbeat_ms, last_ts) > ?
          AND parent_session_id IS NULL
          AND (? IS NULL OR session_id <> ?)
        GROUP BY model_class`,
    )
    .all(1000, null, null) as Array<{ detail: string }>;
  db.close();

  assert.ok(
    plan.some((step) => step.detail.includes("idx_sessions_liveness")),
    "the planner searches the expression index instead of scanning sessions",
  );
});

test("opening an existing v2 store migrates it to v3 in place, adding account_limits and the read indexes", () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "v2.db");

  // Hand-build a v2 store: the sessions schema with parent_session_id, no
  // account_limits, no secondary indexes, stamped user_version 2.
  const v2 = new DatabaseSync(dbPath);
  v2.exec("PRAGMA journal_mode = WAL");
  v2.exec(
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT,
       model_class TEXT, cost_usd REAL, last_ts INTEGER,
       byte_offset INTEGER NOT NULL, month TEXT, tokens_json TEXT,
       parent_session_id TEXT, machine_id TEXT)`,
  );
  v2.prepare(
    "INSERT INTO sessions (session_id, path, byte_offset, model_class, month) VALUES (?, ?, ?, ?, ?)",
  ).run("kept", "/fake/kept.jsonl", 5, "opus", "2026-06");
  v2.exec("PRAGMA user_version = 2");
  v2.close();

  const db = openDb(dbPath);
  assert.strictEqual(
    schemaVersion(db),
    SCHEMA_VERSION,
    "the store walks the ladder to the current schema",
  );

  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  assert.ok(
    tables.includes("account_limits"),
    "the account_limits table was created",
  );

  const indexes = (
    db.prepare("PRAGMA index_list(sessions)").all() as Array<{ name: string }>
  ).map((r) => r.name);
  assert.ok(indexes.includes("idx_sessions_month_class"));
  assert.ok(indexes.includes("idx_sessions_last_ts"));

  const row = db
    .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
    .get("kept") as { session_id: string };
  assert.strictEqual(row.session_id, "kept", "the pre-existing row survived");
  db.close();
});

test("opening an existing v3 store migrates it to v4 in place, adding the meta table and preserving rows", () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "v3.db");

  // Hand-build a v3 store: sessions + account_limits + the read indexes, no meta,
  // stamped user_version 3.
  const v3 = new DatabaseSync(dbPath);
  v3.exec("PRAGMA journal_mode = WAL");
  v3.exec(
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT,
       model_class TEXT, cost_usd REAL, last_ts INTEGER,
       byte_offset INTEGER NOT NULL, month TEXT, tokens_json TEXT,
       parent_session_id TEXT, machine_id TEXT)`,
  );
  v3.exec(
    `CREATE TABLE account_limits (
       window_kind TEXT PRIMARY KEY, used_percentage REAL,
       resets_at INTEGER, observed_at INTEGER NOT NULL)`,
  );
  v3.prepare(
    "INSERT INTO sessions (session_id, path, byte_offset, model_class, month) VALUES (?, ?, ?, ?, ?)",
  ).run("kept", "/fake/kept.jsonl", 5, "opus", "2026-06");
  v3.exec("PRAGMA user_version = 3");
  v3.close();

  const db = openDb(dbPath);
  assert.strictEqual(schemaVersion(db), SCHEMA_VERSION, "migrated to current");

  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  assert.ok(tables.includes("meta"), "the v4 meta table was created");

  const row = db
    .prepare("SELECT session_id FROM sessions WHERE session_id = ?")
    .get("kept") as { session_id: string };
  assert.strictEqual(row.session_id, "kept", "the pre-existing row survived");
  db.close();
});

test("opening an existing v4 store migrates it to v5 with a nullable heartbeat and preserves rows", () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "v4.db");
  const v4 = new DatabaseSync(dbPath);
  v4.exec("PRAGMA journal_mode = WAL");
  v4.exec(
    `CREATE TABLE sessions (
       session_id TEXT PRIMARY KEY, path TEXT NOT NULL, branch TEXT,
       model_class TEXT, cost_usd REAL, last_ts INTEGER,
       byte_offset INTEGER NOT NULL, month TEXT, tokens_json TEXT,
       parent_session_id TEXT, machine_id TEXT)`,
  );
  v4.exec(
    `CREATE TABLE account_limits (
       window_kind TEXT PRIMARY KEY, used_percentage REAL,
       resets_at INTEGER, observed_at INTEGER NOT NULL)`,
  );
  v4.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  v4.prepare(
    "INSERT INTO sessions (session_id, path, byte_offset, last_ts) VALUES (?, ?, ?, ?)",
  ).run("kept", "/fake/kept.jsonl", 17, 1234);
  v4.exec("PRAGMA user_version = 4");
  v4.close();

  const db = openDb(dbPath);
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
  }>;
  const row = db
    .prepare(
      "SELECT session_id, byte_offset, last_ts, heartbeat_ms FROM sessions WHERE session_id = ?",
    )
    .get("kept") as {
    session_id: string;
    byte_offset: number;
    last_ts: number;
    heartbeat_ms: number | null;
  };

  assert.strictEqual(schemaVersion(db), 5);
  assert.ok(columns.some((column) => column.name === "heartbeat_ms"));
  assert.strictEqual(row.session_id, "kept");
  assert.strictEqual(row.byte_offset, 17);
  assert.strictEqual(row.last_ts, 1234);
  assert.strictEqual(row.heartbeat_ms, null);
  assert.strictEqual(
    getSession(db, "kept")?.transcriptIndexed,
    true,
    "a meaningful legacy row with NULL tokens_json remains authoritative",
  );
  db.close();
});

test("a fresh store carries the v4 meta table", () => {
  const db = openDb(":memory:");
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  db.close();
  assert.ok(tables.includes("meta"), "the meta table exists on a fresh store");
});

test("meta round-trips a value and the latest write wins on the same key", () => {
  const db = openDb(":memory:");
  assert.strictEqual(getMeta(db, "k"), undefined, "absent key reads undefined");
  setMeta(db, "k", "first");
  assert.strictEqual(getMeta(db, "k"), "first");
  setMeta(db, "k", "second");
  assert.strictEqual(getMeta(db, "k"), "second", "upsert overwrites in place");
  db.close();
});

test("an in-memory DatabaseSync store upserts and reads back a session row", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, byte_offset INTEGER)",
  );
  db.prepare(
    "INSERT INTO sessions (session_id, byte_offset) VALUES (?, ?)",
  ).run("s1", 123);
  const row = db
    .prepare("SELECT byte_offset FROM sessions WHERE session_id = ?")
    .get("s1") as { byte_offset: number };
  assert.equal(row.byte_offset, 123);
  db.close();
});
