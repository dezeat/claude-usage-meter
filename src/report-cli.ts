import { homedir } from "node:os";
import { join } from "node:path";

import {
  updateIndex,
  readIndex,
  type CrossSessionIndex,
} from "./index-store.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { formatReport } from "./report.js";

const INDEX_PATH = join(homedir(), ".claude", "usage-meter", "index.db");
const CLAUDE_DIR = join(homedir(), ".claude", "projects");

function emptyIndex(): CrossSessionIndex {
  return { sessions: {}, byMonth: {}, byBranch: {}, updatedAt: 0 };
}

async function main(): Promise<void> {
  const index = await updateIndex(
    INDEX_PATH,
    CLAUDE_DIR,
    DEFAULT_PRICING,
  ).catch(async () => {
    return await readIndex(INDEX_PATH);
  });
  const color =
    process.env["NO_COLOR"] === undefined || process.env["NO_COLOR"] === "";
  process.stdout.write(
    formatReport(index ?? emptyIndex(), new Date(), color) + "\n",
  );
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
