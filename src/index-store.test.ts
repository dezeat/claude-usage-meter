import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  foldLines,
  discoverTranscriptPaths,
  parentSessionIdOf,
  updateIndex,
  updateSession,
  readIndex,
  monthTotals,
  branchTotals,
  sessionTotals,
  sumTokens,
  monthSessionCounts,
  liveSessionCounts,
  monthClassSpend,
  monthOf,
  upsertCountForTest,
  resetUpsertCountForTest,
  type CrossSessionIndex,
  type SessionRecord,
} from "./index-store.js";
import { DEFAULT_PRICING } from "./pricing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "index-store-test-"));
}

function writeJsonl(dir: string, name: string, lines: string[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

function assistantLine(opts: {
  ts: string;
  branch: string;
  reqId: string;
  msgId: string;
  model: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
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
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
      },
    },
  });
}

function userLine(ts: string, branch: string): string {
  return JSON.stringify({ type: "user", timestamp: ts, gitBranch: branch });
}

// ---------------------------------------------------------------------------
// Fake discovery: bypass real ~/.claude/projects by injecting a claudeDir
// containing symlinks/dirs that match the glob pattern.
// ---------------------------------------------------------------------------

function makeClaudeDir(tmpRoot: string, transcriptPaths: string[]): string {
  const claudeDir = join(tmpRoot, "claude");
  const projectDir = join(claudeDir, "projects", "-fake-midnight-marble");
  mkdirSync(projectDir, { recursive: true });
  for (const src of transcriptPaths) {
    const dest = join(projectDir, src.split("/").pop()!);
    writeFileSync(dest, readFileSync(src));
  }
  return join(claudeDir, "projects");
}

// ---------------------------------------------------------------------------
// Test 1: multi-session totals — correct per-session, per-month, per-branch
// ---------------------------------------------------------------------------

test("building the index over multiple synthetic sessions yields correct per-session and per-month/per-branch totals", async () => {
  const tmp = makeTmpDir();

  const sessionA = writeJsonl(tmp, "session-a.jsonl", [
    userLine("2026-06-13T09:59:00.000Z", "main"),
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
    }),
    assistantLine({
      ts: "2026-06-13T10:05:00.000Z",
      branch: "main",
      reqId: "r2",
      msgId: "m2",
      model: "claude-sonnet-4-6",
      input: 200,
      output: 80,
      cacheRead: 500,
    }),
  ]);

  const sessionB = writeJsonl(tmp, "session-b.jsonl", [
    userLine("2026-05-20T14:00:00.000Z", "feat/foo"),
    assistantLine({
      ts: "2026-05-20T14:01:00.000Z",
      branch: "feat/foo",
      reqId: "r3",
      msgId: "m3",
      model: "claude-opus-4-8",
      input: 400,
      output: 100,
      cacheRead: 1000,
      cacheCreate: 200,
    }),
  ]);

  const claudeProjects = makeClaudeDir(tmp, [sessionA, sessionB]);
  const indexPath = join(tmp, "index.json");

  const index = await updateIndex(indexPath, claudeProjects, DEFAULT_PRICING);

  // Locate session records by sessionId rather than absolute path (path differs in the claude dir copy)
  const sessions = Object.values(index.sessions);
  const recA = sessions.find((s) => s.sessionId === "session-a");
  const recB = sessions.find((s) => s.sessionId === "session-b");

  assert.ok(recA, "session-a record present");
  assert.equal(recA.branch, "main");
  assert.equal(recA.modelClass, "sonnet");
  assert.equal(recA.tokens["claude-sonnet-4-6"]?.inputTokens, 300);
  assert.equal(recA.tokens["claude-sonnet-4-6"]?.outputTokens, 130);
  assert.equal(recA.tokens["claude-sonnet-4-6"]?.cacheReadTokens, 500);

  assert.ok(recB, "session-b record present");
  assert.equal(recB.branch, "feat/foo");
  assert.equal(recB.modelClass, "opus");
  assert.equal(recB.tokens["claude-opus-4-8"]?.inputTokens, 400);

  // per-month totals
  const jun = monthTotals(index, "2026-06");
  assert.equal(jun.tokens["claude-sonnet-4-6"]?.inputTokens, 300);

  const may = monthTotals(index, "2026-05");
  assert.equal(may.tokens["claude-opus-4-8"]?.inputTokens, 400);

  // per-branch totals
  const mainBranch = branchTotals(index, "main");
  assert.equal(mainBranch.tokens["claude-sonnet-4-6"]?.inputTokens, 300);

  const fooB = branchTotals(index, "feat/foo");
  assert.equal(fooB.tokens["claude-opus-4-8"]?.inputTokens, 400);
});

