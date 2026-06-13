import { readFileSync } from "node:fs";
import { aggregateTranscript } from "./aggregate.js";
import { cost, DEFAULT_PRICING } from "./pricing.js";
import { readStdin } from "./stdin.js";
import { renderSummary } from "./summary.js";
function transcriptPath(value) {
    if (typeof value !== "object" || value === null)
        return undefined;
    const path = value.transcript_path;
    return typeof path === "string" ? path : undefined;
}
async function main() {
    const raw = await readStdin();
    const path = transcriptPath(JSON.parse(raw));
    if (path === undefined)
        return;
    const usage = aggregateTranscript(readFileSync(path, "utf8").split("\n"));
    if (Object.keys(usage.models).length === 0)
        return;
    const costs = cost(usage, DEFAULT_PRICING);
    process.stdout.write(`${renderSummary(usage, costs, DEFAULT_PRICING)}\n`);
}
// A Stop hook must be fast and silent on failure — a broken summary must never
// block the session. Swallow everything and exit 0.
void main().catch(() => { });
