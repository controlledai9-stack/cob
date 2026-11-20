import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  AppHub,
  buildAppHubSnapshot,
  timeoutOnlyCheck,
  type AppHubInput,
} from "../src/core/team/app-hub";
import { parseControlCommand } from "../src/core/team/control-commands";
import {
  ControlCenter,
  type ControlCenterDeps,
} from "../src/core/team/control-center";
import { ProjectChat } from "../src/core/team/project-chat";
import { retryAppHubTarget } from "../src/core/team/app-hub";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "cobble-app-hub-"));
  const store = new Store(join(path, "test.db"));
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", "Goal", process.cwd());
  const teamStore = new TeamStore(store);
  const run: TeamRun = {
    id: "RunCase",
    teamId: team.id,
    goal: "Feature",
    state: "running",
    plannerTurns: 0,
    planVersion: 1,
    budget: { ...DEFAULT_BUDGET },
    policy: { ...DEFAULT_POLICY },
    baseBranch: "main",
    runBranch: "kept",
    approvals: [],
    invalidPlannerReplies: 0,
    pendingNotes: [],
    wakeRequested: false,
    workspace: path,
    briefVersion: 1,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  teamStore.saveRun(run);
  const input: AppHubInput = {
    now: 200_000,
    runs: [{ run, tasks: [] }],
    daemon: { id: "daemon", pid: 10, startedAt: 0, heartbeat: 200_000 },
    processAlive: () => true,
    ownerAlive: () => false,
  };
  return {
    store,
    team,
    teamStore,
    run,
    input,
    close() {
      store.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}
function task(runId: string): TeamTask {
  return {
    id: "T1",
    runId,
    role: "coder",
    agent: "codex",
    title: "Code",
    instructions: "Code",
    acceptance: [],
    dependsOn: [],
    state: "failed",
    attempt: 1,
    createdAt: new Date(0).toISOString(),
  };
}

test("retry resolves within project, preserves budgets, rejects gates and live owners before writes", async () => {
  const f = fixture();
  try {
    f.run.state = "failed";
    f.teamStore.saveRun(f.run);
    const t = task(f.run.id);
    f.teamStore.saveTask(t);
    const resumes: string[] = [];
    let leased = false;
    const retry = (teamId: string, target: string) =>
      retryAppHubTarget(
        f.teamStore,
        teamId,
        target,
        () => leased,
        async (id) => {
          resumes.push(id);
        },
      );
    await assert.rejects(retry("other-project", t.id), /Unknown/);
    leased = true;
    await assert.rejects(retry(f.team.id, f.run.id), /owns/);
    leased = false;
    t.attempt = f.run.budget.maxAttempts;
    f.teamStore.saveTask(t);
    await assert.rejects(retry(f.team.id, t.id), /budget/);
    t.attempt = 1;
    t.target = "production";
    f.teamStore.saveTask(t);
    await assert.rejects(retry(f.team.id, f.run.id), /human approval/);
    t.target = undefined;
    t.gate = { kind: "approval", message: "Approve" };
    f.teamStore.saveTask(t);
    await assert.rejects(retry(f.team.id, t.id), /human approval/);
    assert.equal(f.teamStore.tasks(f.run.id)[0].state, "failed");
    assert.deepEqual(resumes, []);
    t.gate = undefined;
    f.teamStore.saveTask(t);
    await retry(f.team.id, f.run.id);
    assert.deepEqual(resumes, [f.run.id]);
    const persisted = new TeamStore(f.store).tasks(f.run.id)[0];
    assert.equal(persisted.state, "queued");
    assert.equal(persisted.attempt, 1, "retry cannot reset the attempt budget");
    assert.equal(f.teamStore.run(f.run.id)!.state, "paused");
  } finally {
    f.close();
  }
});

test("recovery action becomes unavailable when a fresh owner renews its lease", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const hub = new AppHub({
      teamStore: f.teamStore,
      input: () => f.input,
      execute: async () => {
        calls++;
      },
    });
    const recover = (await hub.snapshot(f.team.id)).health[0].actions[0];
    f.run.ownerId = "new-owner";
    f.run.ownerSeen = new Date(f.input.now).toISOString();
    await assert.rejects(hub.act(f.team.id, recover), /unavailable/);
    assert.equal(calls, 0);
  } finally {
    f.close();
  }
});

