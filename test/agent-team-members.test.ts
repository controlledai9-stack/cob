import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { apply, plannerTurn } from "../src/core/team/planner-turn";
import type { OrchestratorContext } from "../src/core/team/orchestrator-context";
import type {
  AgentAdapter,
  AdapterRunInput,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), "cobble-team-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hello\n");
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
  return { root, work, trees: join(root, "trees") };
}

type Script = (
  input: AdapterRunInput,
  call: number,
) => Partial<AdapterResult> | Promise<Partial<AdapterResult>>;
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true, version: "fake" }),
    async run(input) {
      calls.push(input);
      const out = await script(input, calls.length);
      return { exitCode: 0, finalText: "", durationMs: 1, ...out };
    },
  };
  return { adapter, calls };
}
const actions = (body: object) =>
  "Thinking…\n```cobble-actions\n" + JSON.stringify(body) + "\n```";
function setup(
  planner: Script,
  workers: Partial<Record<TeamAgentId, Script>>,
  roles: Partial<Record<TeamRole, TeamAgentId>> = {
    planner: "claude",
    coder: "codex",
    generator: "gemini",
    deployer: "codex",
  },
  plan = "Build the landing page in `site/`\nDo not modify `legacy/`",
) {
  const r = repo();
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", plan, r.work);
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries(roles))
    teamStore.setRole(team.id, role as TeamRole, agent);
  const p = fake("claude", planner);
  const codex = fake("codex", workers.codex ?? (() => ({})));
  const gemini = fake("gemini", workers.gemini ?? (() => ({})));
  const adapters = {
    claude: p.adapter,
    codex: codex.adapter,
    gemini: gemini.adapter,
  };
  // A planner that is also a worker would share calls; keep them separate in tests.
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters,
    worktreeRoot: r.trees,
    team: (id) => store.team(id),
  });
  const attention: string[] = [];
  orchestrator.on("attention", (a: { message: string }) =>
    attention.push(a.message),
  );
  return {
    ...r,
    store,
    team,
    teamStore,
    orchestrator,
    attention,
    plannerCalls: p.calls,
    codexCalls: codex.calls,
    geminiCalls: gemini.calls,
    cleanup: async () => {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(r.root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    },
  };
}

const delegate = (id: string, role = "coder", member?: string) => ({
  type: "delegate",
  id,
  role,
  member,
  title: id,
  instructions: "Investigate",
  acceptance: [],
});
const done = { status: "done", summary: "Investigated", files: [] };
const reply = {
  finalText: "```cobble-report\n" + JSON.stringify(done) + "\n```",
};

test("(a) legacy roles migrate and a stored task without member finishes", async () => {
  const f = setup(
    () => ({
      finalText: actions({ actions: [{ type: "finish", summary: "done" }] }),
    }),
    { codex: () => reply },
    {},
  );
  try {
    for (const [role, agent] of [
      ["planner", "claude"],
      ["coder", "codex"],
    ])
      f.store.db
        .prepare("INSERT INTO team_roles VALUES(?,?,?)")
        .run(f.team.id, role, agent);
    f.store.set(`teamBackupAgents:${f.team.id}`, { coder: "gemini" });
    f.store.set(`teamFullAccess:${f.team.id}`, ["coder"]);
    const members = f.teamStore.members(f.team.id);
    assert.deepEqual(
      members.map((m) => m.name),
      ["planner1", "coder1"],
    );
    assert.equal(members[1].backup, "gemini");
    assert.equal(members[1].fullAccess, true);
    const run = await f.orchestrator.startRun(
      f.team.id,
      "legacy",
      {},
      {},
      { detach: true },
    );
    f.teamStore.saveTask({
      id: "T1",
      runId: run.id,
      role: "coder",
      agent: "codex",
      title: "legacy",
      instructions: "check",
      acceptance: [],
      dependsOn: [],
      state: "queued",
      attempt: 0,
      createdAt: new Date().toISOString(),
    });
    f.orchestrator.resume(run.id);
    await f.orchestrator.idle(run.id);
    assert.equal(f.teamStore.tasks(run.id)[0].state, "done");
    assert.equal(f.teamStore.tasks(run.id)[0].member, undefined);
  } finally {
    await f.cleanup();
  }
});

test("(b) two unnamed delegates select different members and run concurrently", async () => {
  let started = 0;
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  const f = setup(
    (_input, n) => ({
      finalText: actions({
        actions:
          n === 1
            ? [delegate("T1"), delegate("T2")]
            : [{ type: "finish", summary: "done" }],
      }),
    }),
    {
      codex: async (input) => {
        if (++started === 2) release();
        await Promise.race([
          both,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Both coder members did not start")),
              15_000,
            );
            both.then(() => clearTimeout(timer));
            input.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("Coder task aborted"));
              },
              { once: true },
            );
          }),
        ]);
        return reply;
      },
    },
  );
  try {
    f.teamStore.addMember(f.team.id, {
      name: "coder2",
      role: "coder",
      agent: "codex",
    });
    const run = await f.orchestrator.startRun(f.team.id, "parallel");
    await f.orchestrator.idle(run.id);
    assert.equal(started, 2);
    assert.deepEqual(
      f.teamStore.tasks(run.id).map((t) => t.member),
      ["coder1", "coder2"],
    );
    assert.match(f.plannerCalls[0].prompt, /## Team members/);
    assert.match(f.plannerCalls[0].prompt, /least-busy/);
    const chat = f.teamStore.chatMessages(run.id);
    assert.deepEqual(
      chat.filter((m) => m.kind === "delegate").map((m) => m.member),
      ["coder1", "coder2"],
    );
  } finally {
    release();
    await f.cleanup();
  }
});

