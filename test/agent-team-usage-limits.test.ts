import {
  buildDigest,
  shortDigest,
  collectDigestInput,
} from "../src/core/team/digest";
import {
  UsageLimits,
  memorySettings,
  parseCodexRateLimits,
  parseGenericRateLimit,
} from "../src/core/team/usage-limits";
import { codexSpec } from "../src/core/team/adapters";
import { emptyUsage } from "../src/core/team/usage";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import type {
  AdapterRunInput,
  AgentAdapter,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
type Script = (input: AdapterRunInput, n: number) => Partial<AdapterResult>;
function fake(id: TeamAgentId, script: Script, installed = true) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed }),
    async run(input) {
      calls.push(input);
      return {
        exitCode: 0,
        finalText: "",
        durationMs: 1,
        ...script(input, calls.length),
      };
    },
  };
  return { adapter, calls };
}
function setup(
  scripts: Record<"claude" | "codex" | "gemini", Script>,
  roles: Partial<Record<TeamRole, TeamAgentId>>,
  geminiInstalled = true,
) {
  const root = mkdtempSync(join(tmpdir(), "cobble-backup-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(
    work,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("T", "Build the landing page in `site/`", work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(team.id, role as TeamRole, agent);
  const claude = fake("claude", scripts.claude);
  const codex = fake("codex", scripts.codex);
  const gemini = fake("gemini", scripts.gemini, geminiInstalled);
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const limits = new UsageLimits(memorySettings(), () => clock);
  limits.setBudget("codex", { budgetTokens: 1000, windowHours: 1 });
  const handles: { fn: () => void; at: number; cleared: boolean }[] = [];
  const orchestrator = new TeamOrchestrator({
    limits,
    now: () => clock,
    timers: {
      set(fn, ms) {
        const h = { fn, at: clock + ms, cleared: false };
        handles.push(h);
        return h;
      },
      clear(h) {
        (h as (typeof handles)[number]).cleared = true;
      },
    },
    teamStore,
    adapters: {
      claude: claude.adapter,
      codex: codex.adapter,
      gemini: gemini.adapter,
    },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  return {
    limits,
    advance(ms: number) {
      clock += ms;
      for (const h of [...handles])
        if (!h.cleared && h.at <= clock) {
          h.cleared = true;
          h.fn();
        }
    },
    store,
    team,
    teamStore,
    orchestrator,
    claude: claude.calls,
    codex: codex.calls,
    gemini: gemini.calls,
    async cleanup() {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows locks */
      }
    },
  };
}

const usage = (tokens: number) => ({
  ...emptyUsage(),
  calls: 1,
  inputTokens: tokens,
});
test("Codex JSONL selects the last rate limit event and highest window, with reset variants", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  for (const place of [
    "top",
    "msg",
    "info",
    "msg.info",
    "payload",
    "payload.info",
  ]) {
    const rate_limits = {
      primary: {
        used_percent: 96,
        window_minutes: 300,
        resets_in_seconds: 3600,
      },
      secondary: {
        used_percent: 96,
        window_minutes: 10080,
        resets_at: now / 1000 + 7200,
      },
    };
    const event =
      place === "top"
        ? { rate_limits }
        : place === "msg"
          ? { msg: { rate_limits } }
          : place === "info"
            ? { info: { rate_limits } }
            : place === "msg.info"
              ? { msg: { info: { rate_limits } } }
              : place === "payload"
                ? { payload: { rate_limits } }
                : { payload: { info: { rate_limits } } };
    const stdout =
      JSON.stringify({ rate_limits: { primary: { used_percent: 99 } } }) +
      "\n" +
      JSON.stringify(event) +
      "\npartial";
    const parsed = codexSpec.parseRateLimit!(stdout, now)!;
    assert.deepEqual(parsed, {
      usedPercent: 96,
      windowMinutes: 300,
      resetsAt: new Date(now + 3600e3).toISOString(),
    });
    const limits = new UsageLimits(memorySettings(), () => now);
    assert.equal(
      limits.recordTurn("codex", { rateLimit: parsed }).source,
      "reported",
    );
  }
  for (const resets_at of [
    now / 1000 + 7200,
    new Date(now + 7200e3).toISOString(),
  ]) {
    assert.equal(
      parseCodexRateLimits(
        JSON.stringify({
          rate_limits: { secondary: { used_percent: 97, resets_at } },
        }),
        now,
      )?.resetsAt,
      new Date(now + 7200e3).toISOString(),
    );
  }
  assert.equal(
    parseGenericRateLimit('{"rate_limit_info":{"utilization":0.96}}', now)
      ?.usedPercent,
    96,
  );
});
const planner: Script = (_input, n) => ({
  finalText: actions({
    actions:
      n === 1
        ? [
            {
              type: "delegate",
              id: "T1",
              role: "researcher",
              title: "first",
              instructions: "first",
            },
            {
              type: "delegate",
              id: "T2",
              role: "researcher",
              title: "second",
              instructions: "second",
              dependsOn: ["T1"],
            },
            {
              type: "delegate",
              id: "T3",
              role: "reviewer",
              title: "other",
              instructions: "other",
              dependsOn: ["T1"],
            },
          ]
        : [{ type: "finish", summary: "ok" }],
  }),
});
function scenario() {
  return setup(
    {
      claude: planner,
      codex: () => ({ usage: usage(960), finalText: "done" }),
      gemini: () => ({ finalText: "done" }),
    },
    { planner: "claude", researcher: "codex", reviewer: "gemini" },
  );
}
test("estimated threshold leaves A queued while B runs, and reset resumes without an auto retry", async () => {
  const f = scenario();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    let snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(f.codex.length, 1);
    assert.equal(f.gemini.length, 1);
    assert.equal(snap.tasks.find((t) => t.id === "T2")?.state, "queued");
    assert.equal(snap.tasks.find((t) => t.id === "T3")?.state, "done");
    assert.equal(snap.run.state, "paused");
    assert.equal(snap.run.retryKind, "usage-threshold");
    assert.equal(snap.run.retryAt, f.limits.status("codex").resetsAt);
    const digest = collectDigestInput(
      f.teamStore,
      f.team,
      Date.parse("2026-01-01T00:00:00Z"),
      24,
      undefined,
      f.limits,
    );
    assert.equal(digest.usageStops?.length, 1);
    assert.match(
      buildDigest(digest),
      /AI usage: codex stopped at 96% \(estimated\), resets 2026-01-01T01:00:00.000Z/,
    );
    assert.match(shortDigest(digest), /AI stopped: codex\./);
    f.advance(3600e3);
    await f.orchestrator.idle(run.id);
    snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(f.codex.length, 2);
    assert.equal(snap.run.autoRetries ?? 0, 0);
    assert.equal(snap.run.retryKind, undefined);
    assert.ok(
      f.teamStore
        .chatMessages(run.id)
        .some((m) => m.text === "Auto-resumed after the usage threshold reset"),
    );
  } finally {
    await f.cleanup();
  }
});
test("threshold moves a queued task to a usable backup", async () => {
  const f = scenario();
  try {
    f.teamStore.setBackupAgent(f.team.id, "researcher", "gemini");
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const task = f.orchestrator
      .snapshot(run.id)!
      .tasks.find((t) => t.id === "T2")!;
    assert.equal(task.agent, "gemini");
    assert.equal(task.switchedFrom, "codex");
    assert.equal(task.state, "done");
    assert.equal(f.codex.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("stop notices are emitted once for repeated turns in one episode", async () => {
  const f = scenario();
  try {
    const notices: string[] = [];
    f.orchestrator.on("attention", (e) => {
      if (e.kind === "info") notices.push(e.message);
    });
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const { recordUsageTurn } = await import("../src/core/team/task-runner");
    const ctx = (
      f.orchestrator as unknown as {
        ctx: import("../src/core/team/orchestrator-context").OrchestratorContext;
      }
    ).ctx;
    await recordUsageTurn(
      ctx,
      f.teamStore.run(run.id)!,
      "codex",
      { exitCode: 0, finalText: "ok", durationMs: 1, usage: usage(10) },
      "researcher",
    );
    assert.equal(notices.filter((m) => m.includes("codex reached")).length, 1);
  } finally {
    await f.cleanup();
  }
});
test("observed rate limit learns a budget for later windows without stopping immediately", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const limits = new UsageLimits(memorySettings(), () => now);
  const failed = limits.recordTurn("codex", {
    usage: usage(1000),
    rateLimited: true,
    retryAfterMinutes: 60,
  });
  assert.equal(failed.stopped, false);
  assert.equal(failed.learnedBudgetTokens, 1000);
  now += 5 * 3600e3 + 1;
  assert.equal(limits.recordTurn("codex", { usage: usage(960) }).stopped, true);
});

test("reported samples expire and stop history and notice claims survive reload", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const start = now;
  const io = memorySettings();
  const limits = new UsageLimits(io, () => now);
  limits.setBudget("codex", { budgetTokens: 1000, windowHours: 1 });
  limits.recordTurn("codex", {
    rateLimit: {
      usedPercent: 96,
      resetsAt: new Date(now + 60000).toISOString(),
    },
  });
  assert.equal(limits.claimStopNotice("codex"), true);
  const reloaded = new UsageLimits(io, () => now);
  assert.equal(reloaded.claimStopNotice("codex"), false);
  now += 60000;
  assert.equal(reloaded.status("codex").source, "estimated");
  assert.equal(reloaded.status("codex").stopped, false);
  assert.equal(reloaded.stopsSince(start)[0].percent, 96);
  reloaded.recordTurn("codex", { usage: usage(960) });
  assert.equal(reloaded.claimStopNotice("codex"), true);
  assert.equal(reloaded.stopsSince(start).length, 2);
});
test("planner rate limit waits for the reported reset", async () => {
  const reset = "2026-01-01T02:00:00.000Z";
  const f = setup(
    {
      claude: () => ({
        rateLimited: true,
        exitCode: 1,
        rateLimit: { usedPercent: 10, resetsAt: reset },
      }),
      codex: () => ({}),
      gemini: () => ({}),
    },
    { planner: "claude", researcher: "codex" },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.retryAt, reset);
    assert.equal(f.teamStore.run(run.id)!.retryKind, undefined);
  } finally {
    await f.cleanup();
  }
});
test("planner threshold gate starts no planner turn until reset", async () => {
  const f = scenario();
  try {
    f.limits.recordTurn("claude", {
      rateLimit: { usedPercent: 96, resetsAt: "2026-01-01T01:00:00.000Z" },
    });
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    assert.equal(f.claude.length, 0);
    assert.equal(f.teamStore.run(run.id)!.retryKind, "usage-threshold");
    assert.equal(f.teamStore.run(run.id)!.plannerTurns, 0);
  } finally {
    await f.cleanup();
  }
});

// T3 CARD-RENDER TEST SECTION: T3 adds AiUsageCard rendering tests below.

test("AI usage card renders the shared usage fixture", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AiUsageCard } = await import("../src/renderer/team-usage");
  const { usageFixture } = await import("./fixtures/usage-view");
  const html = renderToStaticMarkup(
    React.createElement(AiUsageCard, {
      view: usageFixture,
      setStopAt() {},
    }),
  );
  assert.match(html, /AI usage/);
  assert.equal(
    (html.match(/role="progressbar"/g) ?? []).length,
    usageFixture.agents.length,
  );
  for (const label of [
    "reported",
    "estimated",
    "stopped",
    "97%",
    "5h",
    "resets at",
  ])
    assert.ok(html.includes(label), label);
});

test("needs_human runs are not paused or resumed by a stopped queued agent", async () => {
  const f = scenario();
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const waiting = f.teamStore.run(run.id)!;
    waiting.state = "needs_human";
    waiting.retryAt = undefined;
    waiting.retryKind = undefined;
    f.teamStore.saveRun(waiting);
    await (
      f.orchestrator as unknown as { tick(id: string): Promise<void> }
    ).tick(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "needs_human");
    assert.equal(f.teamStore.run(run.id)!.retryAt, undefined);
    f.advance(3600e3);
    await f.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "needs_human");
    assert.equal(f.teamStore.run(run.id)!.retryAt, undefined);
  } finally {
    await f.cleanup();
  }
});