test("new commands preserve arguments and reject missing/invalid arguments", () => {
  assert.deepEqual(
    parseControlCommand("ADD Mixed Case " + "Idea ".repeat(30)),
    { kind: "add", idea: "Mixed Case " + "Idea ".repeat(30).trimEnd() },
  );
  assert.deepEqual(parseControlCommand("retry RunCase"), {
    kind: "retry",
    target: "RunCase",
  });
  assert.deepEqual(parseControlCommand("review later RunCase"), {
    kind: "review-later",
    runId: "RunCase",
  });
  assert.deepEqual(parseControlCommand("review-later RunCase"), {
    kind: "review-later",
    runId: "RunCase",
  });
  assert.deepEqual(parseControlCommand("logs RunCase"), {
    kind: "logs",
    runId: "RunCase",
  });
  assert.deepEqual(parseControlCommand("what needs me"), { kind: "needs-you" });
  assert.deepEqual(parseControlCommand("start autopilot 3"), {
    kind: "autopilot",
    parallel: 3,
  });
  for (const text of [
    "add",
    "retry",
    "review later",
    "logs two runs",
    "start autopilot 7",
  ])
    assert.equal(parseControlCommand(text)?.kind, "invalid", text);
});

test("health uses heartbeat, process, lease and checkout evidence", () => {
  const f = fixture();
  try {
    let snapshot = buildAppHubSnapshot(f.input);
    assert.deepEqual(
      snapshot.health.map((h) => h.id),
      ["orphan:RunCase"],
    );
    f.run.ownerId = "owner";
    f.run.ownerSeen = new Date(f.input.now).toISOString();
    assert.equal(
      buildAppHubSnapshot(f.input).health.length,
      0,
      "fresh lease blocks recovery even with dead process evidence",
    );
    f.run.ownerSeen = new Date(0).toISOString();
    f.input.ownerAlive = () => undefined;
    assert.equal(
      buildAppHubSnapshot(f.input).health.length,
      0,
      "unknown owner is not proven orphan",
    );
    f.input.ownerAlive = () => false;
    f.input.daemon!.heartbeat = 0;
    f.input.checkout = { stale: true, detail: "promoted commit ahead" };
    f.input.automation = {
      teamId: f.team.id,
      options: {},
      ownerPid: 20,
      ownerId: "auto",
      heartbeatAt: 0,
      startedAt: new Date(0).toISOString(),
      runs: [],
    };
    snapshot = buildAppHubSnapshot(f.input);
    assert.deepEqual(
      snapshot.health.map((h) => h.id),
      ["daemon", "automation", "orphan:RunCase", "checkout"],
    );
    f.input.daemon!.heartbeat = f.input.now;
    f.input.processAlive = () => false;
    assert.ok(
      buildAppHubSnapshot(f.input).health.some((h) => h.id === "daemon"),
    );
  } finally {
    f.close();
  }
});

