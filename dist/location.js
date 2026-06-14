import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {} from "./render.js";
// Resolve the session's working location from the payload cwd — repo name and
// current branch — by reading `.git` off the filesystem. No subprocess, no
// network: this re-runs on the statusline refreshInterval, so it must be cheap
// and must never throw. Degrades in steps: outside a repo it returns the cwd
// basename with no branch; only an absent cwd yields undefined (no row at all).
export function resolveLocation(cwd) {
    if (cwd === undefined || cwd === "")
        return undefined;
    try {
        const repo = findRepo(cwd);
        if (repo === undefined)
            return { name: basename(cwd) };
        return { name: basename(repo.root), branch: readBranch(repo.gitDir) };
    }
    catch {
        return { name: basename(cwd) };
    }
}
// Walk parent dirs to the filesystem root looking for a `.git`. dirname("/") is
// "/" — its own fixpoint — which terminates the walk at the top.
function findRepo(start) {
    let dir = start;
    for (;;) {
        const dotGit = join(dir, ".git");
        // throwIfNoEntry:false → undefined on a missing path instead of an ENOENT
        // throw, so the common "no repo here, keep walking" case stays branch-free.
        const stat = statSync(dotGit, { throwIfNoEntry: false });
        if (stat?.isDirectory())
            return { root: dir, gitDir: dotGit };
        if (stat?.isFile()) {
            const gitDir = resolveGitdirFile(dotGit);
            if (gitDir !== undefined)
                return { root: dir, gitDir };
        }
        const parent = dirname(dir);
        if (parent === dir)
            return undefined;
        dir = parent;
    }
}
// A linked worktree's `.git` is a file `gitdir: <path>` pointing at the real git
// directory under the main repo's `.git/worktrees/<name>`, where HEAD lives.
function resolveGitdirFile(file) {
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(file, "utf8"));
    const target = match?.[1]?.trim();
    if (target === undefined || target === "")
        return undefined;
    return isAbsolute(target) ? target : join(dirname(file), target);
}
// HEAD is `ref: refs/heads/<branch>` on a branch, or a raw commit SHA when
// detached — in which case there is no branch to show. Any read error is
// swallowed so a resolvable repo still surfaces its name without a branch.
function readBranch(gitDir) {
    try {
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        return /^ref:\s+refs\/heads\/(.+)$/.exec(head)?.[1];
    }
    catch {
        return undefined;
    }
}