// ---------------------------------------------------------------------------
// Test 2: incremental update reads only grown bytes (offset assertion)
// ---------------------------------------------------------------------------

test("a second incremental update reads only the grown file and advances offset only for the changed transcript", async () => {
  const tmp = makeTmpDir();

  const lines = [
    userLine("2026-06-13T10:00:00.000Z", "main"),
    assistantLine({
      ts: "2026-06-13T10:01:00.000Z",
      branch: "main",
      reqId: "rA",
      msgId: "mA",
      model: "claude-sonnet-4-6",
      input: 50,
      output: 10,
    }),
  ];

  const transcriptPath = writeJsonl(tmp, "growing.jsonl", lines);
  const claudeProjects = makeClaudeDir(tmp, [transcriptPath]);
  const indexPath = join(tmp, "index.json");

  const index1 = await updateIndex(indexPath, claudeProjects, DEFAULT_PRICING);
  const sessions1 = Object.values(index1.sessions);
  const rec1 = sessions1.find((s) => s.sessionId === "growing");
  assert.ok(rec1);
  const offsetAfterFirst = rec1.byteOffset;
  assert.ok(offsetAfterFirst > 0, "offset advanced after first update");

  // Second update without change: offset must not advance on the unchanged file
  const index2 = await updateIndex(indexPath, claudeProjects, DEFAULT_PRICING);
  const sessions2 = Object.values(index2.sessions);
  const rec2 = sessions2.find((s) => s.sessionId === "growing");
  assert.ok(rec2);
  assert.equal(
    rec2.byteOffset,
    offsetAfterFirst,
    "offset unchanged when no new data",
  );

  // Append a new line to the file in the claude dir copy
  const claudeProjDir = join(claudeProjects, "-fake-midnight-marble");
  const copiedPath = join(claudeProjDir, "growing.jsonl");
  const extra = assistantLine({
    ts: "2026-06-13T10:10:00.000Z",
    branch: "main",
    reqId: "rB",
    msgId: "mB",
    model: "claude-sonnet-4-6",
    input: 100,
    output: 20,
  });
  writeFileSync(copiedPath, readFileSync(copiedPath, "utf8") + extra + "\n");

  const index3 = await updateIndex(indexPath, claudeProjects, DEFAULT_PRICING);
  const sessions3 = Object.values(index3.sessions);
  const rec3 = sessions3.find((s) => s.sessionId === "growing");
  assert.ok(rec3);
  assert.ok(
    rec3.byteOffset > offsetAfterFirst,
    "offset advanced after file grew",
  );
  assert.equal(
    rec3.tokens["claude-sonnet-4-6"]?.inputTokens,
    150,
    "cumulative tokens correct after incremental read",
  );
});

// ---------------------------------------------------------------------------
// Test 3: mid-line boundary — partial trailing line counted exactly once
// ---------------------------------------------------------------------------