test("timeout checks alone offer retry; gates, kept branches and review items aggregate", () => {
  const f = fixture();
  try {
    const t = task(f.run.id);
    t.check = { command: "fake", passed: false, output: "Assertion failed" };
    f.input.runs[0].tasks = [t];
    // While the run is going, the agents handle an ordinary failure.
    const state = f.run.state;
    f.run.state = "running";
    assert.equal(
      buildAppHubSnapshot(f.input).needsYou.filter((i) => i.id.startsWith("check:")).length,
      0,
    );
    f.run.state = "paused";
    assert.equal(buildAppHubSnapshot(f.input).needsYou[0].actions.length, 0);
    f.run.state = state;
    t.check.output = "Timed out";
    assert.equal(
      buildAppHubSnapshot(f.input).needsYou[0].actions[0].kind,
      "retry-check",
    );
    assert.equal(
      timeoutOnlyCheck({ ...t.check, output: "Assertion failed, timed out" }),
      false,
    );
    assert.equal(
      timeoutOnlyCheck({
        ...t.check,
        output: "progress\n[timed out]",
        timedOut: true,
      }),
      true,
    );
    assert.equal(
      timeoutOnlyCheck({ ...t.check, passed: true, timedOut: true }),
      false,
    );
    f.run.state = "needs_human";
    f.run.gate = { kind: "questions", message: "Which color?" };
    f.run.unmerged = [t.id];
    f.input.reviewItems = [{ id: "r", title: "[r] Review", branch: "kept" }];
    const snapshot = buildAppHubSnapshot(f.input);
    assert.equal(snapshot.needsYou.length, 4);
    assert.equal(snapshot.needsYou[0].actions[0].kind, "answer");
  } finally {
    f.close();
  }
});

test("hub revalidates fresh targets, persists results and rejects human-only bypasses", async () => {
  const f = fixture();
  try {
    f.run.state = "needs_human";
    f.run.gate = { kind: "clarify", message: "Which?" };
    const calls: string[] = [];
    const hub = new AppHub({
      teamStore: f.teamStore,
      input: () => f.input,
      execute: async (_, a, answer) => {
        calls.push(`${a.kind}:${answer}`);
      },
    });
    const action = (await hub.snapshot(f.team.id)).needsYou[0].actions[0];
    await hub.act(f.team.id, action, "Blue");
    assert.deepEqual(calls, ["answer:Blue"]);
    assert.match(
      f.teamStore.projectChatMessages(f.team.id).at(-1)!.text,
      /completed/,
    );
    f.run.gate = { kind: "approval", message: "Production approval" };
    await assert.rejects(hub.act(f.team.id, action, "yes"), /human-only/);
    await assert.rejects(
      hub.act(
        f.team.id,
        { ...action, kind: "approve", humanOnly: false },
        "yes",
      ),
      /human-only/,
    );
    assert.equal((await hub.snapshot(f.team.id)).needsYou[0].actions.length, 0);
    f.run.gate = { kind: "login", message: "Sign in" };
    assert.equal((await hub.snapshot(f.team.id)).needsYou[0].actions.length, 0);
    f.run.gate = { kind: "clarify", message: "Which?" };
    await assert.rejects(
      hub.act(f.team.id, { ...action, runId: "other" }, "Blue"),
      /unavailable/,
    );
    assert.equal(calls.length, 1);
    assert.match(
      f.teamStore.projectChatMessages(f.team.id).at(-1)!.text,
      /failed/,
    );
  } finally {
    f.close();
  }
});

