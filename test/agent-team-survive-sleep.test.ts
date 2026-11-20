import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Store } from "../src/core/store";
import { CobbleService } from "../src/core/service";
import { TeamStore } from "../src/core/team/team-store";
import { TeamDaemon, DAEMON_STALE_MS } from "../src/core/team/daemon";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import {
  AutomationRestorer,
  automationStale,
  type AutomationRecord,
  type RestoreDeps,
} from "../src/core/team/automation";
import {
  buildDigest,
  shortDigest,
  collectDigestInput,
} from "../src/core/team/digest";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";
import type { AutopilotOptions, AutopilotStatus } from "../src/shared/types";
import type { ControlCenterDeps } from "../src/core/team/control-center";
import { ControlCenter } from "../src/core/team/control-center";

function fixture(t: import("node:test").TestContext) {
  const root = mkdtempSync(join(tmpdir(), "cobble-sleep-"));
  const store = new Store(join(root, "test.sqlite"));
  store.saveProfile("Owner", "");
  const team = store.createTeam("Test", "Plan", root);
  const teamStore = new TeamStore(store);
  let now = 1_000_000;
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: {},
    worktreeRoot: root,
    team: () => team,
    now: () => now,
  });
  // Exercise real recovery and lease adoption without launching a worktree or CLI.
  orchestrator.schedule = () => {};
  const daemons: TeamDaemon[] = [];
  t.after(async () => {
    for (const daemon of daemons) await daemon.stop();
    await orchestrator.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const run = (id = "run", state: TeamRun["state"] = "running"): TeamRun => ({
    id,
    teamId: team.id,
    goal: "Work",
    state,
    pendingNotes: [],
    wakeRequested: false,
    briefVersion: 0,
    plannerTurns: 0,
    planVersion: 1,
    budget: { ...DEFAULT_BUDGET },
    policy: { ...DEFAULT_POLICY },
    baseBranch: "main",
    runBranch: "work",
    approvals: [],
    invalidPlannerReplies: 0,
    workspace: root,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ownerId: "old",
    ownerSeen: new Date(0).toISOString(),
  });
  const record = (): AutomationRecord => ({
    teamId: team.id,
    options: {
      parallel: 2,
      maxRuns: 7,
      backlogPath: "tasks.md",
      checkCommand: "npm test",
      pilot: false,
    },
    startedAt: new Date(0).toISOString(),
    ownerPid: 123,
    ownerId: "old",
    heartbeatAt: 0,
    runs: [],
  });
  const starts: AutopilotOptions[] = [];
  const notes: string[] = [];
  const deps: RestoreDeps = {
    ownerId: orchestrator.ownerId,
    records: () => teamStore.automations(),
    claim: (id, old, owner) => teamStore.claimAutomation(id, old, owner, now),
    stopped: (id) => store.setting(`teamControlStopped:${id}`, null),
    autopilotActive: () => false,
    runs: (id) => teamStore.runs(id),
    waitForRun: async (_id, id) => teamStore.run(id) ?? undefined,
    completeAutopilotRun: async () => {},
    startAutopilot: async (_id, options) => {
      starts.push(options);
    },
    clear: (id) => teamStore.clearAutomation(id, orchestrator.ownerId),
    note: (_id, text) => {
      notes.push(text);
    },
    now: () => now,
    pidAlive: () => true,
  };
  const service = Object.create(CobbleService.prototype) as CobbleService;
  EventEmitter.call(service);
  Object.assign(service, {
    store,
    teamStore,
    agentTeam: orchestrator,
    autopilotSessions: new Map(),
    startingTeamRuns: new Set(),
    automationRestorers: new Set(),
    autopilot: { path: () => root },
    teamId: () => team.id,
  });
  return {
    store,
    team,
    teamStore,
    orchestrator,
    daemons,
    run,
    record,
    deps,
    starts,
    notes,
    service,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("stale daemon takeover resumes interrupted work, preserves finished tasks and records restart", async (t) => {
  const f = fixture(t);
  f.teamStore.acquireDaemonLock({ id: "old", pid: 123 }, 0, DAEMON_STALE_MS);
  f.teamStore.saveRun(f.run());
  for (const [id, state] of [
    ["interrupted", "running"],
    ["finished", "done"],
  ] as const) {
    f.teamStore.saveTask({
      id,
      runId: "run",
      role: "coder",
      agent: "codex",
      title: id,
      instructions: "Work",
      acceptance: [],
      dependsOn: [],
      state,
      attempt: 1,
      createdAt: new Date(f.now()).toISOString(),
    } as TeamTask);
  }
  const daemon = new TeamDaemon({
    orchestrator: f.orchestrator,
    teamStore: f.teamStore,
    now: f.now,
  });
  f.daemons.push(daemon);
  await daemon.start();
  assert.equal(f.teamStore.run("run")?.state, "running");
  assert.equal(
    f.teamStore.tasks("run").find((t) => t.id === "interrupted")?.state,
    "queued",
  );
  assert.equal(
    f.teamStore.tasks("run").find((t) => t.id === "finished")?.state,
    "done",
  );
  assert.deepEqual(f.teamStore.recoveries(0)[0].runIds, ["run"]);
  assert.equal(f.teamStore.recoveries(0)[0].kind, "restart");
});

test("tick gap renews leases before recording sleep and suppresses restoration", async (t) => {
  const f = fixture(t);
  const order: string[] = [];
  const keep = f.orchestrator.keepLeases.bind(f.orchestrator);
  f.orchestrator.keepLeases = () => {
    order.push("leases");
    return keep();
  };
  const daemon = new TeamDaemon({
    orchestrator: f.orchestrator,
    teamStore: f.teamStore,
    now: f.now,
    restore: {
      tick: () => {},
      noteSleep: () => {
        order.push("sleep");
      },
    },
  });
  f.daemons.push(daemon);
  await daemon.start();
  order.length = 0;
  f.advance(DAEMON_STALE_MS + 1);
  daemon.tick();
  assert.deepEqual(order, ["leases", "sleep"]);
  assert.equal(f.teamStore.recoveries(0)[0].gapMs, DAEMON_STALE_MS + 1);
  assert.equal(f.teamStore.recoveries(0)[0].kind, "sleep");
  f.teamStore.saveAutomation(f.record());
  const restorer = new AutomationRestorer(f.deps);
  restorer.noteSleep(f.now());
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 0);
  f.advance(DAEMON_STALE_MS);
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 1);
});

test("stale automation restores identical options with detach and completes recorded items", async (t) => {
  const f = fixture(t),
    record = f.record();
  record.runs = [{ runId: "done", item: "Work" }];
  f.teamStore.saveRun(f.run("done", "done"));
  f.teamStore.saveAutomation(record);
  const completed: string[] = [];
  f.deps.completeAutopilotRun = async (_team, id, opts) => {
    completed.push(id + opts.item);
  };
  const restorer = new AutomationRestorer(f.deps);
  restorer.tick();
  restorer.tick();
  await settle();
  assert.deepEqual(f.starts, [{ ...record.options, detach: true }]);
  assert.deepEqual(completed, ["doneWork"]);
  assert.match(
    f.notes[0],
    /Autopilot restarted after Cobble stopped unexpectedly/,
  );
  assert.equal(
    automationStale(
      { ...record, heartbeatAt: f.now() },
      f.now(),
      DAEMON_STALE_MS,
      () => false,
    ),
    true,
  );
});

test("user stop and control-center stop prevent restoration, including while waiting", async (t) => {
  const f = fixture(t);
  f.teamStore.saveAutomation(f.record());
  f.service.stopAutopilot();
  const restorer = new AutomationRestorer(f.deps);
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 0);
  f.teamStore.saveAutomation(f.record());
  let saved: import("../src/core/team/control-center").StoppedSession | null =
    null;
  const center = new ControlCenter({
    teamStore: f.teamStore,
    runs: () => [],
    autopilotStatus: () => ({ active: false }),
    autopilotOptions: () => undefined,
    stopped: () => null,
    saveStopped: (
      _id: string,
      value: import("../src/core/team/control-center").StoppedSession | null,
    ) => {
      saved = value;
    },
    stopAutopilot: () => f.service.stopAutopilot(),
  } as unknown as ControlCenterDeps);
  const stop = await center.handle(f.team.id, "stop");
  assert.equal(stop.type, "confirm");
  if (stop.type === "confirm") {
    const result = await center.confirm(f.team.id, stop.message.id, true);
    assert.equal(result.control?.status, "done");
  }
  assert.deepEqual(
    (saved as import("../src/core/team/control-center").StoppedSession | null)
      ?.autopilot,
    f.record().options,
  );
  assert.equal(f.teamStore.automation(f.team.id), null);
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 0);
  const record = f.record();
  record.runs = [{ runId: "done" }];
  f.teamStore.saveAutomation(record);
  let finish!: (run: TeamRun) => void;
  f.deps.waitForRun = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  restorer.tick();
  f.service.stopAutopilot();
  finish(f.run("done", "done"));
  await settle();
  assert.equal(f.starts.length, 0);
});

