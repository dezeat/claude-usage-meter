import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ANSI, visibleLength } from "./ansi.js";
import { parsePayload } from "./payload.js";
import { PLACEHOLDER_LINE, renderLine } from "./render.js";
import { type CrossSessionIndex } from "./index-store.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

const promax = loadFixture("promax-payload.json") as {
  rate_limits: { five_hour: { resets_at: number } };
};
// Anchor "now" 2h before the 5-hour reset so the countdown is deterministic.
const fixtureNow = new Date(
  (promax.rate_limits.five_hour.resets_at - 2 * 3600) * 1000,
);

const NOW_MS = fixtureNow.getTime();
const MONTH = fixtureNow.toISOString().slice(0, 7);

// A populated in-memory index with one live opus session, so the spend/fleet
// rows have data to render. monthClassCounts/liveClassCounts read sessions; the
// monthly Σ spend reads the (empty) :memory: db path, which yields zeros — the
// row still renders, which is all these layout tests assert.
function populatedIndex(): CrossSessionIndex {
  return {
    sessions: {
      "fixture-session-0001": {
        path: "/tmp/usage-meter-fixture/session.jsonl",
        sessionId: "fixture-session-0001",
        branch: "main",
        modelClass: "opus",
        tokens: {
          "claude-opus-4-8": {
            inputTokens: 1_000_000,
            outputTokens: 200_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        costUsd: 3.45,
        lastTs: NOW_MS,
        byteOffset: 0,
      },
    },
    byMonth: { [MONTH]: { tokens: {}, costUsd: 3.45 } },
    byBranch: {},
    updatedAt: NOW_MS,
  };
}

function fullRender(color: boolean): string {
  return renderLine(parsePayload(promax), fixtureNow, {
    color,
    index: populatedIndex(),
    indexPath: ":memory:",
  });
}

test("placeholder is a non-empty single line", () => {
  assert.ok(PLACEHOLDER_LINE.length > 0);
  assert.ok(!PLACEHOLDER_LINE.includes("\n"));
});

test("a full payload + index renders four rows labelled current, limits, spend, fleet in order", () => {
  const rows = fullRender(false).split("\n");
  assert.equal(rows.length, 4);
  assert.match(rows[0] ?? "", /^current /);
  assert.match(rows[1] ?? "", /^limits /);
  assert.match(rows[2] ?? "", /^spend /);
  assert.match(rows[3] ?? "", /^fleet /);
});

test("the current row shows the lowercased model and, given a location, repo ⎇ branch", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "claude-usage-meter", branch: "main" },
  });
  const now = line.split("\n")[0] ?? "";
  assert.match(now, /^current {2}opus 4\.8 · claude-usage-meter ⎇ main$/);
});

test("the current row drops the branch glyph outside a repo, showing the dir basename", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "some-dir" },
  });
  const now = line.split("\n")[0] ?? "";
  assert.match(now, /^current {2}opus 4\.8 · some-dir$/);
  assert.ok(!now.includes("⎇"), "no branch glyph without a branch");
});

test("the current row appends a worktree cue after repo ⎇ branch when inside a worktree", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "claude-usage-meter", branch: "side", worktree: "wt-1" },
  });
  const now = line.split("\n")[0] ?? "";
  assert.match(
    now,
    /^current {2}opus 4\.8 · claude-usage-meter ⎇ side ⌂ wt-1$/,
  );
});

test("the worktree cue is painted dim and distinct from the branch glyph", () => {
  const now =
    renderLine(parsePayload(promax), fixtureNow, {
      color: true,
      location: { name: "repo", branch: "side", worktree: "wt-1" },
    }).split("\n")[0] ?? "";
  assert.ok(now.includes(`${ANSI.dim}⌂${ANSI.reset}`), "dim worktree glyph");
});

test("a location without a worktree renders the current row unchanged", () => {
  const withWorktree = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "repo", branch: "main" },
  });
  const now = withWorktree.split("\n")[0] ?? "";
  assert.match(now, /^current {2}opus 4\.8 · repo ⎇ main$/);
  assert.ok(!now.includes("⌂"), "no worktree glyph without a worktree");
});

