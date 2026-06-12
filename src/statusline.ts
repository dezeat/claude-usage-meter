import { parsePayload } from "./payload.js";
import { PLACEHOLDER_LINE, renderLine } from "./render.js";
import { readStdin } from "./stdin.js";

// NO_COLOR convention: any non-empty value disables ANSI colour.
function colorEnabled(): boolean {
  const flag = process.env.NO_COLOR;
  return flag === undefined || flag === "";
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload: unknown = JSON.parse(raw);
  const line = renderLine(parsePayload(payload), new Date(), {
    color: colorEnabled(),
  });
  process.stdout.write(`${line}\n`);
}

// A statusline must never crash the bar: on any failure, still emit a line.
void main().catch(() => {
  process.stdout.write(`${PLACEHOLDER_LINE}\n`);
});
