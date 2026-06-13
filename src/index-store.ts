import { readFileSync, statSync, readdirSync, type Dirent } from "node:fs";
import { join, basename, dirname } from "node:path";

import { aggregateTranscript, type ModelUsage } from "./aggregate.js";
import { cost, type PricingTable } from "./pricing.js";
import {
  openDb,
  getSession,
  allSessions,
  upsertSession,
  countSessionsByClassForMonth,
  countLiveSessionsByClass,
  monthClassSpendRows,
  type SessionRow,
} from "./db.js";

export type { ModelUsage };

export interface SessionRecord {
  path: string;
  sessionId: string;
  branch: string;
  modelClass: string;
  tokens: Record<string, ModelUsage>;
  costUsd: number;
  lastTs: number;
  byteOffset: number;
  // The parent session id when this record is a subagent transcript; undefined for
  // a top-level session (ADR-0001). Count/live tallies skip child records; spend
  // and sessionTotals roll them into the parent.
  parentSessionId?: string;
}

export interface CrossSessionIndex {
  sessions: Record<string, SessionRecord>;
  byMonth: Record<
    string,
    { tokens: Record<string, ModelUsage>; costUsd: number }
  >;
  byBranch: Record<
    string,
    { tokens: Record<string, ModelUsage>; costUsd: number }
  >;
  updatedAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function modelClass(modelId: string): string {
  for (const cls of ["opus", "sonnet", "haiku", "fable"] as const) {
    if (modelId.includes(cls)) return cls;
  }
  return modelId;
}

// The parent session id of a subagent transcript, read off its path: Claude Code
// writes subagent turns to <project>/<PARENT_SESSION_ID>/subagents/<file>.jsonl
// (ADR-0001), so the parent id is the directory two levels up. Returns undefined for
// a top-level transcript (anything not directly under a `subagents` directory). Pure
// — the path carries the link, so no file read is needed to attribute a child.
export function parentSessionIdOf(transcriptPath: string): string | undefined {
  const dir = dirname(transcriptPath);
  if (basename(dir) !== "subagents") return undefined;
  return basename(dirname(dir));
}

function emptyUsage(): ModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function addUsage(target: ModelUsage, source: ModelUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
}

function mergeTokens(
  dest: Record<string, ModelUsage>,
  src: Record<string, ModelUsage>,
): void {
  for (const [model, usage] of Object.entries(src)) {
    const existing = (dest[model] ??= emptyUsage());
    addUsage(existing, usage);
  }
}

export function foldLines(
  existing: SessionRecord | undefined,
  lines: Iterable<string>,
  seenKeys: Set<string>,
): Pick<
  SessionRecord,
  "branch" | "modelClass" | "tokens" | "costUsd" | "lastTs"
> {
  // seenKeys is per-file and persisted by the caller across incremental calls.
  // The byte offset advances past already-aggregated bytes, so re-reading old
  // data is impossible. Together these two invariants guarantee each assistant
  // line is counted exactly once regardless of how many incremental reads occur.

  let branch = existing?.branch ?? "";
  let lastTs = existing?.lastTs ?? 0;
  const tokens: Record<string, ModelUsage> = {};

  if (existing) {
    mergeTokens(tokens, existing.tokens);
  }

  const lineArray = Array.from(lines);

  // Extract timestamp and gitBranch per line; aggregateTranscript discards both.
  for (const raw of lineArray) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const root = asRecord(parsed);
    if (!root) continue;

    if (typeof root.timestamp === "string") {
      const ts = Date.parse(root.timestamp);
      if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
    }
    if (typeof root.gitBranch === "string" && root.gitBranch !== "") {
      branch = root.gitBranch;
    }
  }

