import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { AUTOPILOT_BRANCH } from "./autopilot";
import { CHECK_LIMITS, runCheck } from "./checks";
import { normalizePath, Worktrees } from "./worktrees";

const exec = promisify(execFile);
export const PROMOTE_PROTECTED = ["main", "master"] as const;
export interface PromoteSteps {
  typecheck: string;
  testAll: string;
  testFile: (file: string) => string;
  testDir: string;
  build: string;
  smoke: string;
}
export const DEFAULT_PROMOTE_STEPS: PromoteSteps = {
  typecheck: "npm run typecheck",
  testAll: "npx tsx --test test/*.test.ts",
  testFile: (file) => `npx tsx --test "${file}"`,
  testDir: "test",
  build: "npm run build",
  smoke: "npm run test:desktop",
};
export interface PromoteStepResult {
  name: "typecheck" | "tests" | "build" | "smoke";
  passed: boolean;
  output: string;
  retriedFiles?: string[];
  failedFiles?: string[];
}
export interface PromoteResult {
  status: "promoted" | "up_to_date" | "failed" | "refused";
  target: string;
  from?: string;
  to?: string;
  steps: PromoteStepResult[];
  message: string;
  cleanupError?: string;
  at: string;
}
export function validPromoteTarget(branch: string): string {
  const name = branch.trim().replace(/^(refs\/heads\/|heads\/)/, "");
  if (PROMOTE_PROTECTED.some((p) => p === name.toLowerCase()))
    throw new Error(`Cobble never promotes to ${name}`);
  if (name.toLowerCase() === AUTOPILOT_BRANCH)
    throw new Error("Cannot promote to the source branch");
  if (!/^[\w][\w./-]{0,200}$/.test(name) || name.includes(".."))
    throw new Error("Invalid promotion target branch");
  return name;
}
export async function promote(opts: {
  repo: string;
  worktreeRoot: string;
  source?: string;
  to?: string;
  smoke?: boolean;
  steps?: Partial<PromoteSteps>;
  git?: string;
  run?: (
    command: string,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<{ passed: boolean; output: string }>;
  signal?: AbortSignal;
}): Promise<PromoteResult> {
  const git = async (...args: string[]) => {
    const { stdout } = await exec(
      opts.git ?? "git",
      ["-C", opts.repo, ...args],
      {
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4_000_000,
      },
    );
    return stdout.trim();
  };
  const result: PromoteResult = {
    status: "refused",
    target: opts.to ?? "",
    steps: [],
    message: "",
    at: new Date().toISOString(),
  };
  const source = opts.source ?? AUTOPILOT_BRANCH;
  const steps = { ...DEFAULT_PROMOTE_STEPS, ...opts.steps };
  const worktrees = new Worktrees(opts.repo, opts.worktreeRoot, opts.git);
  let path: string | undefined;
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Error("Promotion aborted");
  };
  const run = async (command: string) => {
    checkAbort();
    const checked = await (
      opts.run ?? ((c, cwd, s) => runCheck(c, cwd, CHECK_LIMITS.timeoutMs, s))
    )(command, path!, opts.signal);
    checkAbort();
    return checked;
  };
  const checkout = async () => {
    let current = "";
    let inRepo = false;
    for (const line of (await git("worktree", "list", "--porcelain")).split(
      /\r?\n/,
    )) {
      if (line.startsWith("worktree ")) current = line.slice(9);
      if (line === `branch refs/heads/${result.target}`) {
        const worktreePath = normalizePath(
          await realpath(current).catch(() => current),
        );
        const repoPath = normalizePath(
          await realpath(opts.repo).catch(() => opts.repo),
        );
        if (worktreePath !== repoPath)
          throw new Error("Target is checked out in another worktree");
        inRepo = true;
      }
    }
    if (inRepo && (await git("status", "--porcelain")))
      throw new Error(
        "Workspace is dirty; promotion requires a clean workspace",
      );
    return inRepo;
  };
  try {
    const target =
      opts.to ??
      (await git("symbolic-ref", "--short", "HEAD").catch(() => {
        throw new Error(
          "Cannot promote from a detached workspace; choose a target branch",
        );
      }));
    result.target = validPromoteTarget(target);
    if (result.target === source.replace(/^(refs\/heads\/|heads\/)/, ""))
      throw new Error("Cannot promote to the source branch");
    await git("check-ref-format", "--branch", result.target);
    const sha = await git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${source}^{commit}`,
    );
    const old = await git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${result.target}^{commit}`,
    ).catch(() => {
      throw new Error(`Target branch ${result.target} does not exist`);
    });
    result.from = old;
    result.to = sha;
    await git("merge-base", "--is-ancestor", old, sha).catch(() => {
      throw new Error("Promotion is not a fast-forward");
    });
    if (old === sha) {
      result.status = "up_to_date";
      result.message = `${result.target} is up to date with ${source}`;
      return result;
    }
    await checkout();
    checkAbort();
    result.status = "failed";
    await mkdir(opts.worktreeRoot, { recursive: true });
    path = join(
      opts.worktreeRoot,
      `promote-${sha.slice(0, 8)}-${randomBytes(3).toString("hex")}`,
    );
    await git("worktree", "add", "--detach", path, sha);
    await worktrees.linkDependencies(path);
    for (const name of [
      "typecheck",
      "tests",
      "build",
      ...(opts.smoke ? ["smoke" as const] : []),
    ] as const) {
      const step: PromoteStepResult = {
        name,
        ...(await run(name === "tests" ? steps.testAll : steps[name])),
      };
      result.steps.push(step);
      if (name === "tests" && !step.passed) {
        step.retriedFiles = [];
        step.failedFiles = [];
        const outputs: string[] = [];
        const files = (
          await readdir(join(path, steps.testDir), { withFileTypes: true })
        )
          .filter((f) => f.isFile() && /\.test\.ts$/.test(f.name))
          .map((f) => join(steps.testDir, f.name).replaceAll("\\", "/"))
          .sort();
        for (const file of files) {
          if ((await run(steps.testFile(file))).passed) continue;
          const retry = await run(steps.testFile(file));
          if (retry.passed) step.retriedFiles.push(file);
          else {
            step.failedFiles.push(file);
            outputs.push(`== ${file} ==\n${retry.output}`);
          }
        }
        step.passed = files.length > 0 && step.failedFiles.length === 0;
        if (!step.passed)
          step.output = (
            outputs.length ? outputs.join("\n") : step.output
          ).slice(-2000);
      }
      if (!step.passed) {
        result.message = `Promotion of ${sha.slice(0, 7)} to ${result.target} failed: ${name}${step.failedFiles?.length ? ` (${step.failedFiles.join(", ")})` : ""}`;
        return result;
      }
    }
    checkAbort();
    const currentTarget = await git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      `refs/heads/${result.target}^{commit}`,
    ).catch(() => undefined);
    const isAncestor = currentTarget
      ? await git("merge-base", "--is-ancestor", currentTarget, sha).then(
          () => true,
          () => false,
        )
      : false;
    if (currentTarget !== old || !isAncestor) {
      result.status = "refused";
      result.message = "Target is no longer an ancestor of the tested commit";
      return result;
    }
    if (await checkout()) {
      if ((await git("rev-parse", "HEAD")) !== old)
        throw new Error("Workspace HEAD changed during promotion");
      await git("merge", "--ff-only", "--no-verify", sha);
    } else await git("update-ref", `refs/heads/${result.target}`, sha, old);
    result.status = "promoted";
    result.message = `Promoted ${source} ${sha.slice(0, 7)} to ${result.target}`;
  } catch (error) {
    if (opts.signal?.aborted) result.status = "failed";
    result.message = String(
      error instanceof Error ? error.message : error,
    ).replace(/[\r\n]+/g, " ");
  } finally {
    if (path) {
      const cleanupError = (error: unknown) => {
        result.cleanupError = [result.cleanupError, String(error)]
          .filter(Boolean)
          .join("; ");
      };
      try {
        await worktrees.unlinkDependencies(path).catch(cleanupError);
        const info = await lstat(join(path, "node_modules")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          },
        );
        if (info?.isSymbolicLink()) {
          cleanupError("Dependency link remains; worktree retained");
          await git("worktree", "prune");
        } else {
          await git("worktree", "remove", "--force", path).catch(async () => {
            await rm(path!, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 200,
            });
            await git("worktree", "prune");
          });
        }
      } catch (error) {
        cleanupError(error);
      }
    }
  }
  return result;
}
