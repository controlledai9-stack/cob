import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promote, validPromoteTarget } from "../src/core/team/promote";

const exec = promisify(execFile);

test("mixed-case main ref is protected", () => {
  assert.throws(() => validPromoteTarget("refs/heads/Main"), /never promotes/);
});

test("autopilot cannot be a promotion target", () => {
  assert.throws(() => validPromoteTarget("cobble/autopilot"), /source branch/);
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cobble-promote-"));
  const repo = join(root, "repo");
  const worktreeRoot = join(root, "worktrees");
  await mkdir(repo);
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", repo, ...args], { windowsHide: true })
    ).stdout.trim();
  t.after(async () => {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  });
  await git("init", "-b", "dev");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(repo, ".gitignore"), "node_modules\n");
  await mkdir(join(repo, "test"));
  await writeFile(join(repo, "test", "a.test.ts"), "// fake test\n");
  await writeFile(join(repo, "test", "b.test.ts"), "// fake test\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  const old = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "cobble/autopilot");
  await writeFile(join(repo, "change.txt"), "change\n");
  await git("add", ".");
  await git("commit", "-m", "change");
  const sha = await git("rev-parse", "HEAD");
  await git("checkout", "dev");
  await mkdir(join(repo, "node_modules"));
  await writeFile(join(repo, "node_modules", "marker.txt"), "keep");
  return { repo, worktreeRoot, git, old, sha };
}

test("diverged target is refused without checks or ref changes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "diverged.txt"), "target-only change\n");
  await f.git("add", ".");
  await f.git("commit", "-m", "diverge target");
  const before = await f.git("rev-parse", "dev");
  let checks = 0;
  const result = await promote({
    ...f,
    git: undefined,
    run: async () => {
      checks++;
      return { passed: true, output: "ok" };
    },
  });
  assert.equal(result.status, "refused");
  assert.match(result.message, /not a fast-forward/);
  assert.equal(checks, 0);
  assert.deepEqual(result.steps, []);
  assert.equal(await f.git("rev-parse", "dev"), before);
});

test("nonexistent target is refused with a clear message", async (t) => {
  const f = await fixture(t);
  let checks = 0;
  const result = await promote({
    ...f,
    git: undefined,
    to: "missing",
    run: async () => {
      checks++;
      return { passed: true, output: "ok" };
    },
  });
  assert.equal(result.status, "refused");
  assert.equal(result.message, "Target branch missing does not exist");
  assert.equal(checks, 0);
  assert.deepEqual(result.steps, []);
  assert.equal(await f.git("rev-parse", "dev"), f.old);
  await assert.rejects(f.git("show-ref", "--verify", "refs/heads/missing"));
});

