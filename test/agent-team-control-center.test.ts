import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import {
  parseControlCommand as parse,
  needsConfirmation,
  describeControlCommand,
  controlStatusText,
  controlQueueText,
  CONTROL_HELP,
} from "../src/core/team/control-commands";

test("control sources contain no encoding corruption", () => {
  const files = [
    ...readdirSync("src/core/team")
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("src/core/team", name)),
    ...readdirSync("src/renderer")
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => join("src/renderer", name)),
    "test/agent-team-control-center.test.ts",
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("\uFFFD"), file);
    assert.ok(!source.includes("\u00e2\u20ac"), file);
  }
});

test("curly apostrophes parse as status", () => {
  assert.deepEqual(parse("what\u2019s the status"), {
    kind: "status",
    details: false,
  });
});

test("control help uses em dashes", () => {
  assert.ok(CONTROL_HELP.includes("\u2014"));
});

test("control commands and wording variants", () => {
  const groups = {
    status: [
      "status",
      "state",
      "progress",
      "what's the status",
      "how are we doing",
      "Hey Cobble, PLEASE status now!",
    ],
    queue: ["queue", "backlog", "what's next", "show queue"],
    help: ["help", "commands", "?"],
    stop: [
      "stop",
      "pause",
      "halt",
      "stop all",
      "pause everything",
      "halt autopilot",
      "stop pilot",
    ],
    continue: ["continue", "resume", "unpause", "carry on"],
    promote: ["promote", "promote now", "self-check", "merge"],
  };
  for (const [kind, variants] of Object.entries(groups))
    for (const text of variants) {
      const command = parse(text);
      assert.equal(command?.kind, kind, text);
      assert.equal(
        needsConfirmation(command!),
        ["stop", "continue", "promote"].includes(kind),
      );
      assert.ok(describeControlCommand(command!));
    }
  for (const verb of ["start autopilot", "run autopilot", "autopilot start"]) {
    assert.deepEqual(parse(verb), { kind: "autopilot", parallel: 1 });
    for (let n = 1; n <= 4; n++)
      for (const arg of [`${n} at a time`, `x${n}`, `with ${n}`]) {
        const command = parse(`${verb} ${arg}`)!;
        assert.deepEqual(command, { kind: "autopilot", parallel: n });
        assert.equal(needsConfirmation(command), true);
      }
  }
  for (const verb of [
    "pilot until",
    "pilot till",
    "start pilot until",
    "start pilot till",
  ]) {
    assert.deepEqual(parse(`${verb} 2028-02-29`), {
      kind: "pilot",
      until: "2028-02-29",
    });
  }
  assert.equal(
    describeControlCommand({ kind: "autopilot", parallel: 2 }),
    "Start Autopilot, 2 items at a time?",
  );
  assert.match(
    describeControlCommand({ kind: "pilot", until: "2028-02-29" }),
    /resets the session spend window/,
  );
  assert.match(CONTROL_HELP, /confirmation required/);
});

test("recognised bad arguments are invalid; extra prose and gate words fall through", () => {
  for (const text of [
    "start autopilot 5 at a time",
    "run autopilot x0",
    "autopilot start with -1",
    "start autopilot x1.5",
    "pilot until 2026-13-40",
    "pilot until 2026-02-29",
    "pilot till 2026-04-31",
  ]) {
    const command = parse(text)!;
    assert.equal(command.kind, "invalid", text);
    assert.equal(needsConfirmation(command), false);
  }
  for (const text of [
    "",
    "approve",
    "deny",
    "deploy",
    "sign in",
    "login",
    "skip",
    "done",
    "yes",
    "ok",
    "lgtm",
    "go ahead",
    "do it",
    "@planner start:",
    "@planner start: build this",
    "merge this branch",
    "start autopilot with bananas",
    "start autopilot 2 at a time thanks",
    "stop the server",
    "status of the project",
    "x".repeat(81),
  ])
    assert.equal(parse(text), null, text);
});