test("a read ending mid-line neither drops nor double-counts the partial line on the next update", async () => {
  const tmp = makeTmpDir();
  const claudeProjDir = join(tmp, "projects", "-fake-midnight-marble");
  mkdirSync(claudeProjDir, { recursive: true });
  const claudeProjects = join(tmp, "projects");
  const indexPath = join(tmp, "index.json");

  const completeLine =
    userLine("2026-06-13T09:00:00.000Z", "main") +
    "\n" +
    assistantLine({
      ts: "2026-06-13T09:01:00.000Z",
      branch: "main",
      reqId: "rC1",
      msgId: "mC1",
      model: "claude-sonnet-4-6",
      input: 70,
      output: 30,
    }) +
    "\n";

  const partialAssistant = assistantLine({
    ts: "2026-06-13T09:02:00.000Z",
    branch: "main",
    reqId: "rC2",
    msgId: "mC2",
    model: "claude-sonnet-4-6",
    input: 80,
    output: 40,
  });

  const transcriptFile = join(claudeProjDir, "boundary.jsonl");

  // Write the complete lines plus the partial line without a trailing newline
  writeFileSync(transcriptFile, completeLine + partialAssistant, "utf8");

  // First update: the partial line has no trailing \n so the offset must stop
  // before it, meaning only the 70-input line is counted.
  const index1 = await updateIndex(indexPath, claudeProjects, DEFAULT_PRICING);
  const rec1 = Object.values(index1.sessions).find(
    (s) => s.sessionId === "boundary",
  );
  assert.ok(rec1);
  assert.equal(
    rec1.tokens["claude-sonnet-4-6"]?.inputTokens,
    70,
    "partial line not counted on first read",
  );

  // Complete the partial line by appending a newline
  writeFileSync(transcriptFile, completeLine + partialAssistant + "\n", "utf8");

  // Second update: now the previously partial line is complete and counted exactly once
  const index2 = await updateIndex(indexPath, claudeProjects, DEFAULT_PRICING);
  const rec2 = Object.values(index2.sessions).find(
    (s) => s.sessionId === "boundary",
  );
  assert.ok(rec2);
  assert.equal(
    rec2.tokens["claude-sonnet-4-6"]?.inputTokens,
    150,
    "formerly partial line counted exactly once after newline lands",
  );
});

// ---------------------------------------------------------------------------
// Test 4: <synthetic> model excluded from tokens and cost
// ---------------------------------------------------------------------------

test("<synthetic> model is excluded from tokens and cost", () => {
  const seenKeys = new Set<string>();
  const lines = [
    userLine("2026-06-13T11:00:00.000Z", "main"),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-13T11:01:00.000Z",
      gitBranch: "main",
      requestId: "req-syn",
      message: {
        id: "msg-syn",
        model: "<synthetic>",
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    }),
    assistantLine({
      ts: "2026-06-13T11:02:00.000Z",
      branch: "main",
      reqId: "rH1",
      msgId: "mH1",
      model: "claude-haiku-4-5",
      input: 50,
      output: 20,
    }),
  ];

  const result = foldLines(undefined, lines, seenKeys);

  assert.ok(
    !("<synthetic>" in result.tokens),
    "<synthetic> must not appear as a token key",
  );
  assert.equal(
    result.tokens["claude-haiku-4-5"]?.inputTokens,
    50,
    "real model still counted",
  );
  assert.equal(result.modelClass, "haiku");
});

// ---------------------------------------------------------------------------
// Test 5: empty-session fixture produces zero-token record without throwing
// ---------------------------------------------------------------------------

test("an empty-session fixture (zero assistant lines) produces a zero-token record without throwing", () => {
  const lines = [
    userLine("2026-06-13T08:00:00.000Z", "main"),
    JSON.stringify({ type: "summary", summary: "no assistant messages here" }),
  ];

  const seenKeys = new Set<string>();
  let result: ReturnType<typeof foldLines> | undefined;
  assert.doesNotThrow(() => {
    result = foldLines(undefined, lines, seenKeys);
  });
  assert.ok(result);
  assert.deepEqual(result.tokens, {}, "tokens are empty object");
  assert.equal(result.costUsd, 0);
});

// ---------------------------------------------------------------------------
// Test 6: model id without '-' handled without crashing; returns usable class
// ---------------------------------------------------------------------------

test("a model id without '-' is handled without crashing and returns a usable class", () => {
  const seenKeys = new Set<string>();
  const lines = [
    assistantLine({
      ts: "2026-06-13T12:01:00.000Z",
      branch: "main",
      reqId: "rND",
      msgId: "mND",
      model: "localmodel",
      input: 10,
      output: 5,
    }),
  ];

  let result: ReturnType<typeof foldLines> | undefined;
  assert.doesNotThrow(() => {
    result = foldLines(undefined, lines, seenKeys);
  });
  assert.ok(result);
  assert.ok(
    "localmodel" in result.tokens,
    "model id without dash becomes a token key",
  );
  assert.equal(
    result.modelClass,
    "localmodel",
    "raw id used as class when no known class word matches",
  );
});

// ---------------------------------------------------------------------------
// sumTokens / sessionTotals
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    path: "/fake/s.jsonl",
    sessionId: "s",
    branch: "main",
    modelClass: "opus",
    tokens: {},
    costUsd: 0,
    lastTs: 0,
    byteOffset: 0,
    ...overrides,
  };
}

