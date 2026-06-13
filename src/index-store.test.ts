import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  foldLines,
  updateIndex,
  monthTotals,
  branchTotals,
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