test("cleared or re-owned automation stops local session on heartbeat", (t) => {
  const f = fixture(t);
  const shutdown = new AbortController();
  const status = {
    active: true,
    currentRuns: [{ runId: "one", item: "Work" }],
    completed: [],
  } as unknown as AutopilotStatus;
  f.service["autopilotSessions"].set(f.team.id, {
    status,
    shutdown,
    work: Promise.resolve(),
    options: {},
  });
  f.service.recordAutomation(f.team.id, {});
  assert.equal(f.service.heartbeatAutomation(f.team.id), true);
  assert.deepEqual(f.teamStore.automation(f.team.id)?.runs, [
    { runId: "one", item: "Work" },
  ]);
  f.teamStore.clearAutomation(f.team.id);
  assert.equal(f.service.heartbeatAutomation(f.team.id), false);
  assert.match(status.stoppedReason ?? "", /Automation ownership changed/);
  f.service.recordAutomation(f.team.id, {});
  f.teamStore.claimAutomation(
    f.team.id,
    f.orchestrator.ownerId,
    "other",
    f.now(),
  );
  assert.equal(f.service.heartbeatAutomation(f.team.id), false);
  f.service.clearAutomation(f.team.id);
  assert.equal(f.teamStore.automation(f.team.id)?.ownerId, "other");
});

