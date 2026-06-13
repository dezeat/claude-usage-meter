import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { join, basename } from "node:path";

import { aggregateTranscript, type ModelUsage } from "./aggregate.js";
import { cost, type PricingTable } from "./pricing.js";

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
      .filter((e) => e.isDirectory() && e.name.includes("midnight-marble"))
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
      }
    }
  }

  return paths;
}

function emptyIndex(): CrossSessionIndex {
  return { sessions: {}, byMonth: {}, byBranch: {}, updatedAt: 0 };
}

function rebuildRollups(sessions: Record<string, SessionRecord>): {
  byMonth: CrossSessionIndex["byMonth"];
  byBranch: CrossSessionIndex["byBranch"];
} {
  const byMonth: CrossSessionIndex["byMonth"] = {};
  const byBranch: CrossSessionIndex["byBranch"] = {};

  for (const rec of Object.values(sessions)) {
    const month =
      rec.lastTs > 0
        ? new Date(rec.lastTs).toISOString().slice(0, 7)
        : "unknown";

    const mo = (byMonth[month] ??= { tokens: {}, costUsd: 0 });
    mergeTokens(mo.tokens, rec.tokens);
    mo.costUsd += rec.costUsd;

    const br = (byBranch[rec.branch] ??= { tokens: {}, costUsd: 0 });
    mergeTokens(br.tokens, rec.tokens);
    br.costUsd += rec.costUsd;
  }

  return { byMonth, byBranch };
}

export async function updateIndex(
  indexPath: string,
  claudeDir: string,
  pricingTable: PricingTable,
): Promise<CrossSessionIndex> {
  let index = await readIndex(indexPath);
  if (index === null) index = emptyIndex();

  const transcripts = discoverTranscriptPaths(claudeDir);

  for (const transcriptPath of transcripts) {
    const existing = index.sessions[transcriptPath];
    const currentOffset = existing?.byteOffset ?? 0;

    let fileSize: number;
    try {
      fileSize = statSync(transcriptPath).size;
    } catch {
      continue;
    }

    if (fileSize <= currentOffset) continue;

    // Read the whole file as a buffer so we can slice by byte offset without
    // misinterpreting multibyte UTF-8 characters as character offsets.
    let fileBuf: Buffer;
    try {
      fileBuf = readFileSync(transcriptPath);
    } catch {
      continue;
    }

    const chunk = fileBuf.subarray(currentOffset).toString("utf8");

    // Newline-boundary safety: never fold a partial trailing line. Advance the
    // byte offset only to the position of the last \n in the chunk, so a line
    // that was mid-write when we read it is left intact for the next update.
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline === -1) continue;

    const safeChunk = chunk.slice(0, lastNewline + 1);
    const newOffset = currentOffset + Buffer.byteLength(safeChunk, "utf8");

    const lines = safeChunk.split("\n");

    const seenKeys: Set<string> = new Set(
      existing
        ? Object.keys(existing.tokens)
            .map(() => "")
            .filter(() => false)
        : [],
    );

    const folded = foldLines(existing, lines, seenKeys);

    const usageByModel = { models: folded.tokens, skippedLines: 0 };
    const costs = cost(usageByModel, pricingTable);

    const sessionId = basename(transcriptPath, ".jsonl");

    const record: SessionRecord = {
      path: transcriptPath,
      sessionId,
      branch: folded.branch,
      modelClass: folded.modelClass,
      tokens: folded.tokens,
      costUsd: costs.totalUsd,
      lastTs: folded.lastTs,
      byteOffset: newOffset,
    };

    index.sessions[transcriptPath] = record;
  }

  const rollups = rebuildRollups(index.sessions);
  index.byMonth = rollups.byMonth;
  index.byBranch = rollups.byBranch;
  index.updatedAt = Date.now();

  const dir = indexPath.slice(0, indexPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");

  return index;
}

export async function readIndex(
  indexPath: string,
): Promise<CrossSessionIndex | null> {
  try {
    const raw = readFileSync(indexPath, "utf8");
    return JSON.parse(raw) as CrossSessionIndex;
  } catch {
    return null;
  }
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
