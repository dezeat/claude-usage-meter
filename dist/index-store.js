import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { aggregateTranscript } from "./aggregate.js";
import { sumUsage } from "./format.js";
import { cost } from "./pricing.js";
import { openDb, getSession, allSessions, upsertSession, upsertAccountLimit, getAccountLimit, getMeta, setMeta, countSessionsByClassForMonth, countLiveSessionsByClass, monthClassSpendRows, } from "./db.js";
import {} from "./payload.js";
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
// The parent session id of a subagent transcript, read off its path: Claude Code
// writes subagent turns to <project>/<PARENT_SESSION_ID>/subagents/<file>.jsonl
// (ADR-0001), so the parent id is the directory two levels up. Returns undefined for
// a top-level transcript (anything not directly under a `subagents` directory). Pure
// — the path carries the link, so no file read is needed to attribute a child.
export function parentSessionIdOf(transcriptPath) {
    const dir = dirname(transcriptPath);
    if (basename(dir) !== "subagents")
        return undefined;
    return basename(dirname(dir));
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
// The per-project directories under ~/.claude/projects. Split out from
// discoverTranscriptPaths so the hot path can stat these dirs for the H1 sweep
// watermark (Discussion #63) without also enumerating every transcript file.
function listProjectDirs(claudeDir) {
    try {
        return readdirSync(claudeDir, { withFileTypes: true, encoding: "utf8" })
            .filter((e) => e.isDirectory())
            .map((e) => join(claudeDir, e.name));
    }
    catch {
        return [];
    }
}
export function discoverTranscriptPaths(claudeDir) {
    return transcriptsIn(listProjectDirs(claudeDir));
}
function transcriptsIn(projectDirs) {
    const paths = [];
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
            else if (entry.isDirectory()) {
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
function subagentFilesIn(sessionDir) {
    const subagentsDir = join(sessionDir, "subagents");
    let entries;
    try {
        entries = readdirSync(subagentsDir, {
            withFileTypes: true,
            encoding: "utf8",
        });
    }
    catch {
        return [];
    }
    return entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => join(subagentsDir, e.name));
}
// The H1 sweep-debounce watermark key in the meta table (Discussion #63). Scoped
// by claudeDir: the watermark answers "has the structure under THIS root changed
// since I last swept it", so a shared DB observed against different roots keeps
// independent watermarks. In production claudeDir is the single ~/.claude/projects,
// so this is one stable key.
const SWEEP_WATERMARK_KEY_PREFIX = "sweep_dir_mtime_ns:";
// The largest directory mtime across the given dirs, in nanoseconds. A directory's
// mtime bumps when an entry is added/removed/renamed — i.e. when a *new* transcript
// (or project) appears — but NOT on an in-place append to an existing file (verified
// on the maintainer's btrfs). So this is a structural-change signal, not a growth
// signal: it is exactly what tells the sweep whether a new session showed up since
// last tick. Nanosecond resolution avoids same-millisecond false negatives between
// fast successive changes. A vanished/unreadable dir simply does not contribute.
function maxDirMtimeNs(dirs) {
    let max = 0n;
    for (const dir of dirs) {
        try {
            const ns = statSync(dir, { bigint: true }).mtimeNs;
            if (ns > max)
                max = ns;
        }
        catch {
            // A dir we cannot stat contributes nothing; the sweep still runs on any
            // other change, and the active session is folded regardless.
        }
    }
    return max;
}
// Fold just the active session's own transcript (and its subagents) on a quiet
// tick, so the session the statusline belongs to is always fresh even when the
// cross-project sweep is debounced away (Discussion #63, H1). In-place appends to
// this transcript are invisible to the dir-mtime watermark, so it is folded
// directly here every tick — cheap: one stat + at most this session's subagents.
function updateActiveSession(db, activeTranscriptPath, pricingTable) {
    upsertTranscript(db, activeTranscriptPath, pricingTable);
    const sessionDir = join(dirname(activeTranscriptPath), basename(activeTranscriptPath, ".jsonl"));
    for (const sub of subagentFilesIn(sessionDir)) {
        upsertTranscript(db, sub, pricingTable);
    }
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
        parentSessionId: row.parentSessionId ?? undefined,
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
// Incrementally fold one transcript file into its store row. Reads only the bytes
// past the stored offset, advances to the last complete line, and persists with the
// single atomic upsert. The row key is the file basename (the session UUID for a
// top-level transcript), not the path — a session has one stable id across
// worktrees, so its offset and tokens live on one row wherever the file is found. A
// missing/unreadable file, or a chunk with no newline yet, is a no-op: nothing is
// written and the offset does not move. Returns true when a row was upserted — the
// debounce signal the read-only-tick invariant below rests on.
function upsertTranscript(db, transcriptPath, pricingTable) {
    const sessionId = basename(transcriptPath, ".jsonl");
    const existingRow = getSession(db, sessionId);
    const existing = existingRow === undefined ? undefined : rowToRecord(existingRow);
    const currentOffset = existing?.byteOffset ?? 0;
    let fileSize;
    try {
        fileSize = statSync(transcriptPath).size;
    }
    catch {
        return false;
    }
    if (fileSize <= currentOffset)
        return false;
    // Read the whole file as a buffer so we can slice by byte offset without
    // misinterpreting multibyte UTF-8 characters as character offsets.
    let fileBuf;
    try {
        fileBuf = readFileSync(transcriptPath);
    }
    catch {
        return false;
    }
    const chunk = fileBuf.subarray(currentOffset).toString("utf8");
    // Newline-boundary safety: never fold a partial trailing line. Advance the byte
    // offset only to the position of the last \n in the chunk, so a line that was
    // mid-write when we read it is left intact for the next update.
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline === -1)
        return false;
    const safeChunk = chunk.slice(0, lastNewline + 1);
    const newOffset = currentOffset + Buffer.byteLength(safeChunk, "utf8");
    const lines = safeChunk.split("\n");
    const folded = foldLines(existing, lines, new Set());
    // Persisted cost source (ADR-0004): the pricing-table calc over aggregated
    // tokens is authoritative for everything stored — cross-session, month, Σ,
    // report. The payload's cost.total_cost_usd is used only for the live,
    // not-yet-indexed session, never for a persisted row.
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
// Persist this session's 5h/7d observation (monotonic LWW, see upsertAccountLimit)
// and read back the freshest stored window per kind, degrading to this render's
// own payload window when the store has never seen it. Rides the already-open db
// handle so the hot path adds one conditional upsert + one SELECT per window. Each
// store touch is wrapped so a locked/absent row degrades to the local payload —
// the never-throw safety net (Discussion #63, Part 1).
function resolveLimits(db, observation) {
    const resolve = (kind, local) => {
        if (local !== undefined) {
            try {
                upsertAccountLimit(db, {
                    kind,
                    usedPercentage: local.usedPercentage,
                    resetsAt: local.resetsAt,
                    observedAt: observation.observedAt,
                });
            }
            catch {
                // A locked store must never blank the bar; the local payload still renders.
            }
        }
        let stored;
        try {
            stored = getAccountLimit(db, kind);
        }
        catch {
            stored = undefined;
        }
        if (stored === undefined)
            return local;
        return { usedPercentage: stored.usedPercentage, resetsAt: stored.resetsAt };
    };
    return {
        fiveHour: resolve("five_hour", observation.fiveHour),
        sevenDay: resolve("seven_day", observation.sevenDay),
    };
}
export async function updateIndex(indexPath, claudeDir, pricingTable, observation, activeTranscriptPath) {
    const db = openDb(indexPath);
    // H1 sweep debounce (Discussion #63). The full cross-project sweep is O(all
    // transcripts) of stat + SQL on every refreshInterval tick, almost always to
    // discover nothing new appeared. Gate it behind a structural-change signal —
    // the max project-dir mtime — so an idle tick costs O(project dirs), not O(all
    // transcripts). The active session is folded unconditionally below, so the
    // session the statusline belongs to is never staleness-frozen by the debounce;
    // another session's in-place growth is picked up by its own Stop-hook write
    // (ADR-0003) and by the next sweep a structural change triggers.
    const projectDirs = listProjectDirs(claudeDir);
    const currentMtimeNs = maxDirMtimeNs([claudeDir, ...projectDirs]);
    const watermarkKey = SWEEP_WATERMARK_KEY_PREFIX + claudeDir;
    const storedWatermark = getMeta(db, watermarkKey);
    // Equality, not `>`: any change to the max — a new file raising it OR a deletion
    // lowering it — re-sweeps and re-stamps, so a watermark left high by a deletion
    // can never wedge the debounce permanently shut. A first-ever tick (no stored
    // value) always sweeps.
    const structuralChange = storedWatermark === undefined || currentMtimeNs !== BigInt(storedWatermark);
    if (structuralChange) {
        // Read-only tick invariant still holds inside the sweep: the per-file
        // `fileSize <= currentOffset` skip in upsertTranscript means a sweep where no
        // file actually grew performs zero upserts. The watermark write is the only
        // structural-tick cost; a quiet tick skips even that.
        for (const transcriptPath of transcriptsIn(projectDirs)) {
            upsertTranscript(db, transcriptPath, pricingTable);
        }
        setMeta(db, watermarkKey, String(currentMtimeNs));
    }
    else if (activeTranscriptPath !== undefined) {
        updateActiveSession(db, activeTranscriptPath, pricingTable);
    }
    const limits = observation === undefined ? undefined : resolveLimits(db, observation);
    const index = materializeIndex(allSessions(db), Date.now());
    if (limits !== undefined)
        index.limits = limits;
    db.close();
    return index;
}
// Event-driven write (ADR-0003): persist just one session from its transcript path,
// without the cross-project sweep updateIndex does. The Stop hook calls this so a
// session records itself on every turn-end even when no statusline is ticking for
// it; other sessions pick it up on their next refresh. Concurrency-safe — it is the
// same single atomic per-row upsert — and openDb creates the store on first write.
// It never materialises an index; the hook has no use for one.
export function updateSession(indexPath, transcriptPath, pricingTable) {
    const db = openDb(indexPath);
    try {
        upsertTranscript(db, transcriptPath, pricingTable);
        // Fold this session's subagent transcripts too, so the Stop write credits the
        // parent's children on the same turn-end (ADR-0001/0003). They sit in a sibling
        // <session>/subagents/ dir derived from the main transcript path; each is its
        // own row, attributed to the parent via parentSessionIdOf.
        const sessionDir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"));
        for (const sub of subagentFilesIn(sessionDir)) {
            upsertTranscript(db, sub, pricingTable);
        }
    }
    finally {
        db.close();
    }
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
    let owner;
    if (sessionId !== undefined) {
        owner = index.sessions[sessionId];
    }
    else if (transcriptPath !== undefined) {
        owner = Object.values(index.sessions).find((r) => r.path === transcriptPath);
    }
    if (owner === undefined)
        return undefined;
    // Roll the session's subagents into its total (ADR-0002): a parent's spend
    // includes its children's tokens and cost. Returns a fresh merged object, never
    // the stored record's own token map.
    const tokens = {};
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
// total summed from the same rows. Each slice keeps the four-way ModelUsage sum
// (not a flattened count) so the renderer can split the trail per ADR-0005. The
// Σ total counts ALL classes for the month, including ones the statusline does
// not render individually. byClass is keyed by class; an absent class means no
// sessions of it this month (the renderer treats that as a meaningful zero, not
// a gap).
export function monthClassSpend(indexPath, month) {
    let byClass = {};
    let total = { tokens: emptyUsage(), costUsd: 0 };
    try {
        const db = openDb(indexPath);
        const rows = monthClassSpendRows(db, month);
        db.close();
        for (const row of rows) {
            const usage = sumUsage(row.tokens);
            const slice = (byClass[row.modelClass] ??= {
                tokens: emptyUsage(),
                costUsd: 0,
            });
            addUsage(slice.tokens, usage);
            slice.costUsd += row.costUsd;
            addUsage(total.tokens, usage);
            total.costUsd += row.costUsd;
        }
    }
    catch {
        byClass = {};
        total = { tokens: emptyUsage(), costUsd: 0 };
    }
    return { byClass, total };
}
