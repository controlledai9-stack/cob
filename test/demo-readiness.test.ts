import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { emptyUsage } from "../src/core/team/usage";
import type { AgentAdapter, AdapterResult } from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";
import { TeamChat } from "../src/renderer/team-chat";
import type { RunSnapshot } from "../src/shared/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const MINUTE = 60_000;
const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";

type Script = (n: number) => Partial<AdapterResult>;

/** A git workspace, a team and an orchestrator with scripted fake agents. */
function setup(
  scripts: Partial<Record<TeamAgentId, Script>>,
  roles: Partial<Record<TeamRole, TeamAgentId>>,
) {
  const root = mkdtempSync(join(tmpdir(), "cobble-readiness-"));
  const work = join(root, "work");
  mkdirSync(work);
  writeFileSync(join(work, "README.md"), "hi\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("T", "Build the landing page in `site/`", work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(team.id, role as TeamRole, agent);
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const calls: Record<string, number> = {};
  const adapters: Partial<Record<TeamAgentId, AgentAdapter>> = {};
  for (const id of ["claude", "codex", "gemini"] as TeamAgentId[])
    adapters[id] = {
      id,
      detect: async () => ({ agent: id, installed: true }),
      async run() {
        calls[id] = (calls[id] ?? 0) + 1;
        return {
          exitCode: 0,
          finalText: "",
          durationMs: 1,
          ...(scripts[id]?.(calls[id]!) ?? {}),
        };
      },
    };
  const handles: { fn: () => void; at: number; cleared: boolean; fired: boolean }[] = [];
  const options = {
    teamStore,
    adapters,
    worktreeRoot: join(root, "trees"),
    team: (id: string) => store.team(id),
    now: () => clock,
    timers: {
      set(fn: () => void, ms: number) {
        const handle = { fn, at: clock + ms, cleared: false, fired: false };
        handles.push(handle);
        return handle;
      },
      clear(handle: unknown) {
        (handle as (typeof handles)[number]).cleared = true;
      },
    },
  };
  const orchestrators = [new TeamOrchestrator(options)];
  return {
    team,
    teamStore,
    calls,
    options,
    get orchestrator() {
      return orchestrators[0]!;
    },
    another() {
      const next = new TeamOrchestrator(options);
      orchestrators.push(next);
      return next;
    },
    live: () => handles.filter((h) => !h.cleared && !h.fired),
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    advance(ms: number) {
      clock += ms;
      for (const h of [...handles])
        if (!h.cleared && !h.fired && h.at <= clock) {
          h.fired = true;
          h.fn();
        }
    },
    async cleanup() {
      for (const o of orchestrators) await o.close();
      store.db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows locks */
      }
    },
  };
}

const rateLimited: Script = () => ({
  rateLimited: true,
  exitCode: 1,
  finalText: "429 usage limit",
});

test("stop during an armed retry timer leaves no timer and no restart", async () => {
  const f = setup({ claude: rateLimited, codex: rateLimited }, { planner: "claude", coder: "codex" });
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", { maxPlannerTurns: 20 });
    await f.orchestrator.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "paused");
    assert.equal(f.live().length, 1, "a retry is armed");
    const before = f.total();
    f.orchestrator.stop(run.id);
    assert.equal(f.live().length, 0, "stop clears the timer");
    assert.equal(f.teamStore.run(run.id)!.retryAt, undefined);
    f.advance(3 * 60 * MINUTE);
    await f.orchestrator.idle(run.id);
    assert.equal(f.total(), before, "nothing restarts");
    assert.equal(f.teamStore.run(run.id)!.state, "stopped");
  } finally {
    await f.cleanup();
  }
});

test("pausing a run that waits to auto-resume cancels the retry", async () => {
  const f = setup({ claude: rateLimited, codex: rateLimited }, { planner: "claude", coder: "codex" });
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", { maxPlannerTurns: 20 });
    await f.orchestrator.idle(run.id);
    assert.ok(f.teamStore.run(run.id)!.retryAt);
    const before = f.total();
    f.orchestrator.pause(run.id);
    const paused = f.teamStore.run(run.id)!;
    assert.equal(paused.state, "paused");
    assert.equal(paused.retryAt, undefined);
    assert.match(paused.pausedReason!, /Paused by you/);
    assert.equal(f.live().length, 0);
    f.advance(3 * 60 * MINUTE);
    await f.orchestrator.idle(run.id);
    assert.equal(f.total(), before, "the cancelled retry never fires");
  } finally {
    await f.cleanup();
  }
});

test("resume after a spending-cap pause works when handed to the daemon", async () => {
  const usage = { ...emptyUsage(), calls: 1, costUsd: 0.5 };
  const f = setup(
    {
      claude: (n) => ({
        usage,
        finalText: actions({
          actions:
            n === 1
              ? [{ type: "delegate", id: "T1", role: "reviewer", title: "Review", instructions: "Review the plan" }]
              : [{ type: "finish", summary: "ok" }],
        }),
      }),
      codex: () => ({ usage, finalText: "ok" }),
    },
    { planner: "claude", reviewer: "codex" },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "x", { maxCostUsd: 1 });
    await f.orchestrator.idle(run.id);
    assert.match(f.teamStore.run(run.id)!.pausedReason!, /Spending cap reached/);
    // `team resume RUN --max-cost 5 --detach`: raise the cap, hand over, exit.
    f.orchestrator.setMaxCost(run.id, 5);
    f.orchestrator.handOff(run.id);
    await f.orchestrator.close();
    const daemon = f.another();
    // The terminal's lease runs out within a minute of it exiting.
    f.advance(MINUTE);
    assert.deepEqual(daemon.adoptHandoffs(), [run.id]);
    await daemon.idle(run.id);
    assert.equal(f.teamStore.run(run.id)!.state, "done");
  } finally {
    await f.cleanup();
  }
});

test("team --help lists pilot, daemon, runs, say and answer", () => {
  const help = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "team", "--help"],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  for (const command of ["team pilot", "team daemon", "team runs", "team say", "team answer"])
    assert.ok(help.includes(command), command);
});

test("Team Chat says why a run is paused and whether it resumes on its own", () => {
  const snapshot = (run: object) =>
    ({ run: { id: "r", goal: "Build", state: "paused", ...run }, tasks: [], decisions: [], events: [] }) as unknown as RunSnapshot;
  const render = (run: object) =>
    renderToStaticMarkup(
      React.createElement(TeamChat, {
        api: { teamChat: async () => [], sendTeamChat: async () => ({ runId: "r", started: false }) },
        snapshot: snapshot(run),
        pending: false,
        canStart: true,
        canChat: true,
        chatHint: "",
        startProposal: async () => {},
        startHint: "",
        start: async () => {},
        command: () => {},
        onChanged: () => {},
      }),
    );
  assert.match(
    render({ pausedReason: "Spending cap reached: $1.00 of $1.00" }),
    /Paused: Spending cap reached: \$1\.00 of \$1\.00\. Type continue/,
  );
  assert.match(
    render({ pausedReason: "Usage limit; retry 1 of 6 at 10:00", retryAt: "2026-01-01T10:00:00Z" }),
    /resumes on its own/,
  );
});