test("queue and status are bounded and report unknown usage", () => {
  assert.equal(controlQueueText([]), "The backlog has no open items.");
  assert.equal(controlQueueText(["A\nB", "C"]), "1. A B\n2. C");
  assert.equal(controlQueueText(Array(20).fill("item")).split("\n").length, 15);
  const input = {
    runs: [
      {
        id: "r1",
        state: "running",
        goal: "Build",
        tasks: [{ id: "T1", title: "Code", state: "running" }],
      },
    ],
    autopilot: {
      active: true,
      pilot: true,
      parallel: 2,
      currentItem: "Build",
      stoppedReason: "waiting",
    },
    daemon: { running: true, pid: 42 },
    queue: ["Next"],
    lastMerges: ["Merged change"],
  };
  const result = controlStatusText(input);
  assert.ok(result.includes("Run r1: running \u2014 Build"));
  assert.ok(result.includes("T1: running \u2014 Code"));
  for (const text of [
    "r1",
    "T1",
    "Code",
    "Build",
    "42",
    "Next",
    "Merged change",
    "unknown",
  ])
    assert.ok(result.includes(text), text);
  assert.match(
    controlStatusText({ ...input, usage: { tokens: 0, costUsd: 0 } }),
    /tokens 0; \$0\.00 estimated API cost/,
  );
  assert.ok(
    controlStatusText({ ...input, runs: Array(30).fill(input.runs[0]) }).split(
      "\n",
    ).length <= 15,
  );
});

test("control cards and proposal items round-trip through TeamStore", () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("Owner", "");
    const team = store.createTeam("Team", "Build", process.cwd());
    const teams = new TeamStore(store);
    const card = teams.projectChat(team.id, {
      author: "cobble",
      kind: "control",
      text: "Stop?",
      control: { command: { kind: "stop" }, status: "pending" },
    });
    const proposal = teams.projectChat(team.id, {
      author: "agent",
      kind: "proposal",
      text: "Work",
      proposal: { goal: "Work", items: ["A", "B"], status: "open" },
    });
    assert.deepEqual(new TeamStore(store).projectChatMessages(team.id), [
      card,
      proposal,
    ]);
    const control = {
      command: { kind: "stop" as const },
      status: "done" as const,
      result: "Stopped",
    };
    assert.deepEqual(
      teams.updateProjectChatControl(team.id, card.id, control)?.control,
      control,
    );
    teams.updateProjectChatProposal(team.id, proposal.id, {
      goal: "Work",
      items: ["A", "B"],
      status: "added",
    });
    const saved = new TeamStore(store).projectChatMessages(team.id);
    assert.deepEqual(saved[0].control, control);
    assert.equal(saved[1].proposal?.status, "added");
    assert.deepEqual(saved[1].proposal?.items, ["A", "B"]);
    assert.equal(
      teams.updateProjectChatControl(team.id, proposal.id, control),
      null,
    );
    assert.equal(
      teams.updateProjectChatControl("other", card.id, control),
      null,
    );
    assert.equal(
      teams.updateProjectChatControl(team.id, "missing", control),
      null,
    );
  } finally {
    store.close();
  }
});

import {
  ControlCenter,
  type ControlCenterDeps,
  type StoppedSession,
} from "../src/core/team/control-center";
import { ProjectChat } from "../src/core/team/project-chat";
import type { TeamRun } from "../src/core/team/types";
import type { AutopilotOptions, AutopilotStatus } from "../src/shared/types";
import { CobbleService } from "../src/core/service";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../src/core/team/adapters";
import { PassThrough } from "node:stream";
import { runChatCommand } from "../src/core/team/chat-cli";

function controlFixture() {
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", "Build it", process.cwd());
  const teamStore = new TeamStore(store);
  const calls: string[] = [];
  const chat = new ProjectChat({
    teamStore,
    team: (id) => store.team(id),
    backlog: async () => "",
    plannerAdapter: () => ({
      agent: "codex",
      adapter: {
        id: "codex",
        detect: async () => ({ agent: "codex", installed: true }),
        run: async (input) => {
          calls.push(input.prompt);
          return { exitCode: 0, durationMs: 1, finalText: "Planner answer" };
        },
      },
    }),
  });
  let stopped: StoppedSession | null = null;
  const status: AutopilotStatus = {
    active: false,
    branch: "a",
    worktree: "",
    backlogPath: "docs/BACKLOG.md",
    completed: [],
  };
  const options: AutopilotOptions = {
    parallel: 2,
    maxRuns: 8,
    detach: false,
    checkCommand: "npm test",
    pilot: true,
  };
  const deps: ControlCenterDeps = {
    teamStore,
    projectChat: chat,
    runs: (id) => teamStore.runs(id),
    status: async () => "Ready",
    queue: async () => [],
    autopilotStatus: () => status,
    autopilotOptions: () => options,
    stopped: () => stopped,
    saveStopped: (_, value) => {
      stopped = value;
    },
    stopAutopilot: () => {
      calls.push("stop");
      status.active = false;
    },
    runCommand: async (_, id, command) => {
      calls.push(command);
      const run = teamStore.run(id)!;
      run.state = command === "pause" ? "paused" : "running";
      teamStore.saveRun(run);
    },
    waitForRun: async () => {
      calls.push("wait");
    },
    completeAutopilotRun: async () => {
      calls.push("complete");
    },
    startAutopilot: async (_, o) => {
      calls.push("start:" + JSON.stringify(o));
    },
    saveSessionBrief: () => {
      calls.push("brief");
    },
    detachAvailable: false,
    now: () => Date.UTC(2026, 10, 16),
  };
  return {
    store,
    team,
    teamStore,
    calls,
    status,
    options,
    deps,
    center: new ControlCenter(deps),
  };
}
async function confirmCommand(
  f: ReturnType<typeof controlFixture>,
  text: string,
) {
  const outcome = await f.center.handle(f.team.id, text);
  assert.equal(outcome.type, "confirm");
  return f.center.confirm(f.team.id, outcome.message.id, true);
}