test("commands execute with persisted cards, planner Add/Start and cancellation", async () => {
  const f = fixture();
  try {
    const calls: string[] = [];
    const chat = new ProjectChat({
      teamStore: f.teamStore,
      team: (id) => f.store.team(id),
      backlog: async () => "",
      plannerAdapter: () => ({
        agent: "codex",
        adapter: {
          id: "codex",
          detect: async () => ({ agent: "codex", installed: true }),
          run: async () => {
            calls.push("planner");
            return {
              exitCode: 0,
              durationMs: 1,
              finalText:
                "Proposed\n```cobble-roadmap\n- [ ] Feature - done when: the feature works correctly\n```",
            };
          },
        },
      }),
    });
    const deps: ControlCenterDeps = {
      teamStore: f.teamStore,
      projectChat: chat,
      runs: () => [f.run],
      status: async () => "Ready",
      queue: async () => [],
      autopilotStatus: () => ({
        active: false,
        branch: "a",
        worktree: "",
        backlogPath: "backlog.md",
        completed: [],
      }),
      autopilotOptions: () => undefined,
      stopped: () => null,
      saveStopped: () => {},
      stopAutopilot: () => {},
      runCommand: async () => {},
      waitForRun: async () => {},
      completeAutopilotRun: async () => {},
      startAutopilot: async (_, o) => {
        calls.push(`start:${o.parallel}`);
      },
      saveSessionBrief: () => {},
      detachAvailable: true,
      retry: async (_, target) => {
        calls.push(`retry:${target}`);
      },
      reviewLater: async (_, run) => {
        calls.push(`review:${run}`);
      },
      appHub: async () => buildAppHubSnapshot(f.input),
    };
    const center = new ControlCenter(deps);
    f.teamStore.event(f.run.id, "test", "Recent event");
    for (const text of [
      "retry RunCase",
      "review later RunCase",
      "logs RunCase",
      "what needs me",
      "needs-you",
      "status",
      "logs unknown",
    ]) {
      const outcome = await center.handle(f.team.id, text);
      assert.equal(outcome.type, "result");
      assert.equal(
        outcome.message.control?.status,
        text === "logs unknown" ? "failed" : "done",
      );
    }
    assert.ok(calls.includes("retry:RunCase"));
    assert.ok(calls.includes("review:RunCase"));
    const proposal = await center.handle(
      f.team.id,
      "add Case Sensitive Feature",
    );
    assert.equal(proposal.type, "planner");
    if (proposal.type !== "planner") throw new Error("Missing proposal");
    assert.equal(proposal.proposal?.proposal?.status, "open");
    f.teamStore.updateProjectChatProposal(f.team.id, proposal.proposal!.id, {
      ...proposal.proposal!.proposal!,
      status: "added",
    });
    await chat.startProposal(
      f.team.id,
      proposal.proposal!.id,
      undefined,
      async () => f.run,
    );
    assert.equal(
      f.teamStore
        .projectChatMessages(f.team.id)
        .find((m) => m.id === proposal.proposal!.id)?.proposal?.status,
      "started",
    );
    const start = await center.handle(f.team.id, "start autopilot 2");
    if (start.type === "planner") throw new Error("Missing card");
    await center.confirm(f.team.id, start.message.id, true);
    assert.ok(calls.includes("start:2"));
    const cancelled = await center.handle(f.team.id, "start autopilot 1");
    if (cancelled.type === "planner") throw new Error("Missing card");
    assert.equal(
      (await center.confirm(f.team.id, cancelled.message.id, false)).control
        ?.status,
      "cancelled",
    );
    assert.equal(calls.filter((c) => c === "planner").length, 1);
    assert.ok(
      new TeamStore(f.store)
        .projectChatMessages(f.team.id)
        .some((m) => m.control?.result?.includes("Recent event")),
    );
  } finally {
    f.close();
  }
});