test("the current row carries the location alone when the model is unknown", () => {
  const line = renderLine(parsePayload({}), fixtureNow, {
    color: false,
    location: { name: "claude-usage-meter", branch: "main" },
  });
  assert.match(
    line.split("\n")[0] ?? "",
    /^current {2}claude-usage-meter ⎇ main$/,
  );
});

test("with neither model nor location the current row is omitted", () => {
  const line = renderLine(
    parsePayload({ cost: { total_cost_usd: 1 } }),
    fixtureNow,
    { color: false },
  );
  assert.ok(!line.startsWith("current "), "no leading current row");
  assert.ok(!line.includes("\ncurrent "), "no current row anywhere");
});

test("the limits row starts with ctx — the model is no longer pinned here", () => {
  const limits = fullRender(false).split("\n")[1] ?? "";
  assert.match(limits, /^limits {3}ctx /);
  assert.ok(!/^limits {3}opus/.test(limits), "no model pin on the limits row");
  assert.match(limits, /ctx .* 24%/);
  assert.match(limits, /5h .* 52% ⟳ 2h/);
  assert.match(limits, /7d .* 68% ⟳ 2d \(\w{2} \d\d\.\d\d\)$/);
  // Only the 7d cell carries the absolute reset day — exactly one "(" in the row.
  assert.equal((limits.match(/\(/g) ?? []).length, 1, "only 7d shows a date");
});

test("resolved cross-session limits override the payload's own 5h/7d, while ctx stays from the payload", () => {
  const fiveResets = promax.rate_limits.five_hour.resets_at;
  // Same reset instant (so the 2h countdown is unchanged), fresher usage from
  // another session: the row must render 80%, not the payload's 52%.
  const limits =
    renderLine(parsePayload(promax), fixtureNow, {
      color: false,
      index: populatedIndex(),
      indexPath: ":memory:",
      limits: {
        fiveHour: { usedPercentage: 80, resetsAt: fiveResets },
        sevenDay: { usedPercentage: 90, resetsAt: fiveResets + 2 * 24 * 3600 },
      },
    }).split("\n")[1] ?? "";
  assert.match(limits, /ctx .* 24%/, "ctx is the per-session payload value");
  assert.match(limits, /5h .* 80% ⟳ 2h/, "5h shows the resolved 80%");
  assert.ok(!limits.includes("52%"), "the payload's stale 5h is not rendered");
  assert.match(limits, /7d .* 90%/, "7d shows the resolved 90%");
});

test("an absent resolved window falls back to the payload's own snapshot", () => {
  // limits resolves only 5h; 7d is undefined, so the payload's 68% must show.
  const limits =
    renderLine(parsePayload(promax), fixtureNow, {
      color: false,
      index: populatedIndex(),
      indexPath: ":memory:",
      limits: {
        fiveHour: {
          usedPercentage: 80,
          resetsAt: promax.rate_limits.five_hour.resets_at,
        },
      },
    }).split("\n")[1] ?? "";
  assert.match(limits, /5h .* 80%/, "resolved 5h wins");
  assert.match(limits, /7d .* 68%/, "absent 7d falls back to the payload");
});

test("the spend row leads with the live ses cost and burn, a cache% cell, then a dim Σ ledger", () => {
  const spend = fullRender(false).split("\n")[2] ?? "";
  // ses $3.45 with a 1380000ms duration burns 3.45/(1380000/3.6e6) = $9.00/hr.
  assert.match(spend, /ses \$3\.45 ↑\$9\.00\/hr/);
  // The session's 1.2M tokens carry zero cache reads → a 0% cache signal.
  assert.match(spend, /0% cached/);
  assert.match(spend, /Σ \$0\.00 mo/);
  assert.ok(!spend.includes("mdl "), "the per-class mdl cost cell is dropped");
  assert.ok(!spend.includes("i:"), "the raw token trail is dropped from ses");
});

test("the fleet row leads with the count Σ total — no mdl tag, no mo, no active word", () => {
  const fleet = fullRender(false).split("\n")[3] ?? "";
  assert.match(fleet, /^fleet {4}1 Σ 1/);
  assert.ok(!fleet.includes("mdl"), "the mdl self-tag is dropped");
  assert.ok(!fleet.includes("mo"), "the mo qualifier is dropped");
  assert.ok(!fleet.includes("/"), "the count cell uses ' Σ ', never a slash");
  assert.ok(!fleet.includes("active"), "the active word is dropped");
  // The current session is the only live opus → the roster cell is omitted.
  assert.ok(!fleet.includes("●"), "self-only live tally drops the roster cell");
});

test("multi-field rows join with a dot separator, none dangling", () => {
  const rows = fullRender(false).split("\n");
  // limits (ctx · 5h · 7d) and spend (ses · cache · Σ) carry separators; the
  // current row is a single model cell and the fleet row a single count cell.
  assert.ok((rows[1] ?? "").includes(" · "), "limits joins its fields");
  assert.ok((rows[2] ?? "").includes(" · "), "spend joins its fields");
  for (const row of rows) {
    assert.ok(!row.endsWith(" · "), "no trailing separator");
    assert.ok(!/^\S+ {2}· /.test(row), "no leading separator after the label");
  }
});

test("fewer limit fields mean fewer separators with no dangling dot", () => {
  const degraded = renderLine(
    parsePayload(loadFixture("no-rate-limits-payload.json")),
    fixtureNow,
    { color: false },
  );
  const limits = degraded.split("\n")[1] ?? "";
  // Only ctx remains (no pin, no 5h/7d) → no field separator at all.
  const separators = limits.split(" · ").length - 1;
  assert.equal(separators, 0, "ctx alone has no separator");
  assert.ok(!limits.endsWith(" · "));
});

test("the live session cost is painted brightWhite in the spend row", () => {
  const spend = fullRender(true).split("\n")[2] ?? "";
  assert.ok(
    spend.includes(`${ANSI.brightWhite}$3.45${ANSI.reset}`),
    "the session cost is bright",
  );
});

test("every bar colours by the flat rule for both context and the limit bars", () => {
  // ctx 24% green, 5h 52% yellow, 7d 68% yellow.
  const limits = fullRender(true).split("\n")[1] ?? "";
  assert.ok(limits.includes(ANSI.green), "ctx at 24% is green");
  assert.ok(limits.includes(ANSI.yellow), "5h/7d in the 51-70 band are yellow");
  assert.ok(!limits.includes(ANSI.red), "nothing is in the red band here");
});

test("the limit bars keep the │ pace marker without it driving cell colour", () => {
  const limits = fullRender(true).split("\n")[1] ?? "";
  assert.ok(limits.includes("│"), "the pace marker is present on 5h/7d");
});

test("without rate_limits the limits row omits 5h/7d and the render still succeeds", () => {
  const degraded = renderLine(
    parsePayload(loadFixture("no-rate-limits-payload.json")),
    fixtureNow,
    { color: false },
  );
  const limits = degraded.split("\n")[1] ?? "";
  assert.match(limits, /^limits /);
  assert.match(limits, /ctx .* 13%/);
  assert.ok(!limits.includes("5h"));
  assert.ok(!limits.includes("7d"));
});

test("with no index the fleet and spend-fleet segments are omitted", () => {
  const noIndex = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
  });
  assert.ok(!noIndex.includes("\nfleet"), "no fleet row without an index");
  // Without an index the spend row is the live ses cost (plus burn), never the
  // cache% or Σ figures, which are index-derived.
  assert.ok(!noIndex.includes("Σ"), "no Σ total without an index");
  assert.ok(!noIndex.includes("·1 mo"), "no fleet counts without an index");
});

