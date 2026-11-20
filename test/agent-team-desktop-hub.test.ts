import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CobbleService } from "../src/core/service";
import { desktopDataPath, desktopDaemonArgs, desktopRestartArgs } from "../src/main/desktop-lifecycle";
import { launchDaemon } from "../src/core/team/daemon-launch";
import { appHubCheckout, type AppHubAction } from "../src/core/team/app-hub";
import { DEFAULT_BUDGET, DEFAULT_POLICY, type TeamRun } from "../src/core/team/types";

function run(teamId: string, workspace: string): TeamRun {
  return { id: "fixture-run", teamId, workspace, goal: "Fixture", state: "needs_human", gate: { kind: "approval", message: "Production approval" }, plannerTurns: 0, planVersion: 1, budget: { ...DEFAULT_BUDGET }, policy: { ...DEFAULT_POLICY }, baseBranch: "main", runBranch: "kept", approvals: [], invalidPlannerReplies: 0, pendingNotes: [], wakeRequested: false, briefVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test("desktop restart retains identical data for app and detached daemon and persists chat outcomes", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-desktop-hub-"));
  const data = join(root, "custom.sqlite");
  const launches: { args: string[]; detached?: boolean; hidden?: boolean }[] = [];
  let unrefs = 0;
  const launch = () => launchDaemon(data, {
    execPath: "fake-electron", args: desktopDaemonArgs(false, "app", data),
    spawn: (_command, args, options) => { launches.push({ args, detached: options.detached, hidden: options.windowsHide }); return { pid: 123, unref() { unrefs++; } }; },
    openLog: () => 10, closeLog: () => {},
  });
  let service = new CobbleService(data, undefined, { launchTeamDaemon: launch });
  try {
    service.store.saveProfile("Owner", "");
    const team = service.store.createTeam("Fixture", "Plan", root);
    // Unfinished work with nothing driving it: the case Restart is for.
    const idle: TeamRun = {
      id: "IdleRun",
      teamId: team.id,
      goal: "Feature",
      state: "paused",
      plannerTurns: 0,
      planVersion: 1,
      budget: { ...DEFAULT_BUDGET },
      policy: { ...DEFAULT_POLICY },
      baseBranch: "main",
      runBranch: "team/idle",
      approvals: [],
      invalidPlannerReplies: 0,
      pendingNotes: [],
      wakeRequested: false,
      workspace: root,
      briefVersion: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    service.teamStore.saveRun(idle);
    await service.sendTeamChat(null, "status");
    await service.sendTeamChat(null, "start autopilot 2");
    const confirmation = service.teamProjectChat().find(m => m.control?.command.kind === "autopilot");
    assert.ok(confirmation);
    // Restart is a backend-authorized action with a persisted result before relaunch.
    const action = (await service.teamAppHub()).health.flatMap(h => h.actions).find(a => a.kind === "restart")!;
    let restarted: string[] | undefined;
    await service.teamAppHubAction(action, undefined, () => { restarted = desktopRestartArgs(["app", "--data", "old.sqlite"], data); });
    assert.equal(desktopDataPath(restarted!, "unused"), data);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0], { args: ["app", "--team-daemon", "--data", data], detached: true, hidden: true });
    assert.equal(unrefs, 1);
    assert.ok(service.teamProjectChat().some(m => /Action completed: restart/.test(m.text)));
    await service.close();
    service = new CobbleService(desktopDataPath(restarted!, "unused"), undefined, { launchTeamDaemon: launch });
    assert.ok(service.teamProjectChat().some(m => m.text === "status"));
    assert.ok(service.teamProjectChat().some(m => m.control));
    assert.ok(service.teamProjectChat().some(m => /Action completed: restart/.test(m.text)));
    // A healthy daemon is reused rather than launching a duplicate owner.
    service.teamStore.acquireDaemonLock({ id: "live", pid: process.pid }, Date.now(), 30000);
    await service.startTeamRun("Fixture", undefined, undefined, { detach: true }).catch(() => {});
    assert.equal(launches.length, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop hub and chat reject forged production and sign-in actions and persist errors across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-desktop-gates-"));
  const data = join(root, "state.sqlite");
  let service = new CobbleService(data);
  try {
    service.store.saveProfile("Owner", "");
    const team = service.store.createTeam("Fixture", "Plan", root);
    const saved = run(team.id, root);
    service.teamStore.saveRun(saved);
    for (const kind of ["approval", "login"] as const) {
      saved.gate = { kind, message: "Human path" };
      service.teamStore.saveRun(saved);
      const forged: AppHubAction = { id: JSON.stringify(["approve", saved.id, null, null]), kind: "approve", label: "Approve", runId: saved.id, humanOnly: false };
      await assert.rejects(service.teamAppHubAction(forged), /unavailable|human-only/);
      // A forged answer cannot complete a sign-in or approval either.
      const answer: AppHubAction = { id: JSON.stringify(["answer", saved.id, null, null]), kind: "answer", label: "Done", runId: saved.id };
      await assert.rejects(service.teamAppHubAction(answer, "done"), /unavailable|human-only/);
      assert.equal(service.teamStore.run(saved.id)?.gate?.kind, kind);
    }
    const restart = (await service.teamAppHub()).health.flatMap(h => h.actions).find(a => a.kind === "restart")!;
    await assert.rejects(service.teamAppHubAction({ ...restart, runId: saved.id }), /unavailable/);
    await service.close();
    service = new CobbleService(data);
    assert.ok(service.teamProjectChat().filter(m => /Action failed/.test(m.text)).length >= 5);
    assert.equal(service.teamStore.run(saved.id)?.productionApprovals, undefined);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test("desktop checkout probe uses local refs and ancestry through injected git", async () => {
  const calls: string[][] = [];
  const git = async (...args: string[]) => { calls.push(args); return args[1] === "HEAD" ? "old" : "new"; };
  assert.equal((await appHubCheckout("desktop", git))?.stale, true);
  assert.deepEqual(calls, [["rev-parse", "HEAD"], ["rev-parse", "refs/heads/desktop"], ["merge-base", "--is-ancestor", "old", "new"]]);
  assert.equal(await appHubCheckout("desktop", async () => { throw new Error("missing ref"); }), undefined);
  assert.throws(() => desktopDataPath(["--data"], "fallback"), /requires/);
});
