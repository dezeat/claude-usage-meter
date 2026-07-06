import { ANSI, paint, visibleLength } from "./ansi.js";

// One painted field in the single-line HUD. `text` is its full form; `reduced`,
// when set, is a shorter painted form the shedder swaps in at `priority` instead
// of removing the whole cell (the roster's `● opus 1` → bare `●3`). A segment
// with no `priority` is load-bearing and never shed (the model, the repo name).
export interface LineSegment {
  text: string;
  reduced?: string;
  priority?: number;
}

// A row's cells, in visual order. Rows map 1:1 to the block layout's rows
// (current, limits, spend, fleet); the assembler drops the labels and the
// newlines and folds them into one line.
export type LineRow = LineSegment[];

interface WorkingSegment {
  current: string;
  reduced?: string;
  priority?: number;
  removed: boolean;
  spent: boolean;
}

// A cold-open guard: a non-positive or non-finite width is "no limit", so the
// HUD never sheds or truncates when COLUMNS is absent or nonsense.
function widthOf(columns: number): number {
  return Number.isFinite(columns) && columns > 0 ? columns : Infinity;
}

function joinRow(row: WorkingSegment[], color: boolean): string {
  const sep = ` ${paint("·", "dim", color)} `;
  return row
    .filter((s) => !s.removed && s.current !== "")
    .map((s) => s.current)
    .join(sep);
}

// Rows joined by the same dim middle-dot that separates fields within a row, so
// the HUD reads as one uniform dot-separated stream; empty rows contribute
// nothing so no divider dangles — the same anti-dangling rule within a row.
function joinAll(rows: WorkingSegment[][], color: boolean): string {
  const divider = ` ${paint("·", "dim", color)} `;
  return rows
    .map((r) => joinRow(r, color))
    .filter((r) => r !== "")
    .join(divider);
}

const ESC = String.fromCharCode(27);

// Hard cut to a visible width, copying SGR sequences (zero-width) verbatim and
// counting only printable characters, then appending an ellipsis. This is the
// final guard when even the load-bearing cells overflow, so the invariant
// visibleLength(result) <= width holds for every input. ESC is matched by code
// point, not a control-char regex (eslint no-control-regex).
function truncateVisible(text: string, width: number, color: boolean): string {
  const budget = Math.max(0, width - 1);
  let out = "";
  let visible = 0;
  for (let i = 0; i < text.length;) {
    if (text[i] === ESC) {
      let j = i + 1;
      while (j < text.length && text[j] !== "m") j++;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (visible >= budget) break;
    out += text[i];
    visible++;
    i++;
  }
  return `${out}…${color ? ANSI.reset : ""}`;
}

// Assemble the per-row cells into ONE never-wrapping line. Cells within a row
// and the rows themselves join with the same dim dot. When the line overruns
// `columns`, cells are shed in ascending `priority` (a reduce when the segment
// carries a `reduced` form, else a removal), recomputing after each priority
// level until it fits; a hard truncate is the final guard. The result always
// satisfies visibleLength(result) <= columns.
export function assembleLine(
  rows: LineRow[],
  columns: number,
  color: boolean,
): string {
  const width = widthOf(columns);
  const working: WorkingSegment[][] = rows.map((row) =>
    row.map((seg) => ({
      current: seg.text,
      reduced: seg.reduced,
      priority: seg.priority,
      removed: false,
      spent: false,
    })),
  );

  let line = joinAll(working, color);
  while (visibleLength(line) > width) {
    const shed = working
      .flat()
      .filter((s) => !s.removed && !s.spent && s.priority !== undefined);
    if (shed.length === 0) break;
    const lowest = Math.min(...shed.map((s) => s.priority ?? Infinity));
    for (const s of shed) {
      if (s.priority !== lowest) continue;
      if (s.reduced !== undefined) s.current = s.reduced;
      else s.removed = true;
      s.spent = true;
    }
    line = joinAll(working, color);
  }

  if (visibleLength(line) > width) return truncateVisible(line, width, color);
  return line;
}
