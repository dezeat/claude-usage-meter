import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { aggregateTranscript } from "./aggregate.js";
import { cost } from "./pricing.js";
import { openDb, getSession, allSessions, upsertSession, countSessionsByClassForMonth, countLiveSessionsByClass, monthClassSpendRows, } from "./db.js";
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
export function modelClass(modelId) {
    for (const cls of ["opus", "sonnet", "haiku", "fable"]) {
        if (modelId.includes(cls))
            return cls;
    }
    return modelId;
}
function emptyUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
    };
}
function addUsage(target, source) {
    target.inputTokens += source.inputTokens;
    target.outputTokens += source.outputTokens;
    target.cacheReadTokens += source.cacheReadTokens;
    target.cacheCreationTokens += source.cacheCreationTokens;
}
function mergeTokens(dest, src) {
    for (const [model, usage] of Object.entries(src)) {
        const existing = (dest[model] ??= emptyUsage());
        addUsage(existing, usage);
    }
}
export function foldLines(existing, lines, seenKeys) {
    // seenKeys is per-file and persisted by the caller across incremental calls.
    // The byte offset advances past already-aggregated bytes, so re-reading old
    // data is impossible. Together these two invariants guarantee each assistant
    // line is counted exactly once regardless of how many incremental reads occur.
    let branch = existing?.branch ?? "";
    let lastTs = existing?.lastTs ?? 0;
    const tokens = {};
    if (existing) {
        mergeTokens(tokens, existing.tokens);
    }
    const lineArray = Array.from(lines);
    // Extract timestamp and gitBranch per line; aggregateTranscript discards both.
    for (const raw of lineArray) {
        const line = raw.trim();
        if (line === "")
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const root = asRecord(parsed);
        if (!root)
            continue;
        if (typeof root.timestamp === "string") {
            const ts = Date.parse(root.timestamp);
            if (Number.isFinite(ts) && ts > lastTs)
                lastTs = ts;
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
        if (line === "")
            return false;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return true;
        }
        const root = asRecord(parsed);
        if (!root || root.type !== "assistant")
            return true;
        const message = asRecord(root.message);
        if (!message)
            return true;
        // Filter <synthetic> model — 0-cost quota messages that must never be counted.
        if (message.model === "<synthetic>")
            return false;
        const id = typeof message.id === "string" ? message.id : undefined;
        const requestId = typeof root.requestId === "string" ? root.requestId : undefined;
        if (id !== undefined && requestId !== undefined) {
            const key = `${id} ${requestId}`;
            if (seenKeys.has(key))
                return false;
            seenKeys.add(key);
        }
        return true;
    });
    const aggregated = aggregateTranscript(filterLines);
    mergeTokens(tokens, aggregated.models);
    const cls = Object.keys(tokens).reduce((best, modelId) => {
        const cls = modelClass(modelId);
        if (cls !== "unknown")
            return cls;
        return best;
    }, existing?.modelClass ?? "unknown");
    return { branch, modelClass: cls, tokens, costUsd: 0, lastTs };
}
export function discoverTranscriptPaths(claudeDir) {
    const paths = [];
    let projectDirs;
    try {
        projectDirs = readdirSync(claudeDir, {
            withFileTypes: true,
            encoding: "utf8",
        })
            .filter((e) => e.isDirectory() && e.name.includes("midnight-marble"))
            .map((e) => join(claudeDir, e.name));
    }
    catch {
        return paths;
    }
    for (const dir of projectDirs) {
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
        }
        catch {
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
function rowToRecord(row) {
    return {
        path: row.path,
        sessionId: row.sessionId,
        branch: row.branch,
        modelClass: row.modelClass,
        tokens: row.tokens,
        costUsd: row.costUsd,
        lastTs: row.lastTs,
        byteOffset: row.byteOffset,
    };
}
// Materialise the in-memory CrossSessionIndex the renderers/report consume from
// the SQLite rows. The month/branch rollups are folded from the rows here in JS
// rather than via GROUP BY, because the per-model token structure fleet/report
// need is opaque JSON in the store and cannot be summed in SQL; cost is folded
// alongside it in the same pass.
function materializeIndex(rows, updatedAt) {
    const sessions = {};
    const byMonth = {};
    const byBranch = {};
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
function monthFor(lastTs) {
    return lastTs > 0 ? new Date(lastTs).toISOString().slice(0, 7) : "unknown";
}
// Counts upserts performed by updateIndex, so the refresh-debounce invariant
// (a tick where no transcript grew performs zero writes) is directly
// assertable. Test-only signal; nothing in the render/report path reads it.
let upsertCount = 0;
export function upsertCountForTest() {
    return upsertCount;
}
export function resetUpsertCountForTest() {
    upsertCount = 0;
}
export async function updateIndex(indexPath, claudeDir, pricingTable) {
    const db = openDb(indexPath);
    const transcripts = discoverTranscriptPaths(claudeDir);
    // Read-only tick invariant: the per-file `fileSize <= currentOffset` skip
    // below is the debounce — when the statusline re-runs on its idle
    // refreshInterval and no transcript has grown past its stored byte_offset,
    // every file is skipped, no branch reaches upsertSession, and the function
    // returns the rollups materialised purely from a read. Live counts stay
    // correct because they recompute from each row's stored last_ts against the
    // current clock downstream, so a session can age out of the liveness window
    // with no new bytes and no write.
    for (const transcriptPath of transcripts) {
        // Row key is the session_id (transcript UUID), not the path: a session has
        // one stable id across worktrees, so its incremental byte_offset and tokens
        // live on one row regardless of where the file is discovered.
        const sessionId = basename(transcriptPath, ".jsonl");
        const existingRow = getSession(db, sessionId);
        const existing = existingRow === undefined ? undefined : rowToRecord(existingRow);
        const currentOffset = existing?.byteOffset ?? 0;
        let fileSize;
        try {
            fileSize = statSync(transcriptPath).size;
        }
        catch {
            continue;
        }
        if (fileSize <= currentOffset)
            continue;
        // Read the whole file as a buffer so we can slice by byte offset without
        // misinterpreting multibyte UTF-8 characters as character offsets.
        let fileBuf;
        try {
            fileBuf = readFileSync(transcriptPath);
        }
        catch {
            continue;
        }
        const chunk = fileBuf.subarray(currentOffset).toString("utf8");
        // Newline-boundary safety: never fold a partial trailing line. Advance the
        // byte offset only to the position of the last \n in the chunk, so a line
        // that was mid-write when we read it is left intact for the next update.
        const lastNewline = chunk.lastIndexOf("\n");
        if (lastNewline === -1)
            continue;
        const safeChunk = chunk.slice(0, lastNewline + 1);
        const newOffset = currentOffset + Buffer.byteLength(safeChunk, "utf8");
        const lines = safeChunk.split("\n");
        const seenKeys = new Set(existing
            ? Object.keys(existing.tokens)
                .map(() => "")
                .filter(() => false)
            : []);
        const folded = foldLines(existing, lines, seenKeys);
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
        });
        upsertCount += 1;
    }
    const index = materializeIndex(allSessions(db), Date.now());
    db.close();
    return index;
}
export async function readIndex(indexPath) {
    let rows;
    try {
        const db = openDb(indexPath);
        rows = allSessions(db);
        db.close();
    }
    catch {
        return null;
    }
    if (rows.length === 0)
        return null;
    return materializeIndex(rows, Date.now());
}
export function monthTotals(index, month) {
    return index.byMonth[month] ?? { tokens: {}, costUsd: 0 };
}
export function branchTotals(index, branch) {
    return index.byBranch[branch] ?? { tokens: {}, costUsd: 0 };
}
export function sumTokens(tokens) {
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
export function sessionTotals(index, sessionId, transcriptPath) {
    if (sessionId !== undefined) {
        const record = index.sessions[sessionId];
        return record === undefined
            ? undefined
            : { tokens: record.tokens, costUsd: record.costUsd };
    }
    if (transcriptPath !== undefined) {
        for (const record of Object.values(index.sessions)) {
            if (record.path === transcriptPath) {
                return { tokens: record.tokens, costUsd: record.costUsd };
            }
        }
    }
    return undefined;
}
// The YYYY-MM a timestamp falls in, matching the `month` column written by the
// store. fleet-render derives a session's month from its lastTs through this so
// the render-side month scope and the stored column never diverge.
export function monthOf(lastTs) {
    return monthFor(lastTs);
}
function sortClassCounts(counts) {
    return Array.from(counts, ([cls, count]) => ({ cls, count })).sort((a, b) => {
        if (b.count !== a.count)
            return b.count - a.count;
        return a.cls.localeCompare(b.cls);
    });
}
// Sessions in the given calendar month, counted per model class in SQL plus the
// month grand total. This is the figure the roster anchor divides by — replacing
// the old all-time `Object.values(sessions).length` that rendered `1/1` on a
// fresh install. byClass is ordered count-desc then class name.
export function monthSessionCounts(indexPath, month) {
    let counts;
    try {
        const db = openDb(indexPath);
        counts = countSessionsByClassForMonth(db, month);
        db.close();
    }
    catch {
        counts = new Map();
    }
    const byClass = sortClassCounts(counts);
    const total = byClass.reduce((sum, c) => sum + c.count, 0);
    return { byClass, total };
}
// Per-class count of sessions live right now (last_ts within windowMs of nowMs),
// ordered count-desc then class name. Independent of month scope by design.
export function liveSessionCounts(indexPath, nowMs, windowMs) {
    let counts;
    try {
        const db = openDb(indexPath);
        counts = countLiveSessionsByClass(db, nowMs, windowMs);
        db.close();
    }
    catch {
        counts = new Map();
    }
    return sortClassCounts(counts);
}
// Per-model-class token+cost spend for one calendar month, plus the month grand
// total summed from the same rows. The token total per class uses the shared
// sumTokens summation, matching every other token figure. The Σ total counts
// ALL classes for the month, including ones the statusline does not render
// individually. byClass is keyed by class; an absent class means no sessions of
// it this month (the renderer treats that as a meaningful zero, not a gap).
export function monthClassSpend(indexPath, month) {
    let byClass = {};
    let total = { tokens: 0, costUsd: 0 };
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
    }
    catch {
        byClass = {};
        total = { tokens: 0, costUsd: 0 };
    }
    return { byClass, total };
}