  // aggregateTranscript handles deduplication internally for a single pass.
  // For incremental correctness, the seenKeys set prevents double-counting
  // entries that may appear in both existing and new lines when a session
  // resumes — though byte-offset advancement makes this a belt-and-suspenders
  // guard rather than the primary mechanism.
  const filterLines = lineArray.filter((raw) => {
    const line = raw.trim();
    if (line === "") return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return true;
    }
    const root = asRecord(parsed);
    if (!root || root.type !== "assistant") return true;
    const message = asRecord(root.message);
    if (!message) return true;
    // Filter <synthetic> model — 0-cost quota messages that must never be counted.
    if (message.model === "<synthetic>") return false;
    const id = typeof message.id === "string" ? message.id : undefined;
    const requestId =
      typeof root.requestId === "string" ? root.requestId : undefined;
    if (id !== undefined && requestId !== undefined) {
      const key = `${id} ${requestId}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
    }
    return true;
  });

  const aggregated = aggregateTranscript(filterLines);
  mergeTokens(tokens, aggregated.models);

  const cls = Object.keys(tokens).reduce((best, modelId) => {
    const cls = modelClass(modelId);
    if (cls !== "unknown") return cls;
    return best;
  }, existing?.modelClass ?? "unknown");

  return { branch, modelClass: cls, tokens, costUsd: 0, lastTs };
}

export function discoverTranscriptPaths(claudeDir: string): string[] {
  const paths: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeDir, {
      withFileTypes: true,
      encoding: "utf8",
    })
      .filter((e) => e.isDirectory())
      .map((e) => join(claudeDir, e.name));
  } catch {
    return paths;
  }

  for (const dir of projectDirs) {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        paths.push(join(dir, entry.name));
      } else if (entry.isDirectory()) {
        // A session's subagent transcripts live one known level down, in
        // <session>/subagents/*.jsonl (ADR-0001). Descend into exactly that
        // directory — not a general recursive walk.
        for (const sub of subagentFilesIn(join(dir, entry.name))) {
          paths.push(sub);
        }
      }
    }
  }

  return paths;
}

// The subagent transcript files under one session directory, i.e. the
// <sessionDir>/subagents/*.jsonl set. Empty when there is no subagents/ dir.
function subagentFilesIn(sessionDir: string): string[] {
  const subagentsDir = join(sessionDir, "subagents");
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(subagentsDir, {
      withFileTypes: true,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(subagentsDir, e.name));
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    path: row.path,
    sessionId: row.sessionId,
    branch: row.branch,
    modelClass: row.modelClass,
    tokens: row.tokens,
    costUsd: row.costUsd,
    lastTs: row.lastTs,
    byteOffset: row.byteOffset,
    parentSessionId: row.parentSessionId ?? undefined,
  };
}

// Materialise the in-memory CrossSessionIndex the renderers/report consume from
// the SQLite rows. The month/branch rollups are folded from the rows here in JS
// rather than via GROUP BY, because the per-model token structure fleet/report
// need is opaque JSON in the store and cannot be summed in SQL; cost is folded
// alongside it in the same pass.
function materializeIndex(
  rows: SessionRow[],
  updatedAt: number,
): CrossSessionIndex {
  const sessions: Record<string, SessionRecord> = {};
  const byMonth: CrossSessionIndex["byMonth"] = {};
  const byBranch: CrossSessionIndex["byBranch"] = {};

  for (const row of rows) {
    sessions[row.sessionId] = rowToRecord(row);

    const month = row.month;
    const mo = (byMonth[month] ??= { tokens: {}, costUsd: 0 });
    mergeTokens(mo.tokens, row.tokens);
    mo.costUsd += row.costUsd;

    const br = (byBranch[row.branch] ??= { tokens: {}, costUsd: 0 });
    mergeTokens(br.tokens, row.tokens);
    br.costUsd += row.costUsd;
  }

  return { sessions, byMonth, byBranch, updatedAt };
}

function monthFor(lastTs: number): string {
  return lastTs > 0 ? new Date(lastTs).toISOString().slice(0, 7) : "unknown";
}

// Counts upserts performed by updateIndex, so the refresh-debounce invariant
// (a tick where no transcript grew performs zero writes) is directly
// assertable. Test-only signal; nothing in the render/report path reads it.
let upsertCount = 0;

export function upsertCountForTest(): number {
  return upsertCount;
}

export function resetUpsertCountForTest(): void {
  upsertCount = 0;
}

// Incrementally fold one transcript file into its store row. Reads only the bytes
// past the stored offset, advances to the last complete line, and persists with the
// single atomic upsert. The row key is the file basename (the session UUID for a
// top-level transcript), not the path — a session has one stable id across
// worktrees, so its offset and tokens live on one row wherever the file is found. A
// missing/unreadable file, or a chunk with no newline yet, is a no-op: nothing is
// written and the offset does not move. Returns true when a row was upserted — the
// debounce signal the read-only-tick invariant below rests on.
function upsertTranscript(
  db: ReturnType<typeof openDb>,
  transcriptPath: string,
  pricingTable: PricingTable,
): boolean {
  const sessionId = basename(transcriptPath, ".jsonl");
  const existingRow = getSession(db, sessionId);
  const existing: SessionRecord | undefined =
    existingRow === undefined ? undefined : rowToRecord(existingRow);
  const currentOffset = existing?.byteOffset ?? 0;

  let fileSize: number;
  try {
    fileSize = statSync(transcriptPath).size;
  } catch {
    return false;
  }

  if (fileSize <= currentOffset) return false;

  // Read the whole file as a buffer so we can slice by byte offset without
  // misinterpreting multibyte UTF-8 characters as character offsets.
  let fileBuf: Buffer;
  try {
    fileBuf = readFileSync(transcriptPath);
  } catch {
    return false;
  }

  const chunk = fileBuf.subarray(currentOffset).toString("utf8");

  // Newline-boundary safety: never fold a partial trailing line. Advance the byte
  // offset only to the position of the last \n in the chunk, so a line that was
  // mid-write when we read it is left intact for the next update.
  const lastNewline = chunk.lastIndexOf("\n");
  if (lastNewline === -1) return false;

  const safeChunk = chunk.slice(0, lastNewline + 1);
  const newOffset = currentOffset + Buffer.byteLength(safeChunk, "utf8");

  const lines = safeChunk.split("\n");

  const folded = foldLines(existing, lines, new Set<string>());

  const usageByModel = { models: folded.tokens, skippedLines: 0 };
  const costs = cost(usageByModel, pricingTable);

  upsertSession(db, {
    sessionId,
    path: transcriptPath,
    branch: folded.branch,
    modelClass: folded.modelClass,
    tokens: folded.tokens,
    costUsd: costs.totalUsd,
    lastTs: folded.lastTs,
    byteOffset: newOffset,
    month: monthFor(folded.lastTs),
    parentSessionId: parentSessionIdOf(transcriptPath) ?? null,
  });
  upsertCount += 1;
  return true;
}

export async function updateIndex(
  indexPath: string,
  claudeDir: string,
  pricingTable: PricingTable,
): Promise<CrossSessionIndex> {
  const db = openDb(indexPath);

  const transcripts = discoverTranscriptPaths(claudeDir);

  // Read-only tick invariant: the per-file `fileSize <= currentOffset` skip inside
  // upsertTranscript is the debounce — when the statusline re-runs on its idle
  // refreshInterval and no transcript has grown past its stored byte_offset, every
  // file is skipped, nothing reaches upsertSession, and the function returns the
  // rollups materialised purely from a read. Live counts stay correct because they
  // recompute from each row's stored last_ts against the current clock downstream,
  // so a session can age out of the liveness window with no new bytes and no write.
  for (const transcriptPath of transcripts) {
    upsertTranscript(db, transcriptPath, pricingTable);
  }

  const index = materializeIndex(allSessions(db), Date.now());
  db.close();
  return index;
}

// Event-driven write (ADR-0003): persist just one session from its transcript path,
// without the cross-project sweep updateIndex does. The Stop hook calls this so a
// session records itself on every turn-end even when no statusline is ticking for
// it; other sessions pick it up on their next refresh. Concurrency-safe — it is the
// same single atomic per-row upsert — and openDb creates the store on first write.
// It never materialises an index; the hook has no use for one.
export function updateSession(
  indexPath: string,
  transcriptPath: string,
  pricingTable: PricingTable,
): void {
  const db = openDb(indexPath);
  try {
    upsertTranscript(db, transcriptPath, pricingTable);
    // Fold this session's subagent transcripts too, so the Stop write credits the
    // parent's children on the same turn-end (ADR-0001/0003). They sit in a sibling
    // <session>/subagents/ dir derived from the main transcript path; each is its
    // own row, attributed to the parent via parentSessionIdOf.
    const sessionDir = join(
      dirname(transcriptPath),
      basename(transcriptPath, ".jsonl"),
    );
    for (const sub of subagentFilesIn(sessionDir)) {
      upsertTranscript(db, sub, pricingTable);
    }
  } finally {
    db.close();
  }
}

export async function readIndex(
  indexPath: string,
): Promise<CrossSessionIndex | null> {
  let rows: SessionRow[];
  try {
    const db = openDb(indexPath);
    rows = allSessions(db);
    db.close();
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
  return materializeIndex(rows, Date.now());
}

export function monthTotals(
  index: CrossSessionIndex,
  month: string,
): { tokens: Record<string, ModelUsage>; costUsd: number } {
  return index.byMonth[month] ?? { tokens: {}, costUsd: 0 };
}

export function branchTotals(
  index: CrossSessionIndex,
  branch: string,
): { tokens: Record<string, ModelUsage>; costUsd: number } {
  return index.byBranch[branch] ?? { tokens: {}, costUsd: 0 };
}

export function sumTokens(tokens: Record<string, ModelUsage>): number {
  let total = 0;
  for (const usage of Object.values(tokens)) {
    total +=
      usage.inputTokens +
      usage.outputTokens +
      usage.cacheReadTokens +
      usage.cacheCreationTokens;
  }
  return total;
}

// One session's stored token totals + cost, keyed by session_id (the PK the
// store rows on). transcriptPath is a secondary lookup against the non-PK path
// column, used only when sessionId is absent from the render payload — if both
// are present, sessionId wins and path is never queried. Returns undefined when
// no row matches (absence ≠ zero: the transcript may not be indexed yet this
// render).
export function sessionTotals(
  index: CrossSessionIndex,
  sessionId: string | undefined,
  transcriptPath: string | undefined,
): { tokens: Record<string, ModelUsage>; costUsd: number } | undefined {
  let owner: SessionRecord | undefined;
  if (sessionId !== undefined) {
    owner = index.sessions[sessionId];
  } else if (transcriptPath !== undefined) {
    owner = Object.values(index.sessions).find(
      (r) => r.path === transcriptPath,
    );
  }
  if (owner === undefined) return undefined;

  // Roll the session's subagents into its total (ADR-0002): a parent's spend
  // includes its children's tokens and cost. Returns a fresh merged object, never
  // the stored record's own token map.
  const tokens: Record<string, ModelUsage> = {};
  mergeTokens(tokens, owner.tokens);
  let costUsd = owner.costUsd;
  for (const rec of Object.values(index.sessions)) {
    if (rec.parentSessionId === owner.sessionId) {
      mergeTokens(tokens, rec.tokens);
      costUsd += rec.costUsd;
    }
  }
  return { tokens, costUsd };
}

// The YYYY-MM a timestamp falls in, matching the `month` column written by the
// store. fleet-render derives a session's month from its lastTs through this so
// the render-side month scope and the stored column never diverge.
export function monthOf(lastTs: number): string {
  return monthFor(lastTs);
}

export interface ClassCount {
  cls: string;
  count: number;
}

function sortClassCounts(counts: Map<string, number>): ClassCount[] {
  return Array.from(counts, ([cls, count]) => ({ cls, count })).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.cls.localeCompare(b.cls);
  });
}

// Sessions in the given calendar month, counted per model class in SQL plus the
// month grand total. This is the figure the roster anchor divides by — replacing
// the old all-time `Object.values(sessions).length` that rendered `1/1` on a
// fresh install. byClass is ordered count-desc then class name.
export function monthSessionCounts(
  indexPath: string,
  month: string,
): { byClass: ClassCount[]; total: number } {
  let counts: Map<string, number>;
  try {
    const db = openDb(indexPath);
    counts = countSessionsByClassForMonth(db, month);
    db.close();
  } catch {
    counts = new Map();
  }
  const byClass = sortClassCounts(counts);
  const total = byClass.reduce((sum, c) => sum + c.count, 0);
  return { byClass, total };
}

// Per-class count of sessions live right now (last_ts within windowMs of nowMs),
// ordered count-desc then class name. Independent of month scope by design.
export function liveSessionCounts(
  indexPath: string,
  nowMs: number,
  windowMs: number,
): ClassCount[] {
  let counts: Map<string, number>;
  try {
    const db = openDb(indexPath);
    counts = countLiveSessionsByClass(db, nowMs, windowMs);
    db.close();
  } catch {
    counts = new Map();
  }
  return sortClassCounts(counts);
}

export interface ClassSpend {
  tokens: number;
  costUsd: number;
}

export interface MonthSpend {
  byClass: Record<string, ClassSpend>;
  total: ClassSpend;
}

// Per-model-class token+cost spend for one calendar month, plus the month grand
// total summed from the same rows. The token total per class uses the shared
// sumTokens summation, matching every other token figure. The Σ total counts
// ALL classes for the month, including ones the statusline does not render
// individually. byClass is keyed by class; an absent class means no sessions of
// it this month (the renderer treats that as a meaningful zero, not a gap).
export function monthClassSpend(indexPath: string, month: string): MonthSpend {
  let byClass: Record<string, ClassSpend> = {};
  let total: ClassSpend = { tokens: 0, costUsd: 0 };
  try {
    const db = openDb(indexPath);
    const rows = monthClassSpendRows(db, month);
    db.close();
    for (const row of rows) {
      const tokens = sumTokens(row.tokens);
      const slice = (byClass[row.modelClass] ??= { tokens: 0, costUsd: 0 });
      slice.tokens += tokens;
      slice.costUsd += row.costUsd;
      total.tokens += tokens;
      total.costUsd += row.costUsd;
    }
  } catch {
    byClass = {};
    total = { tokens: 0, costUsd: 0 };
  }
  return { byClass, total };
}