test("unknown control text reaches fake planner once; confirmation and cancellation have no effects", async () => {
  const f = controlFixture();
  try {
    const reply = await f.center.handle(
      f.team.id,
      "Explain the current design",
    );
    assert.equal(reply.type, "planner");
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.teamStore
        .projectChatMessages(f.team.id)
        .filter((m) => m.author === "user").length,
      1,
    );
    f.calls.length = 0;
    const stop = await f.center.handle(f.team.id, "stop");
    assert.equal(stop.type, "confirm");
    assert.deepEqual(f.calls, []);
    assert.equal(
      (await f.center.confirm(f.team.id, stop.message.id, false)).control
        ?.status,
      "cancelled",
    );
    assert.deepEqual(f.calls, []);
    await assert.rejects(
      f.center.confirm(f.team.id, stop.message.id, true),
      /already handled/,
    );
  } finally {
    f.store.close();
  }
});

test("continue completes owned runs before restarting identical Autopilot options", async () => {
  const f = controlFixture();
  try {
    const run = {
      id: "scripted",
      teamId: f.team.id,
      state: "running",
      goal: "Keep work",
      updatedAt: new Date().toISOString(),
    } as TeamRun;
    f.teamStore.saveRun(run);
    f.status.active = true;
    f.status.currentRuns = [{ runId: run.id, item: "Keep work" }];
    await confirmCommand(f, "stop");
    assert.equal(f.teamStore.run(run.id)?.state, "paused");
    let finish!: () => void;
    f.deps.waitForRun = async () => {
      f.calls.push("wait");
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    await confirmCommand(f, "continue");
    assert.equal(f.teamStore.run(run.id)?.state, "running");
    assert.ok(!f.calls.includes("complete"));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls.slice(-3), [
      "wait",
      "complete",
      "start:" + JSON.stringify(f.options),
    ]);
    assert.equal(f.deps.stopped(f.team.id), null);
    assert.equal(f.teamStore.run(run.id)?.goal, "Keep work");
  } finally {
    f.store.close();
  }
});

test("past pilot dates are invalid and promotion stays guarded until completion", async () => {
  const f = controlFixture();
  try {
    const past = await f.center.handle(f.team.id, "pilot until 2020-01-01");
    assert.equal(past.type, "result");
    assert.equal(past.message.control?.command.kind, "invalid");
    assert.deepEqual(f.calls, []);
    let finish!: () => void;
    f.deps.promoteTeam = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    assert.equal(
      (await confirmCommand(f, "promote")).control?.result,
      "Promotion started",
    );
    const second = await f.center.handle(f.team.id, "promote");
    if (second.type === "planner") throw new Error("Expected card");
    assert.equal(second.message.control?.result, "Already in progress");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    f.store.close();
  }
});

async function serviceFixture() {
  const root = mkdtempSync(join(tmpdir(), "cobble-controls-"));
  const work = join(root, "work");
  mkdirSync(work);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hello\n");
  mkdirSync(join(work, "docs"));
  writeFileSync(join(work, "docs/BACKLOG.md"), "# Backlog\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const calls: string[] = [];
  let reply = "Answer";
  const adapter: AgentAdapter = {
    id: "codex",
    detect: async () => ({ agent: "codex", installed: true }),
    run: async (input) => {
      calls.push(input.prompt);
      if (!input.prompt.includes("ONE read-only turn"))
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve();
          else
            input.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
      return {
        exitCode: 0,
        durationMs: 1,
        finalText: input.readOnly
          ? reply
          : '```cobble-actions\n{"actions":[{"type":"wait"}]}\n```',
      };
    },
  };
  const service = new CobbleService(join(root, "service.sqlite"), undefined, {
    teamWorktreeRoot: join(root, "trees"),
    teamAdapters: { codex: adapter },
  });
  service.store.saveProfile("Owner", "");
  const team = service.store.createTeam("Team", "Build the app", work);
  service.store.set("activeTeamId", team.id);
  service.teamStore.setRole(team.id, "planner", "codex");
  service.teamStore.setRole(team.id, "coder", "codex");
  return {
    service,
    team,
    calls,
    reply: (text: string) => {
      reply = text;
    },
    close: async () => {
      await service.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows locks */
      }
    },
  };
}