test("keepAwake holds running work, releases idle and stop; digest and status show recoveries", async (t) => {
  const f = fixture(t);
  let held = false,
    releases = 0;
  const daemon = new TeamDaemon({
    orchestrator: f.orchestrator,
    teamStore: f.teamStore,
    now: f.now,
    keepAwake: {
      hold: () => {
        held = true;
      },
      release: () => {
        held = false;
        releases++;
      },
    },
  });
  f.daemons.push(daemon);
  await daemon.start();
  const run = f.run();
  run.ownerId = f.orchestrator.ownerId;
  f.teamStore.saveRun(run);
  daemon.tick();
  assert.equal(held, true);
  f.teamStore.saveRun({ ...run, state: "done" });
  daemon.tick();
  assert.equal(held, false);
  const before = releases;
  await daemon.stop();
  assert.equal(releases, before + 1);
  f.teamStore.recordRecovery({
    at: new Date().toISOString(),
    kind: "sleep",
    runIds: [run.id],
  });
  const input = collectDigestInput(f.teamStore, f.team, Date.now(), 24);
  assert.match(buildDigest(input), /## Recovered after sleep or restart/);
  assert.match(shortDigest(input), /Recovered after sleep or restart: 1/);
  assert.match(
    f.service.recoveryStatusText(),
    /Recovered after sleep or restart:.*\(1 runs\)/,
  );
  assert.match(
    (f.service.teamRun(run.id) as { recovery?: string }).recovery ?? "",
    /Recovered after sleep or restart/,
  );
});

test("startAutopilot persists options and normal completion clears its record", async (t) => {
  const f = fixture(t);
  let finish!: () => void;
  Object.assign(f.service, {
    autopilot: { path: () => f.team.workspace, prepare: async () => {} },
    runAutopilot: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return "Backlog is empty.";
    },
  });
  const options = { parallel: 2, maxRuns: 4, backlogPath: "tasks.md" };
  await f.service.startAutopilot(options);
  assert.deepEqual(f.teamStore.automation(f.team.id)?.options, options);
  assert.equal(f.teamStore.automation(f.team.id)?.ownerPid, process.pid);
  assert.equal(
    f.teamStore.automation(f.team.id)?.ownerId,
    f.orchestrator.ownerId,
  );
  finish();
  await f.service["autopilotSessions"].get(f.team.id)?.work;
  assert.equal(f.service.autopilotStatus().active, false);
  assert.equal(f.teamStore.automation(f.team.id), null);
  await f.service.startAutopilot(options);
  f.teamStore.clearAutomation(f.team.id);
  assert.equal(f.service.heartbeatAutomation(f.team.id), false);
  assert.match(
    f.service.autopilotStatus().stoppedReason ?? "",
    /ownership changed/,
  );
  finish();
  await f.service["autopilotSessions"].get(f.team.id)?.work;
  assert.equal(f.service.autopilotStatus().active, false);
});