test("health and run actions execute only while their authoritative conditions remain", async () => {
  const f = fixture();
  try {
    const t = task(f.run.id);
    t.check = { command: "fake", passed: false, output: "", timedOut: true };
    f.input.runs[0].tasks = [t];
    f.input.daemon!.heartbeat = 0;
    f.run.unmerged = [t.id];
    const kinds: string[] = [];
    const hub = new AppHub({
      teamStore: f.teamStore,
      input: () => f.input,
      execute: async (_, a) => {
        kinds.push(a.kind);
        return "Saved";
      },
    });
    const snapshot = await hub.snapshot(f.team.id);
    for (const kind of [
      "recover",
      "retry-check",
      "restart",
      "review-later",
    ] as const) {
      const action = [...snapshot.health, ...snapshot.needsYou]
        .flatMap((i) => i.actions)
        .find((a) => a.kind === kind)!;
      assert.ok(action, kind);
      await hub.act(f.team.id, action);
    }
    f.run.state = "paused";
    let fresh = await hub.snapshot(f.team.id);
    await hub.act(
      f.team.id,
      fresh.needsYou.flatMap((i) => i.actions).find((a) => a.kind === "retry")!,
    );
    f.run.state = "needs_human";
    f.run.gate = { kind: "clarify", message: "Choose" };
    fresh = await hub.snapshot(f.team.id);
    await hub.act(
      f.team.id,
      fresh.needsYou.flatMap((i) => i.actions).find((a) => a.kind === "skip")!,
    );
    assert.deepEqual(kinds, [
      "recover",
      "retry-check",
      "restart",
      "review-later",
      "retry",
      "skip",
    ]);
    const timeout = fresh.needsYou
      .flatMap((i) => i.actions)
      .find((a) => a.kind === "retry-check")!;
    t.check = { ...t.check, output: "Assertion failed", timedOut: false };
    await assert.rejects(hub.act(f.team.id, timeout), /unavailable/);
    assert.ok(
      f.teamStore
        .projectChatMessages(f.team.id)
        .filter((m) => m.text.includes("Action completed"))
        .every((m) => m.text.endsWith("Saved")),
    );
  } finally {
    f.close();
  }
});

test("roadmap review marker preserves branch note and skips automatic queue", async () => {
  const { markBacklogItem, openBacklogItems } =
    await import("../src/core/team/autopilot");
  const f = fixture();
  try {
    const content = "- [ ] Feature\n- [ ] Next\n";
    const marked = markBacklogItem(
      content,
      openBacklogItems(content)[0],
      "r",
      `(branch ${f.run.runBranch})`,
    );
    assert.match(marked, /\[r\] Feature \(branch kept\)/);
    assert.deepEqual(
      openBacklogItems(marked).map((i) => i.text),
      ["Next"],
    );
    const message = f.teamStore.projectChat(f.team.id, {
      author: "cobble",
      kind: "message",
      text: marked,
    });
    assert.equal(
      new TeamStore(f.store)
        .projectChatMessages(f.team.id)
        .find((m) => m.id === message.id)?.text,
      marked,
    );
  } finally {
    f.close();
  }
});


test("plain logs shows the latest run; promote replies in words", () => {
  assert.deepEqual(parseControlCommand("logs"), { kind: "logs", runId: "" });
  assert.deepEqual(parseControlCommand("what's waiting"), { kind: "needs-you" });
});

test("failed checks show as one plain line, and only when no one is working on them", async () => {
  const { checkSummary } = await import("../src/core/team/app-hub");
  const output = [
    "test at test/agent-team-debugger.test.ts:432:1",
    "\u2716 debugger member configuration rejects CLI agents (5649.3301ms)",
    "  Error: Unknown role",
    "    at TeamStore.validateMember (team-store.ts:299:13)",
    "\u2716 failing tests:",
    "\u2716 debugger member configuration rejects CLI agents (5649.3301ms)",
    "\u2716 Team Chat: agents post (36909.9238ms)",
  ].join("\n");
  assert.equal(
    checkSummary(output),
    "2 tests failed, first: \u201cdebugger member configuration rejects CLI agents\u201d.",
  );
  assert.equal(checkSummary("src/a.ts(1,2): error TS2304: x\nsrc/b.ts(3,4): error TS2551: y"), "Type errors (2).");
  assert.equal(checkSummary(""), "The check failed.");
});

test("no daemon alarm when nothing is left for it to drive", () => {
  const f = fixture();
  try {
    f.input.daemon = null;
    f.run.state = "done";
    assert.ok(!buildAppHubSnapshot(f.input).health.some((h) => h.id === "daemon"));
    f.run.state = "paused";
    f.input.ownerAlive = () => false;
    assert.ok(buildAppHubSnapshot(f.input).health.some((h) => h.id === "daemon"));
  } finally {
    f.close();
  }
});