test("Codex countdown jitter keeps one attention notice and digest stop per episode", async () => {
  const f = scenario();
  try {
    const notices: string[] = [];
    f.orchestrator.on("attention", (e) => {
      if (e.kind === "info") notices.push(e.message);
    });
    const run = await f.orchestrator.startRun(f.team.id, "x");
    await f.orchestrator.idle(run.id);
    const initial = f.limits.status("codex");
    const { recordUsageTurn } = await import("../src/core/team/task-runner");
    const ctx = (
      f.orchestrator as unknown as {
        ctx: import("../src/core/team/orchestrator-context").OrchestratorContext;
      }
    ).ctx;
    for (const jitter of [1, -1, 2, 0]) {
      f.advance(1000);
      const now = Date.parse("2026-01-01T00:00:00Z");
      // Count down toward the original reset, with second-level CLI jitter.
      const elapsed = [1, -1, 2, 0].indexOf(jitter) + 1;
      const rateLimit = parseCodexRateLimits(
        JSON.stringify({
          payload: {
            rate_limits: {
              primary: {
                used_percent: 96,
                resets_in_seconds: 3600 - elapsed + jitter,
              },
            },
          },
        }),
        now + elapsed * 1000,
      )!;
      await recordUsageTurn(
        ctx,
        f.teamStore.run(run.id)!,
        "codex",
        {
          exitCode: 0,
          finalText: "ok",
          durationMs: 1,
          rateLimit,
        },
        "researcher",
      );
      const status = f.limits.status("codex");
      assert.equal(status.stoppedAt, initial.stoppedAt);
      assert.equal(status.resetsAt, initial.resetsAt);
      assert.equal(status.notifiedKey, `codex@${initial.stoppedAt}`);
    }
    assert.equal(notices.filter((m) => m.includes("codex reached")).length, 1);
    const digest = collectDigestInput(
      f.teamStore,
      f.team,
      Date.parse("2026-01-01T00:00:04Z"),
      24,
      undefined,
      f.limits,
    );
    assert.equal(
      (buildDigest(digest).match(/AI usage: codex/g) ?? []).length,
      1,
    );
  } finally {
    await f.cleanup();
  }
});