test("restorer defers human gates and unrelated work, clears failures and gives up", async (t) => {
  const f = fixture(t);
  const record = f.record();
  f.teamStore.saveAutomation(record);
  f.store.set(`teamControlStopped:${f.team.id}`, { runs: [] });
  const restorer = new AutomationRestorer(f.deps, { giveUpMs: 1000 });
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 0);
  f.store.set(`teamControlStopped:${f.team.id}`, null);
  for (const state of ["needs_human", "paused", "running"] as const) {
    f.teamStore.saveRun(f.run("unrelated", state));
    restorer.tick();
    await settle();
    assert.equal(f.starts.length, 0);
    assert.equal(f.teamStore.automation(f.team.id)?.ownerId, "old");
  }
  f.teamStore.saveRun(f.run("unrelated", "done"));
  f.teamStore.saveRun(f.run("failed", "failed"));
  f.teamStore.saveAutomation({ ...record, runs: [{ runId: "failed" }] });
  restorer.tick();
  await settle();
  assert.equal(f.teamStore.automation(f.team.id), null);
  assert.match(f.notes.at(-1)!, /ended failed/);
  f.teamStore.saveAutomation(record);
  f.deps.startAutopilot = async () => {
    throw new Error("start failed");
  };
  restorer.tick();
  await settle();
  assert.equal(f.teamStore.automation(f.team.id), null);
  assert.match(f.notes.at(-1)!, /start failed/);
  f.teamStore.saveAutomation({ ...record, restoreSince: f.now() - 1001 });
  restorer.tick();
  assert.equal(f.teamStore.automation(f.team.id), null);
  assert.match(f.notes.at(-1)!, /gave up/);
});

import {
  watchdogAction,
  ensureDaemonRunning,
} from "../src/core/team/watchdog-cli";

for (const [platform, systemd, expected] of [
  ["win32", false, "schtasks /Create"],
  ["darwin", false, "launchctl bootstrap"],
  ["linux", true, "systemctl --user enable --now"],
  ["linux", false, "crontab -"],
] as const) {
  for (const kind of ["install", "uninstall"] as const) {
    test(`watchdog ${platform} systemd=${systemd} ${kind} dry run has no effects`, async () => {
      const unexpected = () => {
        throw new Error("Dry run performed an OS operation");
      };
      const result = await watchdogAction(kind, "data with spaces/test.db", {
        platform,
        systemd,
        dryRun: true,
        home: "/home/test",
        uid: 42,
        user: "test",
        deps: {
          exec: async () => unexpected(),
          writeFile: unexpected,
          mkdir: unexpected,
          removeFile: unexpected,
        },
      });
      const output = result.lines.join("\n");
      if (kind === "install") {
        assert.ok(output.includes(expected), output);
        assert.ok(output.includes("ensure"));
        if (platform === "win32") {
          for (const trigger of ["LogonTrigger", "EventID=1", "PT10M"])
            assert.ok(output.includes(trigger));
          assert.equal(result.plan.files[0].encoding, "utf16le-bom");
        }
        if (platform === "darwin") assert.ok(output.includes("<plist"));
        if (platform === "linux" && systemd)
          assert.ok(output.includes("OnUnitActiveSec=10min"));
        if (platform === "linux" && !systemd)
          assert.ok(output.includes("@reboot"));
      } else {
        assert.ok(
          output.includes(
            platform === "win32"
              ? "/Delete"
              : platform === "darwin"
                ? "bootout"
                : systemd
                  ? "disable --now"
                  : "crontab -",
          ),
        );
      }
    });
  }
}

for (const state of ["fresh", "stale", "dead"] as const) {
  test(`daemon ensure ${state} heartbeat and process`, async (t) => {
    const f = fixture(t);
    const now = Date.now();
    f.teamStore.acquireDaemonLock(
      { id: "old", pid: 123 },
      state === "stale" ? now - DAEMON_STALE_MS - 1 : now,
      DAEMON_STALE_MS,
    );
    let launched = 0;
    const result = await ensureDaemonRunning(f.teamStore, "test.db", {
      alive: () => state !== "dead" || launched > 0,
      launch: () => {
        launched++;
        f.teamStore.releaseDaemonLock("old");
        f.teamStore.acquireDaemonLock(
          { id: "new", pid: 456 },
          Date.now(),
          DAEMON_STALE_MS,
        );
        return 456;
      },
      wait: async (check) => check(),
    });
    assert.equal(launched, state === "fresh" ? 0 : 1);
    assert.equal(result.started, state !== "fresh");
  });
}