function indexOf(records: SessionRecord[]): CrossSessionIndex {
  const sessions: CrossSessionIndex["sessions"] = {};
  for (const rec of records) sessions[rec.sessionId] = rec;
  return { sessions, byMonth: {}, byBranch: {}, updatedAt: 0 };
}

test("sumTokens adds input, output and both cache fields across all models", () => {
  const total = sumTokens({
    "claude-opus-4-8": {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 400,
    },
    "claude-sonnet-4-6": {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    },
  });
  assert.equal(total, 1010);
});

test("sessionTotals returns the row matched by session_id", () => {
  const index = indexOf([
    makeRecord({
      sessionId: "abc",
      costUsd: 2.14,
      tokens: {
        "claude-opus-4-8": {
          inputTokens: 500_000,
          outputTokens: 500_000,
          cacheReadTokens: 100_000,
          cacheCreationTokens: 100_000,
        },
      },
    }),
  ]);
  const totals = sessionTotals(index, "abc", undefined);
  assert.ok(totals);
  assert.equal(totals.costUsd, 2.14);
  assert.equal(sumTokens(totals.tokens), 1_200_000);
});

test("sessionTotals returns undefined when no row matches the session_id", () => {
  const index = indexOf([makeRecord({ sessionId: "abc" })]);
  assert.equal(sessionTotals(index, "missing", undefined), undefined);
});

test("sessionTotals falls back to the path column only when session_id is absent", () => {
  const index = indexOf([
    makeRecord({ sessionId: "abc", path: "/t/abc.jsonl", costUsd: 9.9 }),
  ]);
  const byPath = sessionTotals(index, undefined, "/t/abc.jsonl");
  assert.ok(byPath);
  assert.equal(byPath.costUsd, 9.9);
});

test("when session_id is present it wins and a stale path is not consulted", () => {
  const index = indexOf([
    makeRecord({ sessionId: "abc", path: "/t/abc.jsonl", costUsd: 9.9 }),
  ]);
  // session_id present but unknown → undefined, even though the path would match.
  assert.equal(sessionTotals(index, "missing", "/t/abc.jsonl"), undefined);
});

// ---------------------------------------------------------------------------
// Store-level month + live count wrappers over the SQLite store
// ---------------------------------------------------------------------------

