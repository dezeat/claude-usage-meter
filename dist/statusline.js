import { homedir } from "node:os";
import { join } from "node:path";
import { updateIndex } from "./index-store.js";
import { resolveLocation } from "./location.js";
import { parsePayload } from "./payload.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { PLACEHOLDER_LINE, renderLine } from "./render.js";
import { readStdin } from "./stdin.js";
const INDEX_PATH = join(homedir(), ".claude", "usage-meter", "index.db");
const CLAUDE_DIR = join(homedir(), ".claude", "projects");
// NO_COLOR convention: any non-empty value disables ANSI colour.
function colorEnabled() {
    const flag = process.env.NO_COLOR;
    return flag === undefined || flag === "";
}
async function main() {
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    const parsed = parsePayload(payload);
    const index = await updateIndex(INDEX_PATH, CLAUDE_DIR, DEFAULT_PRICING).catch(() => null);
    const line = renderLine(parsed, new Date(), {
        color: colorEnabled(),
        index,
        indexPath: INDEX_PATH,
        location: resolveLocation(parsed.cwd),
    });
    process.stdout.write(`${line}\n`);
}
// A statusline must never crash the bar: on any failure, still emit a line.
void main().catch(() => {
    process.stdout.write(`${PLACEHOLDER_LINE}\n`);
});
