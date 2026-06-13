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
    [...ids].sort(),
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
    [...ids].sort(),
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