test(
  "scripted service run stops and continues without losing its chat or goal; gates stay unresolved",
  { timeout: 30000 },
  async () => {
    const f = await serviceFixture();
    try {
      const run = await f.service.startTeamRun("Keep the scripted work");
      await f.service.sendTeamChat(run.id, "Remember the footer");
      const stop = await f.service.sendTeamChat(run.id, "stop");
      assert.equal(stop.needsConfirm, true);
      assert.equal(f.service.teamRun(run.id).run.state, "running");
      await f.service.confirmTeamControl(stop.control!.id, true);
      assert.equal(f.service.teamRun(run.id).run.state, "paused");
      const resume = await f.service.sendTeamChat(run.id, "continue");
      await f.service.confirmTeamControl(resume.control!.id, true);
      assert.equal(f.service.teamRun(run.id).run.state, "running");
      assert.equal(
        f.service.teamRun(run.id).run.goal,
        "Keep the scripted work",
      );
      // A plain message is a conversation with Cobble (kept in the project
      // chat); the run's own chat keeps everything else.
      assert.ok(
        [...f.service.teamChat(run.id), ...f.service.teamProjectChat()].some(
          (m) => m.text === "Remember the footer",
        ),
      );
      const gated = f.service.teamRun(run.id).run;
      gated.state = "needs_human";
      gated.gate = {
        kind: "approval",
        message: "Deploy needs approval",
      } as NonNullable<TeamRun["gate"]>;
      f.service.teamStore.saveRun(gated);
      for (const text of ["approve", "yes", "continue"]) {
        const outcome = await f.service.teamControl(text);
        if (outcome.type === "confirm")
          await f.service.confirmTeamControl(outcome.message.id, true);
        await f.service.sendTeamChat(run.id, text);
        assert.equal(f.service.teamRun(run.id).run.state, "needs_human");
        assert.deepEqual(f.service.teamRun(run.id).run.gate, gated.gate);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "roadmap reply adds to backlog and starts two independent proposal items",
  { timeout: 30000 },
  async () => {
    const f = await serviceFixture();
    try {
      f.reply(
        "Suggested work\n```cobble-roadmap\n- [ ] First feature \u2014 done when: first feature tests pass\n- [ ] Second feature \u2014 done when: second feature tests pass\n```",
      );
      const result = await f.service.teamControl("Suggest some work");
      assert.equal(result.type, "planner");
      if (result.type !== "planner") throw new Error("Expected planner");
      const proposal = result.proposal!;
      assert.equal(proposal.proposal?.items?.length, 2);
      assert.equal(
        (await f.service.addTeamProposalToBacklog(proposal.id)).proposal
          ?.status,
        "added",
      );
      const items = proposal.proposal!.items!;
      const first = await f.service.startTeamProposalItem(
        proposal.id,
        items[0],
      );
      await f.service.teamRunCommand(first.id, "stop");
      const second = await f.service.startTeamProposalItem(
        proposal.id,
        items[1],
      );
      assert.equal(second.goal, items[1]);
      assert.notEqual(first.id, second.id);
      const saved = f.service
        .teamProjectChat()
        .find((m) => m.id === proposal.id)!.proposal!;
      assert.deepEqual(saved.itemRunIds, {
        [items[0]]: first.id,
        [items[1]]: second.id,
      });
      await assert.rejects(
        f.service.startTeamProposalItem(proposal.id, items[0]),
        /already started/,
      );
    } finally {
      await f.close();
    }
  },
);

test("service refusals fail the card and a stopping session keeps its restoration record", async () => {
  const f = controlFixture();
  try {
    const pending = await f.center.handle(
      f.team.id,
      "start autopilot 3 at a time",
    );
    assert.equal(pending.type, "confirm");
    assert.deepEqual(f.calls, []);
    f.deps.startAutopilot = async () => {
      throw new Error("Finish the current run first");
    };
    if (pending.type !== "confirm") throw new Error("Expected confirmation");
    const failure = await f.center.confirm(f.team.id, pending.message.id, true);
    assert.equal(failure.control?.status, "failed");
    assert.equal(failure.control?.result, "Finish the current run first");
    f.deps.saveStopped(f.team.id, { autopilot: f.options, runs: [] });
    f.status.active = true;
    const stopping = await confirmCommand(f, "continue");
    assert.match(stopping.control!.result!, /still stopping/);
    assert.deepEqual(f.deps.stopped(f.team.id)?.autopilot, f.options);
    assert.deepEqual(f.calls, []);
  } finally {
    f.store.close();
  }
});

async function scriptedChat(
  service: CobbleService,
  text: string,
  project?: string,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => {
    transcript += chunk.toString();
  });
  const chat = runChatCommand(service, { project }, { input, output });
  input.end(text);
  await chat;
  return transcript;
}

test("chat REPL reports stored runs, automation, daemon and queue from a file database", async () => {
  const f = await serviceFixture();
  try {
    f.service.teamStore.saveRun({
      id: "repl-status-run",
      teamId: f.team.id,
      goal: "Show the stored work",
      state: "paused",
      updatedAt: new Date().toISOString(),
    } as TeamRun);
    const transcript = await scriptedChat(
      f.service,
      "status details\nstatus\nquit\n",
    );
    assert.match(transcript, /cobble> /);
    assert.match(transcript, /Run repl-status-run: paused/);
    assert.match(transcript, /Show the stored work/);
    assert.match(transcript, /Autopilot: inactive; Pilot: inactive/);
    assert.match(transcript, /Daemon: stopped/);
    assert.match(transcript, /Backlog: 0 open items/);
    assert.match(transcript, /Usage: tokens unknown; unknown/);
    assert.match(transcript, /Working: nothing right now\./);
    assert.match(transcript, /Problems: 1 run is paused/);
    assert.ok(
      f.service.teamProjectChat().some((message) => message.text === "status details"),
    );
  } finally {
    await f.close();
  }
});

test("chat --project selects a case-insensitive name and lists names on unknown projects", async () => {
  const f = await serviceFixture();
  try {
    const other = f.service.store.createTeam(
      "Other Project",
      "Other work",
      f.team.workspace,
    );
    await scriptedChat(f.service, "quit\n", "oThEr PrOjEcT");
    assert.equal(f.service.activeTeam()?.id, other.id);
    await assert.rejects(
      scriptedChat(f.service, "quit\n", "missing"),
      /Unknown project "missing".*Team.*Other Project/,
    );
    assert.equal(f.service.activeTeam()?.id, other.id);
  } finally {
    await f.close();
  }
});

test("approve typed in the chat REPL cannot resolve a stored approval gate", async () => {
  const f = await serviceFixture();
  try {
    const gate = {
      kind: "approval",
      message: "Deploy needs approval",
    } as NonNullable<TeamRun["gate"]>;
    f.service.teamStore.saveRun({
      id: "repl-gated-run",
      teamId: f.team.id,
      goal: "Wait for approval",
      state: "needs_human",
      gate,
      updatedAt: new Date().toISOString(),
    } as TeamRun);
    await scriptedChat(f.service, "approve\nquit\n");
    assert.equal(
      f.service.teamStore.run("repl-gated-run")?.state,
      "needs_human",
    );
    assert.deepEqual(f.service.teamStore.run("repl-gated-run")?.gate, gate);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("stop executes while a promotion is in flight", async () => {
  const f = controlFixture();
  let finish!: () => void;
  try {
    f.deps.promoteTeam = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await confirmCommand(f, "promote");
    assert.equal((await confirmCommand(f, "stop")).control?.status, "done");
    assert.ok(f.calls.includes("stop"));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    f.store.close();
  }
});

for (const outcome of ["failed", "stopped", "reject"] as const) {
  test(`resumed run ${outcome} clears restoration without restarting or ticking`, async () => {
    const f = controlFixture();
    try {
      const run = {
        id: "failed-resume",
        teamId: f.team.id,
        state: "paused",
        goal: "Keep open",
        updatedAt: new Date().toISOString(),
      } as TeamRun;
      f.teamStore.saveRun(run);
      f.deps.saveStopped(f.team.id, {
        autopilot: f.options,
        runs: [{ runId: run.id, item: run.goal }],
      });
      f.deps.waitForRun = async () => {
        if (outcome === "reject") throw new Error("wait failed");
        return { ...run, state: outcome };
      };
      await confirmCommand(f, "continue");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.deps.stopped(f.team.id), null);
      assert.ok(!f.calls.includes("complete"));
      assert.ok(!f.calls.some((c) => c.startsWith("start:")));
      assert.ok(
        f.teamStore
          .projectChatMessages(f.team.id)
          .some(
            (m) =>
              m.author === "cobble" &&
              /failed-resume/.test(m.text) &&
              /Autopilot was not restarted/.test(m.text),
          ),
      );
    } finally {
      f.store.close();
    }
  });
}

test("stop overwrites stale options with the live pilot options", async () => {
  const f = controlFixture();
  try {
    f.deps.saveStopped(f.team.id, {
      autopilot: { parallel: 1, maxRuns: 1 },
      runs: [],
    });
    f.status.active = true;
    f.status.pilot = true;
    await confirmCommand(f, "stop");
    assert.deepEqual(f.deps.stopped(f.team.id)?.autopilot, f.options);
  } finally {
    f.store.close();
  }
});

test("planner roadmap prompt is UTF-8 without mojibake", async () => {
  const f = controlFixture();
  try {
    await f.center.handle(f.team.id, "Suggest work");
    assert.ok(!f.calls[0].includes("\u00e2\u20ac"));
    assert.ok(f.calls[0].includes("X \u2014 done when: Y"));
  } finally {
    f.store.close();
  }
});

test("service completes a done run into a real autopilot worktree and ticks its item", async () => {
  const f = await serviceFixture();
  try {
    const work = f.team.workspace!;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
    writeFileSync(
      join(work, "docs/BACKLOG.md"),
      "# Backlog\n- [ ] Ship feature\n",
    );
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "backlog",
    );
    await f.service["autopilot"].prepare(f.team.id);
    git("checkout", "-qb", "finished-feature");
    writeFileSync(join(work, "feature.txt"), "implemented\n");
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "feature",
    );
    git("checkout", "main");
    const run = {
      id: "done-feature",
      teamId: f.team.id,
      state: "done",
      goal: "Ship feature",
      baseBranch: "main",
      runBranch: "finished-feature",
      updatedAt: new Date().toISOString(),
    } as TeamRun;
    f.service.teamStore.saveRun(run);
    f.service.store.set(`teamControlStopped:${f.team.id}`, {
      autopilot: {},
      runs: [{ runId: run.id, item: run.goal }],
    });
    assert.equal(
      (await f.service.completeAutopilotRun(run.id)).status,
      "merged",
    );
    const path = f.service["autopilot"].path(f.team.id);
    assert.match(
      readFileSync(join(path, "docs/BACKLOG.md"), "utf8"),
      /\[x\] Ship feature/,
    );
    assert.equal(
      readFileSync(join(path, "feature.txt"), "utf8").trim(),
      "implemented",
    );
  } finally {
    await f.close();
  }
});

test("stopAutopilot stays active until a later tick; continue waits then succeeds", async () => {
  const f = await serviceFixture();
  try {
    // An empty backlog keeps the loop deterministic: preparation returns before its next tick.
    await f.service.startAutopilot({ maxRuns: 1 });
    const stop = await f.service.teamControl("stop");
    assert.equal(stop.type, "confirm");
    if (stop.type !== "confirm") throw new Error("Expected confirmation");
    await f.service.confirmTeamControl(stop.message.id, true);
    assert.equal(f.service.autopilotStatus().active, true);
    const first = await f.service.teamControl("continue");
    if (first.type !== "confirm") throw new Error("Expected confirmation");
    assert.match(
      (await f.service.confirmTeamControl(first.message.id, true)).control!
        .result!,
      /still stopping/,
    );
    await f.service["autopilotSessions"].get(f.team.id)!.work;
    assert.equal(f.service.autopilotStatus().active, false);
    const later = await f.service.teamControl("continue");
    if (later.type !== "confirm") throw new Error("Expected confirmation");
    assert.match(
      (await f.service.confirmTeamControl(later.message.id, true)).control!
        .result!,
      /resumed/,
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await f.close();
  }
});

test("confirm guards a message while allowing a separate stop card", async () => {
  const f = controlFixture();
  try {
    f.teamStore.saveRun({
      id: "pause-guard",
      teamId: f.team.id,
      state: "running",
      goal: "Work",
      updatedAt: new Date().toISOString(),
    } as TeamRun);
    let finish!: () => void;
    f.deps.runCommand = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    const card = await f.center.handle(f.team.id, "stop");
    if (card.type !== "confirm") throw new Error("Expected confirmation");
    const pending = f.center.confirm(f.team.id, card.message.id, true);
    await assert.rejects(
      f.center.confirm(f.team.id, card.message.id, true),
      /Already in progress/,
    );
    assert.equal((await f.center.handle(f.team.id, "stop")).type, "confirm");
    finish();
    await pending;
  } finally {
    f.store.close();
  }
});

test("status and queue show short item names, not whole backlog paragraphs", async () => {
  const { controlQueueText, shortLabel } = await import("../src/core/team/control-commands");
  const long = `Usage limits per AI, stop at 95% instead of crashing into the limit: ${"track usage. ".repeat(80)}`;
  assert.equal(shortLabel(long), "Usage limits per AI, stop at 95% instead of crashing into the limit");
  assert.equal(shortLabel("Backlog item: Token efficiency 2 — context diet: more"), "Token efficiency 2");
  assert.ok(shortLabel("x".repeat(300)).length <= 90);
  const queue = controlQueueText([long]);
  assert.ok(queue.length < 120, queue);
});


test("plain status: five short lines, no ids, details on request", async () => {
  const { controlStatusPlain } = await import(
    "../src/core/team/control-commands"
  );
  const text = controlStatusPlain({
    runs: [
      {
        id: "7bf85efa-aa83-4a27-899f-e3aa867ca80c",
        state: "running",
        goal: "Backlog item: Debug specialist: an optional debugger member",
        tasks: [
          { id: "T1", title: "Build the debugger loop", state: "running", agent: "codex" },
          { id: "T2", title: "Deploy preview", state: "needs_human", agent: "codex", gate: { message: "Approve a production deploy to Netlify" } },
        ],
      },
    ],
    autopilot: { active: true, parallel: 2 },
    daemon: { running: true, pid: 1 },
    queue: ["Research mode, part 1 \u2014 sources and a research library: long text"],
    lastMerges: [],
    usage: { tokens: 123456 },
  });
  const lines = text.split("\n");
  assert.equal(lines.length, 5);
  assert.equal(lines[0], "Working: Codex is working on \u201cBuild the debugger loop\u201d.");
  assert.equal(lines[1], "Waiting for you: Approve a production deploy to Netlify");
  assert.equal(lines[2], "Automation: Autopilot is on, 2 items at a time.");
  assert.equal(lines[3], "Next: Research mode, part 1.");
  assert.equal(lines[4], "Problems: none.");
  assert.doesNotMatch(text, /7bf85efa|123456|T1/);
  assert.deepEqual(parse("status details"), { kind: "status", details: true });
  assert.deepEqual(parse("full status"), { kind: "status", details: true });
  assert.deepEqual(parse("status"), { kind: "status", details: false });
});

test("questions about what the agents are doing get the instant status", () => {
  for (const text of [
    "planner codex is working on what",
    "@planner what is codex working on?",
    "what is codex doing",
    "what are the agents doing right now",
    "what's happening",
    "who is working",
  ])
    assert.deepEqual(parse(text), { kind: "status", details: false }, text);
  for (const text of [
    "what should codex work on next",
    "make codex work on the login page",
  ])
    assert.equal(parse(text), null, text);
});

test("greetings and 'tell me' still get the instant status", () => {
  for (const text of [
    "hey planner, tell me what's happening",
    "hi, what is codex doing?",
    "planner, can you tell me what's going on",
  ])
    assert.deepEqual(parse(text), { kind: "status", details: false }, text);
});

test("continue with nothing stopped resumes paused runs and explains usage-limit waits", async () => {
  const f = controlFixture();
  try {
    f.teamStore.saveRun({ id: "mine", teamId: f.team.id, state: "paused", goal: "A", updatedAt: new Date().toISOString() } as TeamRun);
    f.teamStore.saveRun({ id: "limited", teamId: f.team.id, state: "paused", goal: "B", retryAt: "2026-11-20T00:45:00.000Z", updatedAt: new Date().toISOString() } as TeamRun);
    const done = await confirmCommand(f, "continue");
    assert.match(done.control!.result!, /Resumed 1 paused run\./);
    assert.match(done.control!.result!, /1 run waits for a usage limit until .* and resumes on its own\./);
    assert.equal(f.teamStore.run("mine")!.state, "running");
    assert.equal(f.teamStore.run("limited")!.state, "paused");
    assert.doesNotMatch(done.control!.result!, /no stopped session/);
  } finally {
    f.store.close();
  }
});

test("questions about limits get a direct answer from usage data", async () => {
  const { controlLimitsText } = await import("../src/core/team/control-commands");
  for (const text of ["planner which agents are at there limit ?", "limits", "usage", "who is at the limit", "@planner how much usage is left"])
    assert.deepEqual(parse(text), { kind: "limits" }, text);
  assert.equal(parse("raise the limit to 10"), null);
  const now = Date.UTC(2026, 10, 20, 0, 0);
  const text = controlLimitsText(
    {
      stopAt: 95,
      agents: [
        { agent: "claude", percent: 12, source: "reported", windowHours: 5, resetsAt: "2026-11-20T03:00:00.000Z", stopped: false },
        { agent: "codex", percent: 132.4, source: "estimated", windowHours: 5, resetsAt: "2026-11-20T00:45:00.000Z", stopped: true },
        { agent: "gemini", percent: null, source: "estimated", windowHours: null, resetsAt: null, stopped: false },
      ],
    },
    ["codex", "claude"],
    now,
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "1 agent is at the limit (Cobble stops new work at 95%).");
  assert.match(lines[1]!, /^Codex: at its limit, 132% of its 5-hour limit \(estimated\)\. New work waits until /);
  assert.match(lines[2]!, /^Claude: 12% of its 5-hour limit, resets at /);
  assert.equal(lines.length, 3, "unused agents without usage are left out");
});

test("priority: sets the session priority from the chat, no confirmation", async () => {
  for (const [text, want] of [
    ["priority: dark mode and a settings page", "dark mode and a settings page"],
    ["new priorities: Faster startup", "Faster startup"],
    ["set the priority to export reports as PDF", "export reports as PDF"],
    ["@planner priority — mobile layout", "mobile layout"],
  ] as const)
    assert.deepEqual(parse(text), { kind: "priority", text: want }, text);
  assert.equal(parse("priority: x")!.kind, "invalid");
  assert.equal(parse("what is the priority of this task?"), null);
  const f = controlFixture();
  const saved: unknown[] = [];
  f.deps.saveSessionBrief = (_, input) => {
    saved.push(input);
    return { endDate: "2026-12-01" };
  };
  try {
    const outcome = await f.center.handle(f.team.id, "priority: Dark mode everywhere");
    assert.equal(outcome.type, "result");
    assert.deepEqual(saved, [{ priority: "Dark mode everywhere" }]);
    const text = outcome.type === "result" ? outcome.message.control?.result ?? outcome.message.text : "";
    assert.match(text, /Pilot now plans toward: Dark mode everywhere/);
    assert.match(text, /pilot until 2026-12-01/);
  } finally {
    f.store.close();
  }
});

test("status says what to do when everything in the backlog is done", async () => {
  const { controlStatusPlain } = await import("../src/core/team/control-commands");
  const base = { runs: [], autopilot: { active: false }, daemon: { running: false }, lastMerges: [], usage: {} };
  const done = controlStatusPlain({ ...base, queue: [] } as never);
  assert.match(done, /everything in the backlog is done.*priority: .*pilot until/);
  const waiting = controlStatusPlain({ ...base, queue: ["Add tests — done when: x"] } as never);
  assert.match(waiting, /Say “start autopilot”/);
});

test("review policy and the local helper can be set from the chat", async () => {
  assert.deepEqual(parse("review always"), { kind: "review-policy", policy: "always" });
  assert.deepEqual(parse("set review policy to risky"), { kind: "review-policy", policy: "risky" });
  assert.deepEqual(parse("helpers on"), { kind: "helpers", model: "on" });
  assert.deepEqual(parse("Helpers OFF"), { kind: "helpers", model: "off" });
  assert.deepEqual(parse("helper model qwen2.5-Coder:1.5b"), { kind: "helpers", model: "qwen2.5-Coder:1.5b" });
  assert.equal(parse("please review the login code"), null, "ordinary requests still reach Cobble");
  const f = controlFixture();
  const calls: string[] = [];
  f.deps.setReviewPolicy = (_, p) => (calls.push(`review:${p}`), p);
  f.deps.setHelpers = (_, m) => (calls.push(`helpers:${m}`), { model: m === "off" ? null : m === "on" ? "qwen2.5-coder:1.5b" : m });
  try {
    const text = async (t: string) => {
      const outcome = await f.center.handle(f.team.id, t);
      assert.equal(outcome.type, "result", t);
      return outcome.type === "result" ? outcome.message.control?.result ?? outcome.message.text : "";
    };
    assert.match(await text("review never"), /Review policy: never/);
    assert.match(await text("helpers on"), /Local helper on: qwen2\.5-coder:1\.5b.*ollama pull/);
    assert.match(await text("helpers off"), /Local helper off/);
    assert.deepEqual(calls, ["review:never", "helpers:on", "helpers:off"]);
  } finally {
    f.store.close();
  }
});