test("an empty payload still renders a model fallback rather than throwing", () => {
  assert.doesNotThrow(() =>
    renderLine(parsePayload({}), fixtureNow, { color: false }),
  );
  assert.match(
    renderLine(parsePayload({}), fixtureNow, { color: false }),
    /Claude/,
  );
});

test("row labels pad to a common visible width with colour on and off", () => {
  // Plain rows: the label prefix is exactly the 7-wide gutter then a 2-space gap.
  for (const row of fullRender(false).split("\n")) {
    assert.equal(row.slice(0, 7).trimEnd().length <= 7, true);
    assert.equal(
      row.slice(7, 9),
      "  ",
      "a 2-space gap follows the 7-wide gutter",
    );
  }
  // Painted rows: stripping the non-printing SGR codes recovers the same
  // 7-wide visible gutter — padding must not count the escape bytes.
  for (const row of fullRender(true).split("\n")) {
    const label = row.slice(0, row.indexOf("\x1b[0m") + 4);
    assert.equal(
      visibleLength(label),
      7,
      "visible gutter width is 7 with colour on",
    );
  }
});

test("row labels are painted accent", () => {
  for (const row of fullRender(true).split("\n")) {
    assert.ok(
      row.startsWith(ANSI.accent),
      "each row opens with the accent label colour",
    );
  }
});