test("monthSessionCounts and liveSessionCounts scope a two-month store correctly", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");

  // now sits in June; one June session is live, the others are old.
  const nowMs = Date.UTC(2026, 5, 15, 12, 0, 0);
  const liveTs = new Date(nowMs - 60 * 1000).toISOString();

  const juneLive = writeJsonl(tmp, "june-live.jsonl", [
    assistantLine({
      ts: liveTs,
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);
  const juneIdle = writeJsonl(tmp, "june-idle.jsonl", [
    assistantLine({
      ts: "2026-06-01T10:00:00.000Z",
      branch: "main",
      reqId: "r2",
      msgId: "m2",
      model: "claude-sonnet-4-6",
      input: 10,
      output: 5,
    }),
  ]);
  const may = writeJsonl(tmp, "may.jsonl", [
    assistantLine({
      ts: "2026-05-20T10:00:00.000Z",
      branch: "main",
      reqId: "r3",
      msgId: "m3",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);

  const claudeProjects = makeClaudeDir(tmp, [juneLive, juneIdle, may]);
  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  const june = monthSessionCounts(dbPath, "2026-06");
  assert.strictEqual(june.total, 2, "two June sessions, May excluded");
  const juneByClass = new Map(june.byClass.map((c) => [c.cls, c.count]));
  assert.strictEqual(juneByClass.get("opus"), 1);
  assert.strictEqual(juneByClass.get("sonnet"), 1);

  const live = liveSessionCounts(dbPath, nowMs, 5 * 60 * 1000);
  const liveByClass = new Map(live.map((c) => [c.cls, c.count]));
  assert.strictEqual(
    liveByClass.get("opus"),
    1,
    "the recent June opus is live",
  );
  assert.strictEqual(
    liveByClass.get("sonnet"),
    undefined,
    "the idle June sonnet is not live",
  );
});

test("monthOf derives the YYYY-MM the store stamps for a timestamp", () => {
  assert.strictEqual(monthOf(Date.UTC(2026, 5, 15)), "2026-06");
  assert.strictEqual(monthOf(0), "unknown");
});

// ---------------------------------------------------------------------------
// Refresh debounce: a tick where no transcript grew performs zero writes
// ---------------------------------------------------------------------------

test("an updateIndex tick where no transcript grew performs zero upserts yet still returns correct totals", async () => {
  const tmp = makeTmpDir();
  const transcript = writeJsonl(tmp, "static.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [transcript]);
  const dbPath = join(tmp, "index.db");

  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  // Second tick on an unchanged file: the debounce must skip the write path.
  resetUpsertCountForTest();
  const index = await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  assert.strictEqual(
    upsertCountForTest(),
    0,
    "no session advanced, so no upsert is performed",
  );

  const rec = Object.values(index.sessions).find(
    (s) => s.sessionId === "static",
  );
  assert.ok(rec, "the stored session is still returned from the read");
  assert.strictEqual(rec.tokens["claude-sonnet-4-6"]?.inputTokens, 100);
  assert.strictEqual(rec.tokens["claude-sonnet-4-6"]?.outputTokens, 50);
});

test("an updateIndex tick where one of two transcripts grew upserts only the advanced session", async () => {
  const tmp = makeTmpDir();
  const stable = writeJsonl(tmp, "stable.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "rS",
      msgId: "mS",
      model: "claude-sonnet-4-6",
      input: 100,
      output: 50,
    }),
  ]);
  const growing = writeJsonl(tmp, "growing.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "rG1",
      msgId: "mG1",
      model: "claude-opus-4-8",
      input: 200,
      output: 60,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [stable, growing]);
  const dbPath = join(tmp, "index.db");

  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  // Append to only one of the two transcripts in the claude-dir copy.
  const grownCopy = join(
    claudeProjects,
    "-fake-midnight-marble",
    "growing.jsonl",
  );
  const extra = assistantLine({
    ts: "2026-06-13T10:10:00.000Z",
    branch: "main",
    reqId: "rG2",
    msgId: "mG2",
    model: "claude-opus-4-8",
    input: 300,
    output: 90,
  });
  writeFileSync(grownCopy, readFileSync(grownCopy, "utf8") + extra + "\n");

  resetUpsertCountForTest();
  const index = await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  assert.strictEqual(
    upsertCountForTest(),
    1,
    "only the one advanced session is upserted, not the unchanged one",
  );

  const grew = Object.values(index.sessions).find(
    (s) => s.sessionId === "growing",
  );
  assert.ok(grew);
  assert.strictEqual(
    grew.tokens["claude-opus-4-8"]?.inputTokens,
    500,
    "the advanced session's cumulative tokens are updated",
  );
});

test("live counts reflect the current clock on a read-only tick: a session ages out of the window with no new bytes", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");

  // Build the store once at a clock where the session is fresh.
  const lastTs = Date.UTC(2026, 5, 15, 12, 0, 0);
  const transcript = writeJsonl(tmp, "aging.jsonl", [
    assistantLine({
      ts: new Date(lastTs).toISOString(),
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [transcript]);
  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  const windowMs = 5 * 60 * 1000;

  // A read-only tick one minute later: still inside the 5-minute window.
  const liveNow = lastTs + 60 * 1000;
  resetUpsertCountForTest();
  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);
  assert.strictEqual(upsertCountForTest(), 0, "no new bytes, no write");

  const liveEarly = new Map(
    liveSessionCounts(dbPath, liveNow, windowMs).map((c) => [c.cls, c.count]),
  );
  assert.strictEqual(liveEarly.get("opus"), 1, "session is live one minute on");

  // A later read-only tick: the same unchanged session has aged past the
  // window, so it drops out — purely from the clock, with no write.
  const lateNow = lastTs + 6 * 60 * 1000;
  const liveLate = new Map(
    liveSessionCounts(dbPath, lateNow, windowMs).map((c) => [c.cls, c.count]),
  );
  assert.strictEqual(
    liveLate.get("opus"),
    undefined,
    "session aged out of the liveness window without any new bytes",
  );
});

test("monthClassSpend slices a month's tokens+cost per class with Σ summed over the same rows", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");

  // June: opus 1.0M input → $5.00; sonnet 2.0M input → $6.00. May opus is
  // excluded from June's slice. Two opus June sessions prove per-class summation.
  const opusJunA = writeJsonl(tmp, "opus-a.jsonl", [
    assistantLine({
      ts: "2026-06-10T10:00:00.000Z",
      branch: "main",
      reqId: "ra",
      msgId: "ma",
      model: "claude-opus-4-8",
      input: 600_000,
      output: 0,
    }),
  ]);
  const opusJunB = writeJsonl(tmp, "opus-b.jsonl", [
    assistantLine({
      ts: "2026-06-12T10:00:00.000Z",
      branch: "main",
      reqId: "rb",
      msgId: "mb",
      model: "claude-opus-4-8",
      input: 400_000,
      output: 0,
    }),
  ]);
  const sonnetJun = writeJsonl(tmp, "sonnet.jsonl", [
    assistantLine({
      ts: "2026-06-11T10:00:00.000Z",
      branch: "main",
      reqId: "rc",
      msgId: "mc",
      model: "claude-sonnet-4-6",
      input: 2_000_000,
      output: 0,
    }),
  ]);
  const opusMay = writeJsonl(tmp, "opus-may.jsonl", [
    assistantLine({
      ts: "2026-05-20T10:00:00.000Z",
      branch: "main",
      reqId: "rd",
      msgId: "md",
      model: "claude-opus-4-8",
      input: 9_000_000,
      output: 0,
    }),
  ]);

  const claudeProjects = makeClaudeDir(tmp, [
    opusJunA,
    opusJunB,
    sonnetJun,
    opusMay,
  ]);
  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);

  const spend = monthClassSpend(dbPath, "2026-06");

  assert.strictEqual(spend.byClass["opus"]?.tokens, 1_000_000);
  assert.strictEqual(spend.byClass["opus"]?.costUsd, 5);
  assert.strictEqual(spend.byClass["sonnet"]?.tokens, 2_000_000);
  assert.strictEqual(spend.byClass["sonnet"]?.costUsd, 6);
  assert.strictEqual(
    spend.byClass["haiku"],
    undefined,
    "a class absent from the month has no slice",
  );

  assert.strictEqual(
    spend.total.tokens,
    3_000_000,
    "Σ tokens over all classes",
  );
  assert.strictEqual(spend.total.costUsd, 11, "Σ cost over all classes");
});

test("updateSession persists one session from its transcript path alone, with no project sweep", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");
  // A transcript sitting on its own — NOT under any discoverable claudeDir — proving
  // the event write indexes by explicit path, not via the cross-project sweep.
  const transcript = writeJsonl(tmp, "solo.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 1_000_000,
      output: 0,
    }),
  ]);

  updateSession(dbPath, transcript, DEFAULT_PRICING);

  const index = await readIndex(dbPath);
  assert.ok(index, "the store exists and holds the one persisted session");
  assert.deepStrictEqual(Object.keys(index.sessions), ["solo"]);
  // Opus 4.8 input is $5 / 1M tokens (published pricing) → 1M input = $5.00.
  assert.strictEqual(index.sessions["solo"]?.costUsd, 5);
});

