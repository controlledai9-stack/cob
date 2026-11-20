import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  TeamOrchestrator,
  LEASE_MS,
  RESTART_REASON,
} from "../src/core/team/orchestrator";
import { Autopilot } from "../src/core/team/autopilot";
import type { AgentAdapter } from "../src/core/team/adapters";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cobble-waiting-lease-"));
  const file = join(root, "team.sqlite");
  const a = new Store(file);
  a.saveProfile("Owner", "");
  const team = a.createTeam("Team", "Build locally", root);
  const store = new TeamStore(a);
  store.setRole(team.id, "planner", "claude");
  const b = new Store(file);
  const outside = new TeamStore(b);
  let now = Date.parse("2026-01-01T00:00:00Z");
  let calls = 0;
  let action: object = { type: "ask_user", questions: ["Which color?"] };
  const adapter: AgentAdapter = {
    id: "claude",
    detect: async () => ({ agent: "claude", installed: true }),
    run: async () => {
      calls++;
      return {
        exitCode: 0,
        durationMs: 1,
        finalText:
          "```cobble-actions\n" +
          JSON.stringify({ actions: [action] }) +
          "\n```",
      };
    },
  };
  const make = (teamStore: TeamStore, backing: Store) =>
    new TeamOrchestrator({
      teamStore,
      team: (id) => backing.team(id),
      worktreeRoot: join(root, "trees"),
      adapters: { claude: adapter },
      now: () => now,
    });
  const owner = make(store, a);
  const observer = make(outside, b);
  const seed = (id = "run", extra: Partial<TeamRun> = {}) => {
    const stamp = new Date(now).toISOString();
    const run: TeamRun = {
      id,
      teamId: team.id,
      goal: "Build locally",
      state: "paused",
      plannerTurns: 0,
      planVersion: 0,
      briefVersion: 0,
      budget: { ...DEFAULT_BUDGET },
      policy: { ...DEFAULT_POLICY },
      baseBranch: "main",
      runBranch: "run",
      approvals: [],
      invalidPlannerReplies: 0,
      pendingNotes: [],
      wakeRequested: true,
      workspace: root,
      createdAt: stamp,
      updatedAt: stamp,
      ...extra,
    };
    store.saveRun(run);
    return run;
  };
  const task = (runId: string, state: TeamTask["state"] = "needs_human") => {
    const task: TeamTask = {
      id: "T1",
      runId,
      role: "coder",
      agent: "codex",
      title: "Needs login",
      instructions: "Wait for local login",
      acceptance: [],
      dependsOn: [],
      state,
      attempt: 1,
      createdAt: new Date(now).toISOString(),
      gate: { kind: "login", message: "Sign in locally" },
    };
    store.saveTask(task);
    return task;
  };
  return {
    root,
    team,
    store,
    outside,
    owner,
    observer,
    seed,
    task,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    calls: () => calls,
    action: (next: object) => {
      action = next;
    },
    async close() {
      await owner.close();
      await observer.close();
      b.db.close();
      a.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Flush the async runIdle/snapshot/poll loop without wall-clock sleeps.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

for (const gate of ["run", "task"] as const) {
  test(`${gate} gate: idle owner timer renews beyond original lease and foreign recovery leaves it untouched`, async (t) => {
    const f = fixture();
    t.mock.timers.enable({ apis: ["setInterval"] });
    try {
      f.seed();
      if (gate === "task") {
        f.task("run");
        f.action({ type: "wait", reason: "Waiting for login" });
      }
      f.owner.resume("run");
      await f.owner.runIdle("run");
      assert.equal(f.calls(), 1, "a real tracked planner turn has settled");
      assert.equal(
        f.store.run("run")!.state,
        gate === "run" ? "needs_human" : "running",
      );
      const originalSeen = f.store.run("run")!.ownerSeen;
      for (let i = 0; i < 4; i++) {
        f.advance(LEASE_MS / 3);
        t.mock.timers.tick(LEASE_MS / 3);
        await f.owner.runIdle("run");
      }
      assert.equal(f.calls(), 1, "renewal must not start more agent work");
      const before = f.store.run("run")!;
      assert.notEqual(
        before.ownerSeen,
        originalSeen,
        "idle timers must renew the lease",
      );
      assert.equal(before.ownerSeen, new Date(f.now()).toISOString());
      const tasks = f.store.tasks("run");
      assert.equal(f.observer.isLeasedElsewhere("run"), true);
      f.observer.recover();
      assert.deepEqual(f.outside.run("run"), before);
      assert.deepEqual(f.outside.tasks("run"), tasks);
      await f.owner.close();
      const closed = f.outside.run("run")!;
      f.advance(LEASE_MS * 2);
      t.mock.timers.tick(LEASE_MS * 2);
      assert.deepEqual(f.outside.run("run"), closed, "close must stop renewal");
    } finally {
      await f.close();
    }
  });
}

test("keepLeases renews owned nonterminal waits but excludes foreign and terminal runs", async () => {
  const f = fixture();
  try {
    const stamp = new Date(f.now()).toISOString();
    for (const state of [
      "running",
      "needs_human",
      "paused",
      "done",
      "failed",
      "stopped",
    ] as const)
      f.seed(state, { state, ownerId: f.owner.ownerId, ownerSeen: stamp });
    f.seed("foreign", {
      state: "needs_human",
      ownerId: f.observer.ownerId,
      ownerSeen: stamp,
    });
    f.advance(LEASE_MS * 2);
    assert.deepEqual(f.owner.keepLeases().sort(), [
      "needs_human",
      "paused",
      "running",
    ]);
    for (const id of ["running", "needs_human", "paused"])
      assert.equal(
        f.outside.run(id)!.ownerSeen,
        new Date(f.now()).toISOString(),
      );
    for (const id of ["foreign", "done", "failed", "stopped"])
      assert.equal(f.outside.run(id)!.ownerSeen, stamp);
  } finally {
    await f.close();
  }
});

test("stale foreign orphan is still recovered with interrupted tasks and restart pause", async () => {
  const f = fixture();
  try {
    f.seed("orphan", {
      state: "running",
      ownerId: "dead-process",
      ownerSeen: new Date(f.now()).toISOString(),
    });
    f.task("orphan", "running");
    f.advance(LEASE_MS + 1);
    f.observer.recover();
    const run = f.outside.run("orphan")!;
    assert.equal(run.state, "paused");
    assert.equal(run.pausedReason, RESTART_REASON);
    assert.equal(run.ownerId, undefined);
    assert.equal(run.ownerSeen, undefined);
    assert.equal(f.outside.tasks("orphan")[0].state, "interrupted");
    assert.equal(
      f.outside.tasks("orphan")[0].error,
      "Cobble closed while this task was running",
    );
  } finally {
    await f.close();
  }
});

for (const terminal of ["done", "failed", "stopped"] as const) {
  test(`Autopilot polls through outside pause and resume before settling ${terminal}`, async (t) => {
    const f = fixture();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const autopilot = new Autopilot({
      orchestrator: f.owner,
      team: (id) => (id === f.team.id ? f.team : null),
      worktreeRoot: f.root,
    });
    let waiter: Promise<TeamRun> | undefined;
    try {
      f.seed("run", { state: "running", wakeRequested: false });
      const listeners = f.owner.listenerCount("update");
      let settled = false;
      waiter = autopilot.waitForRun("run");
      void waiter.then(() => {
        settled = true;
      });
      await flush();
      assert.equal(settled, false);
      // A separate SQLite connection writes without emitting a local update.
      const paused = f.outside.run("run")!;
      paused.state = "paused";
      paused.pausedReason = "Paused from another process";
      f.outside.saveRun(paused);
      t.mock.timers.tick(250);
      await flush();
      assert.equal(
        settled,
        false,
        "an outside pause must keep Autopilot waiting",
      );
      assert.equal(
        f.outside.run("run")!.state,
        "paused",
        "waiting must not auto-resume a human pause",
      );
      f.task("run");
      f.action({ type: "wait", reason: "Waiting for login" });
      f.observer.resume("run");
      await f.observer.runIdle("run");
      const resumed = f.outside.run("run")!;
      assert.equal(resumed.state, "running");
      t.mock.timers.tick(250);
      await flush();
      assert.equal(settled, false);
      if (terminal === "done") {
        f.action({ type: "finish", summary: "Completed outside" });
        f.outside.saveRun({ ...resumed, wakeRequested: true });
        f.observer.schedule("run");
        await f.observer.runIdle("run");
      } else if (terminal === "stopped") {
        f.observer.stop("run");
      } else {
        f.outside.saveRun({ ...resumed, state: "failed" });
      }
      t.mock.timers.tick(250);
      await flush();
      assert.equal(
        settled,
        true,
        "polling must observe a terminal outside update",
      );
      assert.equal((await waiter).state, terminal);
      assert.equal(f.owner.listenerCount("update"), listeners);
    } finally {
      // Always release polling waiters, including when a regression assertion fails.
      const run = f.outside.run("run");
      if (run) f.outside.saveRun({ ...run, state: "stopped" });
      t.mock.timers.tick(250);
      await flush();
      await waiter;
      await f.close();
    }
  });
}

test("owner timers leave foreign and terminal leases untouched and stop on close", async (t) => {
  const f = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  try {
    f.seed();
    f.owner.resume("run");
    await f.owner.runIdle("run");
    const waiting = f.store.run("run")!;
    f.outside.saveRun({ ...waiting, ownerId: f.observer.ownerId });
    f.seed("ended", {
      state: "done",
      ownerId: f.owner.ownerId,
      ownerSeen: waiting.ownerSeen,
    });
    const foreign = f.outside.run("run");
    const ended = f.outside.run("ended");
    f.advance(LEASE_MS / 3);
    t.mock.timers.tick(LEASE_MS / 3);
    assert.deepEqual(f.outside.run("run"), foreign);
    assert.deepEqual(f.outside.run("ended"), ended);
    // Restore ownership via the explicit resume path, then close while idle.
    f.outside.saveRun({ ...waiting, ownerId: undefined, ownerSeen: undefined });
    f.owner.resume("run");
    await f.owner.runIdle("run");
    await f.owner.close();
    const closed = f.outside.run("run");
    f.advance(LEASE_MS * 2);
    t.mock.timers.tick(LEASE_MS * 2);
    assert.deepEqual(f.outside.run("run"), closed);
  } finally {
    await f.close();
  }
});

for (const state of ["done", "failed", "stopped", "needs_human"] as const) {
  test(`Autopilot still settles ${state} and removes its polling listener`, async (t) => {
    const f = fixture();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const autopilot = new Autopilot({
      orchestrator: f.owner,
      team: () => f.team,
      worktreeRoot: f.root,
    });
    let waiter: Promise<TeamRun> | undefined;
    try {
      f.seed("run", { state: "running", wakeRequested: false });
      const listeners = f.owner.listenerCount("update");
      waiter = autopilot.waitForRun("run");
      await flush();
      assert.equal(f.owner.listenerCount("update"), listeners + 1);
      const run = f.outside.run("run")!;
      f.outside.saveRun({ ...run, state });
      t.mock.timers.tick(250);
      await flush();
      assert.equal((await waiter).state, state);
      assert.equal(f.owner.listenerCount("update"), listeners);
    } finally {
      const run = f.outside.run("run");
      if (run) f.outside.saveRun({ ...run, state: "stopped" });
      t.mock.timers.tick(250);
      await flush();
      await waiter;
      await f.close();
    }
  });
}
