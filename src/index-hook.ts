import { homedir } from "node:os";
import { join } from "node:path";

import { updateSession } from "./index-store.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { readStdin } from "./stdin.js";

const INDEX_PATH = join(homedir(), ".claude", "usage-meter", "index.db");

function transcriptPath(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const path = (value as Record<string, unknown>).transcript_path;
  return typeof path === "string" ? path : undefined;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const path = transcriptPath(JSON.parse(raw));
  if (path === undefined) return;
  updateSession(INDEX_PATH, path, DEFAULT_PRICING);
}

// A Stop hook persists this session's usage to the cross-session store on every
// turn-end (event-driven write, ADR-0003) so other sessions see it on their next
// refresh — but it must never block the session: swallow everything and exit 0.
void main().catch(() => {});
