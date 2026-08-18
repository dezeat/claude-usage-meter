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
  // Spread to a plain object: the accumulator is null-prototype by design (#156),
  // and deepEqual compares prototypes. The assertion is about the values.
  assert.deepEqual({ ...result.models }, {});
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

// A transcript is a user-writable file, so its strings reach the accumulator as
// keys. Object literals inherit `__proto__`/`constructor` from Object.prototype,
// which makes those keys collide rather than allocate. See #156.
test("a model id colliding with an Object prototype key is still counted", () => {
  for (const model of ["__proto__", "constructor", "toString"]) {
    const line = JSON.stringify({
      type: "assistant",
      requestId: "r1",
      message: {
        id: "m1",
        model,
        usage: { input_tokens: 5, output_tokens: 7 },
      },
    });

    const result = aggregateTranscript([line]);

    assert.deepEqual(
      result.models[model],
      {
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      `usage for a model named ${model} must be counted, not silently dropped`,
    );
  }
});

test("aggregating a transcript never mutates Object.prototype", () => {
  const line = JSON.stringify({
    type: "assistant",
    requestId: "r1",
    message: {
      id: "m1",
      model: "__proto__",
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  });

  aggregateTranscript([line]);

  assert.equal(
    Object.prototype.hasOwnProperty.call(Object.prototype, "inputTokens"),
    false,
    "the accumulator must not write token fields onto Object.prototype",
  );
});
