import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

async function files(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else if (entry.isFile()) result.push(path);
  }
  return result.toSorted((left, right) => left.localeCompare(right));
}

export async function compareDist(committed, built) {
  const committedFiles = await files(committed);
  const builtFiles = await files(built);
  if (committedFiles.join("\0") !== builtFiles.join("\0")) {
    throw new Error("committed dist file set is stale");
  }
  for (const path of committedFiles) {
    const [left, right] = await Promise.all([
      readFile(join(committed, path)),
      readFile(join(built, path)),
    ]);
    if (!left.equals(right))
      throw new Error(`committed dist is stale: ${path}`);
  }
}

export async function checkDist(root) {
  const temporary = await mkdtemp(join(tmpdir(), "claude-meter-dist-"));
  try {
    await execFileAsync(
      join(root, "node_modules/.bin/tsc"),
      ["-p", join(root, "tsconfig.json"), "--outDir", temporary],
      { cwd: root },
    );
    await compareDist(join(root, "dist"), temporary);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const ownPath = fileURLToPath(import.meta.url);
if (resolve(process.argv[1] ?? "") === ownPath) {
  const rootArg = process.argv.find((arg) => arg.startsWith("--root="));
  const root = rootArg ? resolve(rootArg.slice(7)) : resolve(".");
  checkDist(root).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