test("short digest keeps repeated usage stops within its 300 character cap", () => {
  const input = {
    teamName: "T",
    now: Date.parse("2026-01-01T00:00:00Z"),
    sinceHours: 24,
    runs: [],
    tasks: {},
    events: {},
    usageStops: [
      {
        agent: "codex" as const,
        source: "reported" as const,
        percent: 96,
        updatedAt: "2026-01-01T00:00:00Z",
        stopped: true,
      },
    ],
  };
  assert.match(shortDigest(input), / AI stopped: codex\./);
  const full = { ...input, usageStops: Array(100).fill(input.usageStops[0]) };
  const text = shortDigest(full);
  assert.ok(text.length <= 300);
  assert.equal((text.match(/AI stopped: codex\./g) ?? []).length, 1);
});

test("unchanged status reads avoid writes and old ledger and stop history are pruned", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const memory = memorySettings();
  const writes: string[] = [];
  const io = {
    setting: memory.setting,
    set(key: string, value: unknown) {
      writes.push(key);
      memory.set(key, value);
    },
  };
  const limits = new UsageLimits(io, () => now);
  limits.setBudget("codex", { budgetTokens: 1000, windowHours: 1 });
  limits.recordTurn("codex", { usage: usage(960) });
  limits.claimStopNotice("codex");
  limits.all(["codex", "claude"]);
  writes.length = 0;
  now += 1000;
  limits.status("codex");
  limits.all(["codex", "claude"]);
  assert.deepEqual(writes, []);
  now += 169 * 3600e3;
  limits.all(["codex", "claude"]);
  assert.deepEqual(memory.setting("agentUsageLedger", []), []);
  assert.deepEqual(limits.stopsSince(0), []);
  writes.length = 0;
  now += 1000;
  limits.all(["codex", "claude"]);
  assert.deepEqual(writes, []);
});

test("estimated usage without a budget hides percent, window and reset", () => {
  const limits = new UsageLimits(memorySettings(), () =>
    Date.parse("2026-01-01T00:00:00Z"),
  );
  limits.recordTurn("codex", { usage: usage(1000) });
  const service = Object.assign(Object.create(CobbleService.prototype), {
    limits,
  }) as CobbleService;
  const view = service
    .teamUsageLimits()
    .agents.find((agent) => agent.agent === "codex")!;
  assert.equal(view.source, "estimated");
  assert.equal(view.percent, null);
  assert.equal(view.windowHours, null);
  assert.equal(view.resetsAt, null);
});