test("green promotion fast-forwards dev and removes dependency link with target intact", async (t) => {
  const f = await fixture(t);
  const commands: string[] = [];
  let checkedPath = "";
  const result = await promote({
    ...f,
    git: undefined,
    smoke: true,
    run: async (command, cwd) => {
      commands.push(command);
      checkedPath = cwd;
      assert.equal(
        (await lstat(join(cwd, "node_modules"))).isSymbolicLink(),
        true,
      );
      assert.equal(
        await readFile(join(cwd, "node_modules", "marker.txt"), "utf8"),
        "keep",
      );
      return { passed: true, output: "ok" };
    },
  });
  assert.equal(result.status, "promoted", result.message);
  assert.equal(await f.git("rev-parse", "dev"), f.sha);
  assert.deepEqual(
    result.steps.map((s) => s.name),
    ["typecheck", "tests", "build", "smoke"],
  );
  assert.equal(commands.length, 4);
  assert.equal(result.cleanupError, undefined);
  await assert.rejects(lstat(checkedPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(f.worktreeRoot), []);
  assert.equal(
    await readFile(join(f.repo, "node_modules", "marker.txt"), "utf8"),
    "keep",
  );
});

test("red tests leave dev untouched and report the twice-failed file", async (t) => {
  const f = await fixture(t);
  const commands: string[] = [];
  const result = await promote({
    ...f,
    git: undefined,
    run: async (command) => {
      commands.push(command);
      return {
        passed: command.includes("typecheck") || command.includes("b.test.ts"),
        output: "failure evidence",
      };
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(await f.git("rev-parse", "dev"), f.old);
  assert.deepEqual(result.steps[1].failedFiles, ["test/a.test.ts"]);
  assert.match(
    result.steps[1].output,
    /== test\/a.test.ts ==\nfailure evidence/,
  );
  assert.match(result.message, /tests.*test\/a.test.ts/);
  assert.equal(
    commands.some((c) => c.includes("build")),
    false,
  );
});

test("protected main is refused without checks", async (t) => {
  const f = await fixture(t);
  const result = await promote({
    ...f,
    git: undefined,
    to: "refs/heads/main",
    run: async () => {
      throw new Error("unexpected check");
    },
  });
  assert.equal(result.status, "refused");
  assert.match(result.message, /never promotes to main/);
  assert.deepEqual(result.steps, []);
  assert.throws(() => validPromoteTarget("heads/MASTER"));
});

test("flaky file passes on retry and promotion succeeds", async (t) => {
  const f = await fixture(t);
  let attempts = 0;
  const result = await promote({
    ...f,
    git: undefined,
    run: async (command) => ({
      passed: command.includes("a.test.ts")
        ? ++attempts > 1
        : !command.includes("test/*.test.ts"),
      output: "fake",
    }),
  });
  assert.equal(result.status, "promoted", result.message);
  assert.equal(attempts, 2);
  assert.deepEqual(result.steps[1].retriedFiles, ["test/a.test.ts"]);
  assert.deepEqual(result.steps[1].failedFiles, []);
});

test("dirty workspace is refused before checks", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "dirty.txt"), "uncommitted");
  let checks = 0;
  const result = await promote({
    ...f,
    git: undefined,
    run: async () => {
      checks++;
      return { passed: true, output: "" };
    },
  });
  assert.equal(result.status, "refused");
  assert.match(result.message, /dirty/);
  assert.equal(checks, 0);
  assert.equal(await f.git("rev-parse", "dev"), f.old);
});

test("dependency link is removed after a failed check and workspace marker survives", async (t) => {
  const f = await fixture(t);
  let path = "";
  const result = await promote({
    ...f,
    git: undefined,
    run: async (_command, cwd) => {
      path = cwd;
      assert.equal(
        (await lstat(join(cwd, "node_modules"))).isSymbolicLink(),
        true,
      );
      return { passed: false, output: "typecheck failed" };
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.cleanupError, undefined);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal(
    await readFile(join(f.repo, "node_modules", "marker.txt"), "utf8"),
    "keep",
  );
  assert.equal(await f.git("rev-parse", "dev"), f.old);
});

// T3: service, digest and pilot wiring.
import { CobbleService } from "../src/core/service";
import {
  buildDigest,
  shortDigest,
  collectDigestInput,
} from "../src/core/team/digest";
import { runPilot, type PilotDeps } from "../src/core/team/pilot";

test("service reports green, red and refused promotions in chat, settings and digest", async (t) => {
  const f = await fixture(t);
  const service = new CobbleService(":memory:", undefined, {
    teamWorktreeRoot: f.worktreeRoot,
  });
  t.after(() => service.store.close());
  service.store.saveProfile("Owner", "");
  const team = service.store.createTeam("Promotion team", "Test", f.repo);
  service.store.set("activeTeamId", team.id);
  let events = 0;
  service.on("team", () => events++);
  const red = await service.promoteTeam({
    run: async () => ({ passed: false, output: "x".repeat(2000) }),
  });
  assert.equal(red.status, "failed");
  const chat = service.teamStore.projectChatMessages(team.id).at(-1)!;
  assert.equal(chat.author, "cobble");
  assert.match(chat.text, /typecheck/);
  assert.ok(chat.text.length < 1800);
  assert.equal(service.teamPromotions(team.id)[0].steps[0].output.length, 300);
  const green = await service.promoteTeam({
    run: async () => ({ passed: true, output: "ok" }),
  });
  assert.equal(green.status, "promoted", green.message);
  const refused = await service.promoteTeam({ to: "main" });
  assert.equal(refused.status, "refused");
  assert.equal(events, 3);
  const input = collectDigestInput(
    service.teamStore,
    team,
    Date.now(),
    24,
    service.teamPromotions(team.id),
  );
  assert.match(buildDigest(input), /## Promotions\n\n- ❌/);
  assert.match(buildDigest(input), /✅ Promoted/);
  assert.match(shortDigest(input), /Promotions: 1 ok, 2 failed\./);
  for (let i = 0; i < 21; i++) await service.promoteTeam({ to: "main" });
  assert.equal(service.teamPromotions(team.id).length, 20);
});

test("digest excludes promotions outside its window and shows None", () => {
  const input = {
    teamName: "Team",
    now: 100000000,
    sinceHours: 1,
    runs: [],
    tasks: {},
    events: {},
    promotions: [
      { status: "promoted", message: "old", at: new Date(0).toISOString() },
    ],
  };
  assert.match(buildDigest(input), /## Promotions\n\n- None\./);
  assert.doesNotMatch(shortDigest(input), /Promotions:/);
});

function promotionPilot() {
  let cycle = 0;
  let stopped = false;
  const notifications: string[] = [];
  const deps: PilotDeps = {
    now: () => 0,
    brief: () => ({
      days: 1,
      agents: [],
      priority: "tests",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
    planner: () => ({
      id: "codex",
      detect: async () => ({ agent: "codex", installed: true }),
      run: async () => ({
        exitCode: 0,
        durationMs: 0,
        finalText:
          "```cobble-pilot\n" +
          JSON.stringify({
            done: cycle >= 2,
            items: [
              {
                item: "Existing task",
                role: "coder",
                minutes: 1,
                label: "Test work",
              },
            ],
          }) +
          "\n```",
      }),
    }),
    cwd: "fake",
    roles: ["coder"],
    context: async () => ({ planText: "", digest: "", questions: [] }),
    readBacklog: async () => "- [ ] Existing task",
    addItems: async () => {},
    runItems: async () => {
      cycle++;
      return { stoppedReason: "empty" };
    },
    notify: async (message) => {
      notifications.push(message);
    },
    sendDigest: async () => {},
    spentUsd: () => 0,
    shouldStop: () => stopped,
  };
  return {
    deps,
    notifications,
    stop: () => {
      stopped = true;
    },
  };
}

test("pilot promotes each cycle and promotion errors do not stop it", async () => {
  const h = promotionPilot();
  let promotions = 0;
  h.deps.promote = async () => {
    promotions++;
    throw new Error("fake failure");
  };
  const result = await runPilot(h.deps);
  assert.equal(result.cycles, 2);
  assert.equal(result.stoppedReason, "nothing_left");
  assert.equal(promotions, 2);
  assert.equal(
    h.notifications.filter((m) => m === "Promotion failed: fake failure")
      .length,
    2,
  );
});

test("pilot skips promotion when stopped during runItems", async () => {
  const h = promotionPilot();
  h.deps.runItems = async () => {
    h.stop();
    return { stoppedReason: "stopped" };
  };
  h.deps.promote = async () => {
    assert.fail("must not promote after stop");
  };
  assert.equal((await runPilot(h.deps)).stoppedReason, "stopped");
});

import { spawnSync } from "node:child_process";

test("CLI promote accepts target and smoke, reports refusal with exit code 1", async (t) => {
  const f = await fixture(t);
  const data = join(f.worktreeRoot, "cli.sqlite");
  const service = new CobbleService(data);
  service.store.saveProfile("Owner", "");
  const team = service.store.createTeam("CLI team", "Test", f.repo);
  service.store.set("activeTeamId", team.id);
  service.store.close();
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "--data",
      data,
      "team",
      "promote",
      "--to",
      "main",
      "--smoke",
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /never promotes to main/);
  const help = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--help"],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /team promote \[--to BRANCH\] \[--smoke\]/);
});

test("service requires a workspace before promoting", async () => {
  const service = new CobbleService(":memory:");
  try {
    service.store.saveProfile("Owner", "");
    const team = service.store.createTeam("No workspace", "Test", "");
    await assert.rejects(
      service.promoteTeam({}, team.id),
      /Choose a team with a workspace first/,
    );
    assert.deepEqual(service.teamPromotions(team.id), []);
  } finally {
    service.store.close();
  }
});