test("daemon start waits a stale window and live owners need two stale windows", async (t) => {
  const f = fixture(t);
  const record = { ...f.record(), heartbeatAt: f.now() - DAEMON_STALE_MS };
  f.teamStore.saveAutomation(record);
  const restorer = new AutomationRestorer(f.deps);
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 0);
  const daemon = new TeamDaemon({
    orchestrator: f.orchestrator,
    teamStore: f.teamStore,
    now: f.now,
    restore: restorer,
  });
  f.daemons.push(daemon);
  await daemon.start();
  await settle();
  assert.equal(f.starts.length, 0);
  f.advance(DAEMON_STALE_MS);
  restorer.tick();
  await settle();
  assert.equal(f.starts.length, 1);
});

test("daemon stop aborts a pending restore without clearing its record", async (t) => {
  const f = fixture(t);
  f.teamStore.saveAutomation({ ...f.record(), runs: [{ runId: "pending" }] });
  let rejectWait!: (error: Error) => void;
  let signal: AbortSignal | undefined;
  f.deps.waitForRun = (_team, _run, _timeout, abort) => {
    signal = abort;
    return new Promise((_resolve, reject) => {
      rejectWait = reject;
    });
  };
  const restorer = new AutomationRestorer(f.deps);
  const daemon = new TeamDaemon({
    orchestrator: f.orchestrator,
    teamStore: f.teamStore,
    now: f.now,
    restore: restorer,
  });
  f.daemons.push(daemon);
  await daemon.start();
  f.advance(DAEMON_STALE_MS);
  restorer.tick();
  await daemon.stop();
  assert.equal(signal?.aborted, true);
  rejectWait(new Error("closing"));
  await settle();
  restorer.tick();
  assert.ok(f.teamStore.automation(f.team.id));
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.notes, []);
});

test("desktop stop clears a daemon-owned record and its session stops on heartbeat", (t) => {
  const f = fixture(t);
  const status = { active: true, completed: [] } as unknown as AutopilotStatus;
  f.service["autopilotSessions"].set(f.team.id, {
    status,
    shutdown: new AbortController(),
    work: Promise.resolve(),
    options: {},
  });
  f.service.recordAutomation(f.team.id, {});
  const desktop = Object.create(CobbleService.prototype) as CobbleService;
  Object.assign(desktop, {
    teamStore: f.teamStore,
    teamId: () => f.team.id,
    autopilotSessions: new Map(),
    autopilotStatus: () => ({ active: false }),
  });
  desktop.stopAutopilot();
  assert.equal(f.teamStore.automation(f.team.id), null);
  assert.equal(f.service.heartbeatAutomation(f.team.id), false);
  assert.match(status.stoppedReason ?? "", /ownership changed/);
});