test("(c) member mentions reach open questions or the planner when no task is open", async () => {
  const f = setup(
    () => ({
      finalText: actions({ actions: [{ type: "wait", reason: "test" }] }),
    }),
    {},
  );
  try {
    f.teamStore.addMember(f.team.id, {
      name: "coder2",
      role: "coder",
      agent: "codex",
    });
    const run = await f.orchestrator.startRun(
      f.team.id,
      "routing",
      {},
      {},
      { detach: true },
    );
    f.teamStore.saveTask({
      id: "T1",
      runId: run.id,
      role: "coder",
      member: "coder2",
      agent: "codex",
      title: "question",
      instructions: "",
      acceptance: [],
      dependsOn: [],
      state: "needs_decision",
      question: { text: "which?", options: [], delivered: false },
      attempt: 1,
      createdAt: new Date().toISOString(),
    });
    assert.equal(
      f.orchestrator.userMessage(run.id, "@coder2 choose A").to,
      "T1",
    );
    const task = f.teamStore.tasks(run.id)[0];
    assert.equal(task.state, "queued");
    task.state = "done";
    f.teamStore.saveTask(task);
    assert.equal(
      f.orchestrator.userMessage(run.id, "@coder2 hello").to,
      "planner",
    );
    assert.ok(
      f.teamStore
        .run(run.id)!
        .pendingNotes.some((n) =>
          n.includes('The user wrote to coder2 (no open task): "hello"'),
        ),
    );
    assert.equal(f.teamStore.run(run.id)!.wakeRequested, true);
    // A greeting and different capitals still reach the member.
    f.orchestrator.userMessage(run.id, "hey @Coder2, how is it going?");
    assert.ok(
      f.teamStore
        .run(run.id)!
        .pendingNotes.some((n) =>
          n.includes('The user wrote to coder2 (no open task): "how is it going?"'),
        ),
    );
  } finally {
    await f.cleanup();
  }
});

test("(d) researchers are read-only, never merge, and chat carries member", async () => {
  const f = setup(
    (_i, n) => ({
      finalText: actions({
        actions:
          n === 1
            ? [delegate("R1", "researcher", "researcher1")]
            : [{ type: "finish", summary: "done" }],
      }),
    }),
    { codex: () => reply },
    { planner: "claude", researcher: "codex" },
  );
  try {
    const run = await f.orchestrator.startRun(f.team.id, "research");
    await f.orchestrator.idle(run.id);
    const input = f.codexCalls[0];
    assert.equal(input.readOnly, true);
    assert.equal(input.fullAccess, false);
    assert.equal(input.network, false);
    assert.match(input.prompt, /never edit files/);
    const snap = f.teamStore.snapshot(run.id)!;
    assert.equal(snap.tasks[0].merged, undefined);
    assert.equal(snap.tasks[0].check, undefined);
    assert.equal(snap.tasks[0].worktree, undefined);
    assert.ok(
      f.teamStore
        .chatMessages(run.id)
        .some((m) => m.kind === "report" && m.member === "researcher1"),
    );
  } finally {
    await f.cleanup();
  }
});

test("member notes arriving during a planner turn still wake it", async () => {
  let started!: () => void;
  let release!: () => void;
  const thinking = new Promise<void>((resolve) => (started = resolve));
  const answer = new Promise<void>((resolve) => (release = resolve));
  const f = setup(async () => {
    started();
    await answer;
    return { finalText: actions({ actions: [{ type: "wait" }] }) };
  }, {});
  try {
    f.teamStore.addMember(f.team.id, {
      name: "coder2",
      role: "coder",
      agent: "codex",
    });
    const run = await f.orchestrator.startRun(
      f.team.id,
      "message",
      {},
      {},
      { detach: true },
    );
    const ctx = (f.orchestrator as unknown as { ctx: OrchestratorContext }).ctx;
    const turn = plannerTurn(ctx, run.id);
    await thinking;
    f.orchestrator.userMessage(run.id, "@coder2 investigate this");
    release();
    await turn;
    const fresh = f.teamStore.run(run.id)!;
    assert.equal(fresh.userWaiting, true);
    assert.equal(fresh.wakeRequested, true);
    assert.ok(
      fresh.pendingNotes.some((n) => n.startsWith("The user wrote to coder2")),
    );
  } finally {
    release();
    await f.cleanup();
  }
});

test("unnamed open tasks count toward the legacy role member's workload", async () => {
  const f = setup(() => ({}), {});
  try {
    f.teamStore.addMember(f.team.id, {
      name: "coder2",
      role: "coder",
      agent: "codex",
    });
    const run = await f.orchestrator.startRun(
      f.team.id,
      "legacy workload",
      {},
      {},
      { detach: true },
    );
    f.teamStore.saveTask({
      id: "T1",
      runId: run.id,
      role: "coder",
      agent: "codex",
      title: "legacy",
      instructions: "check",
      acceptance: [],
      dependsOn: [],
      state: "queued",
      attempt: 0,
      createdAt: new Date().toISOString(),
    });
    const ctx = (f.orchestrator as unknown as { ctx: OrchestratorContext }).ctx;
    await apply(ctx, run, {
      type: "delegate",
      id: "T2",
      role: "coder",
      title: "new",
      instructions: "check",
      acceptance: [],
      dependsOn: [],
    });
    assert.equal(
      f.teamStore.tasks(run.id).find((t) => t.id === "T2")!.member,
      "coder2",
    );
  } finally {
    await f.cleanup();
  }
});
