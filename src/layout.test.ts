import { test } from "node:test";
import assert from "node:assert/strict";

import { visibleLength } from "./ansi.js";
import { assembleLine, type LineRow } from "./layout.js";

// A representative multi-row HUD input (color off so widths read directly).
function rows(): LineRow[] {
  return [
    [
      { text: "opus 4.8" },
      { text: "repo ⎇ main", reduced: "repo", priority: 4 },
    ],
    [
      { text: "ctx ▓░░ 24%" },
      { text: "5h ▓▓░ 52% ⟳ 2h", reduced: "5h ▓▓░ 52%", priority: 3 },
      { text: "7d ▓▓░ 68% ⟳ 2d", reduced: "7d ▓▓░ 68%", priority: 3 },
    ],
    [
      { text: "ses $3.45" },
      { text: "0% cached", priority: 5 },
      { text: "Σ $12.00 mo", priority: 1 },
    ],
    [
      { text: "3 Σ 7", priority: 2 },
      { text: "● opus 2 ● sonnet 1", reduced: "●3", priority: 6 },
    ],
  ];
}

test("the HUD folds rows into one line joined by a dim dot, dropping labels", () => {
  const out = assembleLine(rows(), Infinity, false);
  assert.ok(!out.includes("\n"), "one physical line");
  assert.ok(out.includes(" · "), "rows join with the dim dot");
  assert.ok(!out.includes("│"), "no box-drawing divider — dots only");
  assert.ok(!out.includes("current"), "no row labels");
  assert.ok(!out.includes("limits"), "no row labels");
  assert.ok(out.startsWith("opus 4.8"), "starts with the first cell");
});

test("a wide budget keeps every segment intact", () => {
  const out = assembleLine(rows(), 1000, false);
  assert.ok(out.includes("⟳ 2h"), "reset trail survives when it fits");
  assert.ok(out.includes("0% cached"), "cache cell survives");
  assert.ok(out.includes("Σ $12.00 mo"), "month ledger survives");
  assert.ok(out.includes("● opus 2"), "full roster survives");
});

for (const columns of [80, 60, 40, 20, 10, 3, 1]) {
  test(`the line never exceeds columns=${columns} (the never-wrap invariant)`, () => {
    assert.ok(visibleLength(assembleLine(rows(), columns, false)) <= columns);
    assert.ok(visibleLength(assembleLine(rows(), columns, true)) <= columns);
  });
}

test("the dim static month ledger sheds before the live reset trail (ADR-0007 order)", () => {
  // ADR-0007's drop order recedes the dim, static accumulators first; the
  // actionable reset countdown (a live "when am I unblocked" cue) outlives them.
  // A width that forces exactly the first drop (Σ ledger, DROP.LEDGER).
  const wide = visibleLength(assembleLine(rows(), Infinity, false));
  const out = assembleLine(rows(), wide - 1, false);
  assert.ok(!out.includes("Σ $12.00 mo"), "the dim month ledger sheds first");
  assert.ok(out.includes("⟳ 2h"), "the live reset trail outlives the ledger");
});

test("the roster collapses to a bare ●N count rather than vanishing", () => {
  // Narrow enough to shed through priority 6 but keep the load-bearing cells.
  const out = assembleLine(rows(), 30, false);
  assert.ok(!out.includes("● opus 2"), "the verbose roster is shed");
});

test("empty rows leave no dangling divider", () => {
  const withGaps: LineRow[] = [
    [{ text: "opus 4.8" }],
    [],
    [{ text: "" }],
    [{ text: "ses $1.00" }],
  ];
  const out = assembleLine(withGaps, Infinity, false);
  assert.equal(out, "opus 4.8 · ses $1.00");
  assert.ok(!out.includes("·  ·"), "no doubled divider from a gap");
});

test("a non-positive width is treated as no limit and never throws", () => {
  assert.doesNotThrow(() => assembleLine(rows(), 0, false));
  const zero = assembleLine(rows(), 0, false);
  const neg = assembleLine(rows(), -5, false);
  const wide = assembleLine(rows(), Infinity, false);
  assert.equal(zero, wide, "columns<=0 does not shed");
  assert.equal(neg, wide, "a negative width does not shed");
});

test("empty input yields an empty line without throwing", () => {
  assert.equal(assembleLine([], 40, false), "");
  assert.equal(assembleLine([[], []], 40, false), "");
});