test("updateSession folds only new bytes on a later call and never touches other sessions", async () => {
  const tmp = makeTmpDir();
  const dbPath = join(tmp, "index.db");

  // A different session already in the store; updateSession must leave it untouched.
  const other = writeJsonl(tmp, "other.jsonl", [
    assistantLine({
      ts: "2026-06-13T09:00:00.000Z",
      branch: "main",
      reqId: "rO",
      msgId: "mO",
      model: "claude-sonnet-4-6",
      input: 1000,
      output: 0,
    }),
  ]);
  updateSession(dbPath, other, DEFAULT_PRICING);

  const target = writeJsonl(tmp, "target.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 400_000,
      output: 0,
    }),
  ]);
  updateSession(dbPath, target, DEFAULT_PRICING);

  // Append a second turn, then write again: only the new bytes fold in.
  const extra = assistantLine({
    ts: "2026-06-13T10:05:00.000Z",
    branch: "main",
    reqId: "r2",
    msgId: "m2",
    model: "claude-opus-4-8",
    input: 600_000,
    output: 0,
  });
  writeFileSync(target, readFileSync(target, "utf8") + extra + "\n");

  resetUpsertCountForTest();
  updateSession(dbPath, target, DEFAULT_PRICING);
  assert.strictEqual(
    upsertCountForTest(),
    1,
    "exactly the one targeted session is upserted",
  );

  const index = await readIndex(dbPath);
  assert.ok(index);
  assert.strictEqual(
    index.sessions["target"]?.tokens["claude-opus-4-8"]?.inputTokens,
    1_000_000,
    "the target's cumulative tokens reflect both turns",
  );
  assert.ok(index.sessions["other"], "the other session is left untouched");
});