import { KeepAwake } from "../src/core/team/keep-awake";
import { automationSignals } from "../src/core/team/automation-signals";

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`keep-awake tolerates missing ${platform} binary and logs once`, () => {
    let logs = 0;
    let sync = true;
    const child = Object.assign(new EventEmitter(), { kill() {} });
    const awake = new KeepAwake({
      platform,
      pid: 42,
      hasCommand: () => true,
      spawn: () => {
        if (sync) throw new Error("ENOENT");
        return child;
      },
      log: () => {
        logs++;
      },
    });
    assert.doesNotThrow(() => awake.hold());
    assert.equal(awake.holding, false);
    sync = false;
    awake.hold();
    assert.equal(awake.holding, true);
    assert.doesNotThrow(() => child.emit("error", new Error("ENOENT")));
    assert.equal(awake.holding, false);
    awake.hold();
    awake.release();
    assert.equal(logs, 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", undefined]) {
  test(`CLI automation cleanup for ${signal ?? "normal completion/error"}`, (t) => {
    const f = fixture(t);
    f.service.recordAutomation(f.team.id, {});
    const signals = new EventEmitter();
    const shutdown = new AbortController();
    const finish = automationSignals({
      signals,
      clear: () => f.service.clearAutomation(f.team.id),
      abort: () => shutdown.abort(),
    });
    if (signal) signals.emit(signal);
    finish();
    assert.equal(
      !!f.teamStore.automation(f.team.id),
      signal === "SIGTERM" || signal === "SIGHUP",
    );
    assert.equal(shutdown.signal.aborted, !!signal);
    assert.equal(signals.eventNames().length, 0);
  });
}

test("CLI run tracking persists starts and completions without a desktop session", (t) => {
  const f = fixture(t);
  t.mock.method(Date, "now", f.now);
  f.service.recordAutomation(f.team.id, {});
  f.service.updateAutomationRuns(f.team.id, [{ runId: "one", item: "First" }]);
  f.advance(5000);
  f.service.heartbeatAutomation(f.team.id);
  assert.deepEqual(f.teamStore.automation(f.team.id)?.runs, [
    { runId: "one", item: "First" },
  ]);
  f.service.updateAutomationRuns(f.team.id, [{ runId: "two", item: "Second" }]);
  assert.deepEqual(f.teamStore.automation(f.team.id)?.runs, [
    { runId: "two", item: "Second" },
  ]);
  f.service.updateAutomationRuns(f.team.id, []);
  assert.deepEqual(f.teamStore.automation(f.team.id)?.runs, []);
  const record = f.teamStore.automation(f.team.id)!;
  f.teamStore.saveAutomation({ ...record, ownerId: "other" });
  f.service.updateAutomationRuns(f.team.id, [{ runId: "wrong" }]);
  assert.deepEqual(f.teamStore.automation(f.team.id)?.runs, []);
});

for (const detach of [false, true]) {
  test(`service close preserves automation only with detach=${detach}`, async (t) => {
    const f = fixture(t);
    f.service.recordAutomation(f.team.id, { detach });
    const shutdown = new AbortController();
    f.service["autopilotSessions"].set(f.team.id, {
      status: { active: true } as AutopilotStatus,
      shutdown,
      options: { detach },
      work: Promise.resolve(),
    });
    Object.assign(f.service, {
      automationRestorers: new Set(),
      backupTasks: new Set(),
      bridge: { close() {} },
      network: { close() {}, hosting: { settled: async () => {} } },
      store: new Proxy(f.store, {
        get(target, key) {
          if (key === "close") return () => {};
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    await f.service.close();
    assert.equal(shutdown.signal.aborted, true);
    assert.equal(!!f.teamStore.automation(f.team.id), detach);
  });
}

test("daemon stop closes its restorer without clearing automation", async (t) => {
  const f = fixture(t);
  f.teamStore.saveAutomation(f.record());
  const daemon = new TeamDaemon({
    orchestrator: f.orchestrator,
    teamStore: f.teamStore,
    now: f.now,
    restore: f.service.automationRestorer(),
  });
  await daemon.stop();
  assert.ok(f.teamStore.automation(f.team.id));
});

test("watchdog respects user stop; explicit handoff and desktop starts clear it", async (t) => {
  const f = fixture(t);
  t.mock.method(Date, "now", f.now);
  f.teamStore.setDaemonUserStopped(f.now());
  let launched = 0;
  const deps = {
    alive: () => true,
    launch: () => {
      launched++;
      f.teamStore.acquireDaemonLock(
        { id: "new", pid: 42 },
        Date.now(),
        DAEMON_STALE_MS,
      );
      return 42;
    },
    wait: async (check: () => boolean) => check(),
  };
  const result = await ensureDaemonRunning(f.teamStore, "fake.db", {
    ...deps,
    respectUserStop: true,
  });
  assert.equal(result.userStopped, true);
  assert.equal(launched, 0);
  await ensureDaemonRunning(f.teamStore, "fake.db", deps);
  assert.equal(launched, 1);
  assert.equal(f.teamStore.daemonUserStopped(), false);
  f.teamStore.releaseDaemonLock("new");
  f.teamStore.setDaemonUserStopped(f.now());
  Object.assign(f.service, {launchTeamDaemon: deps.launch});
  f.service["ensureTeamDaemon"]();
  assert.equal(launched, 2);
  assert.equal(f.teamStore.daemonUserStopped(), false);
});

test("daemon help describes each command and README documents CLI watchdog limits", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  for (const command of ["status", "stop", "install", "uninstall", "ensure"])
    assert.match(
      cli,
      new RegExp(`cobble team daemon ${command} +[a-z][^\\n]+`),
    );
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /ensure.*respects a user daemon stop/);
  assert.match(readme, /packaged-app installation is a known limitation/);
});