test("meters:pill renders the limit as a bracket chip with no bar glyphs, ctx included", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    meters: "pill",
    limits: {
      fiveHour: {
        usedPercentage: 85,
        resetsAt: promax.rate_limits.five_hour.resets_at,
      },
    },
  });
  const limits = line.split("\n")[1] ?? "";
  assert.match(
    limits,
    /5h \[85%\]/,
    "the pill is the bracket fallback under NO_COLOR",
  );
  assert.match(limits, /ctx \[24%\]/, "ctx becomes a pill too");
  assert.ok(!limits.includes("▓"), "no filled bar glyphs in pill mode");
  assert.ok(!limits.includes("░"), "no empty bar glyphs in pill mode");
  // The reset countdown is unchanged — it still trails the 5h/7d chips.
  assert.match(limits, /5h \[85%\] ⟳ 2h/, "the reset trail survives the pill");
});

test("meters:bar (default) leaves the limits row byte-for-byte unchanged", () => {
  const withDefault = fullRender(false).split("\n")[1];
  const explicitBar =
    renderLine(parsePayload(promax), fixtureNow, {
      color: false,
      meters: "bar",
      index: populatedIndex(),
      indexPath: ":memory:",
    }).split("\n")[1] ?? "";
  assert.equal(explicitBar, withDefault, "bar is the untouched default look");
  assert.ok(
    explicitBar.includes("▓"),
    "the bar glyphs are present in bar mode",
  );
});

test("layout:line collapses the four rows into one line starting with the model", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    layout: "line",
    index: populatedIndex(),
    indexPath: ":memory:",
    columns: 200,
  });
  assert.ok(!line.includes("\n"), "the HUD is a single physical line");
  assert.ok(line.includes(" · "), "rows join with the dim dot");
  assert.ok(line.startsWith("opus 4.8"), "the line starts with the model");
  assert.ok(!/\bcurrent\b/.test(line), "the HUD drops the row labels");
});

test("the default layout still renders the four labelled block rows", () => {
  const rows = fullRender(false).split("\n");
  assert.equal(rows.length, 4, "the block layout is the in-renderLine default");
  assert.match(rows[0] ?? "", /^current /);
});

for (const columns of [80, 60, 40, 20, 8]) {
  test(`layout:line never emits a line wider than columns=${columns}`, () => {
    const line = renderLine(parsePayload(promax), fixtureNow, {
      color: true,
      layout: "line",
      index: populatedIndex(),
      indexPath: ":memory:",
      columns,
    });
    assert.ok(!line.includes("\n"), "still a single line");
    assert.ok(
      visibleLength(line) <= columns,
      `visible width ${visibleLength(line)} exceeds ${columns}`,
    );
  });
}