test("discovery spans every project, not a single hardcoded project name", () => {
  const tmp = makeTmpDir();
  const projects = join(tmp, "projects");
  // The cross-session view covers "every project session" (README), so discovery
  // must not be gated on the project-directory name. Two unrelated projects, named
  // for arbitrary user repos, are both indexed.
  const acme = join(projects, "-home-u-work-acme-api");
  const side = join(projects, "-home-u-side-quest");
  mkdirSync(acme, { recursive: true });
  mkdirSync(side, { recursive: true });
  const a = writeJsonl(acme, "a.jsonl", [
    userLine("2026-06-13T10:00:00.000Z", "main"),
  ]);
  const b = writeJsonl(side, "b.jsonl", [
    userLine("2026-06-13T10:00:00.000Z", "main"),
  ]);

  assert.deepEqual(new Set(discoverTranscriptPaths(projects)), new Set([a, b]));
});

test("parentSessionIdOf reads the parent id from a subagent path, undefined for a top-level transcript", () => {
  assert.strictEqual(
    parentSessionIdOf("/c/projects/-proj/PARENT/subagents/agent-x.jsonl"),
    "PARENT",
  );
  assert.strictEqual(
    parentSessionIdOf("/c/projects/-proj/SESSION.jsonl"),
    undefined,
  );
});

test("discovery descends into <session>/subagents/ and finds subagent transcripts", () => {
  const tmp = makeTmpDir();
  const projects = join(tmp, "projects");
  const proj = join(projects, "-proj");
  mkdirSync(join(proj, "S", "subagents"), { recursive: true });
  const main = writeJsonl(proj, "S.jsonl", [
    userLine("2026-06-13T10:00:00.000Z", "main"),
  ]);
  const sub = join(proj, "S", "subagents", "agent-1.jsonl");
  writeFileSync(
    sub,
    userLine("2026-06-13T10:01:00.000Z", "main") + "\n",
    "utf8",
  );

  assert.deepEqual(
    new Set(discoverTranscriptPaths(projects)),
    new Set([main, sub]),
  );
});

test("subagent tokens are credited to the parent session, counted under their own class, never a session", async () => {
  const tmp = makeTmpDir();
  const projects = join(tmp, "projects");
  const proj = join(projects, "-home-u-proj");
  const PARENT = "11111111-1111-1111-1111-111111111111";
  mkdirSync(join(proj, PARENT, "subagents"), { recursive: true });

  // Parent: opus, 1M input → $5.00 (published Opus 4.8 pricing).
  writeFileSync(
    join(proj, `${PARENT}.jsonl`),
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "rp",
      msgId: "mp",
      model: "claude-opus-4-8",
      input: 1_000_000,
      output: 0,
    }) + "\n",
    "utf8",
  );
  // Subagent in the real sidechain shape: haiku, 2M input → $2.00 (Haiku 4.5 $1/Mtok).
  writeFileSync(
    join(proj, PARENT, "subagents", "agent-x.jsonl"),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      sessionId: PARENT,
      parentUuid: "u",
      timestamp: "2026-06-13T10:01:00.000Z",
      gitBranch: "main",
      requestId: "rs",
      message: {
        id: "ms",
        model: "claude-haiku-4-5",
        usage: { input_tokens: 2_000_000, output_tokens: 0 },
      },
    }) + "\n",
    "utf8",
  );

  const dbPath = join(tmp, "index.db");
  const index = await updateIndex(dbPath, projects, DEFAULT_PRICING);

  // Credited to the parent session: $5 opus + $2 haiku.
  const totals = sessionTotals(index, PARENT, undefined);
  assert.ok(totals);
  assert.strictEqual(
    totals.costUsd,
    7,
    "parent total includes the subagent's $2",
  );

  // Per-class spend keeps the subagent under its real class (haiku), not the parent's.
  const spend = monthClassSpend(dbPath, "2026-06");
  assert.strictEqual(spend.byClass["opus"]?.costUsd, 5);
  assert.strictEqual(spend.byClass["haiku"]?.costUsd, 2);

  // Session count: one opus session; the subagent is not counted as a session.
  const counts = monthSessionCounts(dbPath, "2026-06");
  assert.strictEqual(
    counts.byClass.find((c) => c.cls === "opus")?.count,
    1,
    "the parent is the one session",
  );
  assert.strictEqual(
    counts.byClass.find((c) => c.cls === "haiku"),
    undefined,
    "the subagent is not a haiku session",
  );
  assert.strictEqual(
    counts.total,
    1,
    "one session total — the subagent excluded",
  );

  // The child row exists, tagged with its parent.
  assert.strictEqual(index.sessions["agent-x"]?.parentSessionId, PARENT);
});

