import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { aggregateTranscript } from "./aggregate.js";

function fixtureLines(name: string): string[] {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return readFileSync(url, "utf8").split("\n");
}

test("tokens accumulate per model across assistant lines", () => {
  const result = aggregateTranscript(fixtureLines("transcript.jsonl"));

  assert.deepEqual(result.models["claude-opus-4-8"], {
    inputTokens: 300,
    outputTokens: 60,
    cacheReadTokens: 3000,
    cacheCreationTokens: 50,
  });
  assert.deepEqual(result.models["claude-sonnet-4-6"], {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});

test("repeated id+requestId entries are counted once", () => {
  const duplicated = [
    '{"type":"assistant","requestId":"r","message":{"id":"m","model":"x","usage":{"input_tokens":7}}}',
    '{"type":"assistant","requestId":"r","message":{"id":"m","model":"x","usage":{"input_tokens":7}}}',
  ];
  assert.equal(aggregateTranscript(duplicated).models["x"]?.inputTokens, 7);
});

test("only unparseable non-empty lines are counted as skipped", () => {
  const result = aggregateTranscript(fixtureLines("transcript.jsonl"));
  assert.equal(result.skippedLines, 1);
});

test("non-assistant and blank lines neither skew totals nor count as skipped", () => {
  const result = aggregateTranscript([
    "",
    "   ",
    '{"type":"user","message":{"role":"user","content":"hi"}}',
    '{"type":"summary","summary":"x"}',
  ]);
  assert.deepEqual(result.models, {});
  assert.equal(result.skippedLines, 0);
});

test("missing cache fields default to zero rather than NaN", () => {
  const result = aggregateTranscript([
    '{"type":"assistant","requestId":"r","message":{"id":"m","model":"x","usage":{"input_tokens":1,"output_tokens":2}}}',
  ]);
  assert.deepEqual(result.models["x"], {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
});