// ---------------------------------------------------------------------------
// Cross-session limits sync: freshest account-wide 5h/7d wins (Discussion #63)
// ---------------------------------------------------------------------------

test("updateIndex without a limits observation leaves index.limits undefined (report/back-compat path)", async () => {
  const tmp = makeTmpDir();
  const transcript = writeJsonl(tmp, "s.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [transcript]);
  const dbPath = join(tmp, "index.db");

  const index = await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING);
  assert.strictEqual(index.limits, undefined);
});

test("updateIndex persists this session's 5h/7d snapshot and returns it as the freshest when the store was empty", async () => {
  const tmp = makeTmpDir();
  const transcript = writeJsonl(tmp, "s.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [transcript]);
  const dbPath = join(tmp, "index.db");

  const index = await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING, {
    fiveHour: { usedPercentage: 40, resetsAt: 1000 },
    sevenDay: { usedPercentage: 70, resetsAt: 9000 },
    observedAt: 100,
  });
  assert.deepStrictEqual(index.limits?.fiveHour, {
    usedPercentage: 40,
    resetsAt: 1000,
  });
  assert.deepStrictEqual(index.limits?.sevenDay, {
    usedPercentage: 70,
    resetsAt: 9000,
  });
});

test("a later observation wins across sessions — the freshest 5h usage is rendered, not the laggy one", async () => {
  const tmp = makeTmpDir();
  const transcript = writeJsonl(tmp, "s.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [transcript]);
  const dbPath = join(tmp, "index.db");

  // Session A observes 40% at t=100; session B observes the fresher 55% at t=200.
  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING, {
    fiveHour: { usedPercentage: 40, resetsAt: 1000 },
    observedAt: 100,
  });
  const indexB = await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING, {
    fiveHour: { usedPercentage: 55, resetsAt: 1200 },
    observedAt: 200,
  });
  assert.strictEqual(indexB.limits?.fiveHour?.usedPercentage, 55);

  // A laggy session A re-renders with its stale t=150 snapshot: the store's
  // fresher t=200 value wins, so this session renders 55, not its own 45.
  const indexAlate = await updateIndex(
    dbPath,
    claudeProjects,
    DEFAULT_PRICING,
    {
      fiveHour: { usedPercentage: 45, resetsAt: 1100 },
      observedAt: 150,
    },
  );
  assert.strictEqual(
    indexAlate.limits?.fiveHour?.usedPercentage,
    55,
    "the freshest cross-session observation wins over the local laggy payload",
  );
});

test("a session with no 5h payload still reads the freshest stored window so it is not blank", async () => {
  const tmp = makeTmpDir();
  const transcript = writeJsonl(tmp, "s.jsonl", [
    assistantLine({
      ts: "2026-06-13T10:00:00.000Z",
      branch: "main",
      reqId: "r1",
      msgId: "m1",
      model: "claude-opus-4-8",
      input: 10,
      output: 5,
    }),
  ]);
  const claudeProjects = makeClaudeDir(tmp, [transcript]);
  const dbPath = join(tmp, "index.db");

  await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING, {
    fiveHour: { usedPercentage: 62, resetsAt: 1000 },
    observedAt: 100,
  });
  // This session's payload carries no 5h window; it must surface the stored one.
  const index = await updateIndex(dbPath, claudeProjects, DEFAULT_PRICING, {
    observedAt: 200,
  });
  assert.strictEqual(index.limits?.fiveHour?.usedPercentage, 62);
});
