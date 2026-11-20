import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { apiAdapters, normalizeModelConfig } from "../src/core/team/api-agent";
import type { AdapterRunInput, AgentAdapter } from "../src/core/team/adapters";
import { usageBreakdown } from "../src/core/team/usage-report";
import type { TeamMemberInput } from "../src/core/team/types";

const actions = (action: object) =>
  "```cobble-actions\n" + JSON.stringify({ actions: [action] }) + "\n```";
const read = (path: string) => readFileSync(path, "utf8");
const chat = (message: object, finish = "stop") =>
  Response.json({
    choices: [
      { message: { role: "assistant", ...message }, finish_reason: finish },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });

/** Every model request is handled in process; no listening socket or Ollama. */
function fixture(
  mode: "repair" | "unfixable" | "absent" | "unavailable" | "cancel",
) {
  const root = mkdtempSync(join(tmpdir(), "cobble-debugger-"));
  const work = join(root, "work");
  const evidence = join(root, "checks.jsonl");
  mkdirSync(work);
  writeFileSync(join(work, "value.txt"), "initial\n");
  // Evidence lives outside git so capture/merge cannot manufacture check runs.
  writeFileSync(
    join(work, "check.cjs"),
    `const fs = require('node:fs');
const value = fs.readFileSync('value.txt', 'utf8').trim();
fs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify({cwd: process.cwd(), value}) + '\\n');
console.log('CHECK_VALUE=' + value);
process.exit(value === 'fixed' ? 0 : 1);
`,
  );
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
  const team = store.createTeam("T", "Repair `value.txt` only", work);
  const teamStore = new TeamStore(store);
  teamStore.setRole(team.id, "planner", "claude");
  teamStore.setRole(team.id, "coder", "codex");
  const debuggerMember = {
    name: "debugger1",
    role: "debugger",
    agent: "free",
  } as TeamMemberInput;
  const checks = (): { cwd: string; value: string }[] =>
    existsSync(evidence)
      ? read(evidence)
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const order: string[] = [];
  const builders: AdapterRunInput[] = [];
  const repairs: AdapterRunInput[] = [];
  const toolResults: string[] = [];
  let modelTurns = 0;
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    assert.equal(new URL(String(url)).hostname, "127.0.0.1");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "qwen2.5-coder:3b" }] });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "qwen2.5-coder:3b");
    const names = body.tools.map((t: any) => t.function.name);
    assert.ok(names.includes("write_file"));
    assert.ok(!names.includes("run_command"));
    const last = body.messages.at(-1);
    if (last.role === "tool") {
      const results = body.messages.filter((m: any) => m.role === "tool");
      toolResults.push(...results.slice(-2).map((m: any) => m.content));
      assert.match(results.at(-2).content, /^ERROR:/);
      assert.match(results.at(-1).content, /Wrote/);
      return chat({ content: "Repair complete; please check it." });
    }
    if (mode === "cancel") orchestrator.stop(activeRunId);
    modelTurns++;
    order.push(`debugger:${modelTurns}`);
    assert.equal(
      checks().length,
      modelTurns,
      "actual check precedes each repair",
    );
    assert.match(last.content, /CHECK_VALUE=(broken|still-broken-1)/);
    assert.match(last.content, /value\.txt/);
    assert.doesNotMatch(last.content, /PRIVATE_PLANNER_CONTEXT/);
    return chat(
      {
        content: null,
        tool_calls: [
          ...[".git/config", ".env", "nested/../../escape.txt"].map(
            (path, index) => ({
              id: `protected-${index}`,
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path, content: "blocked" }),
              },
            }),
          ),
          {
            id: `escape-${modelTurns}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "../escape.txt",
                content: "escape",
              }),
            },
          },
          {
            id: `fix-${modelTurns}`,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "value.txt",
                content:
                  mode === "repair"
                    ? "fixed\n"
                    : `still-broken-${modelTurns}\n`,
              }),
            },
          },
        ],
      },
      "tool_calls",
    );
  }) as typeof fetch;
  const free = apiAdapters({
    sessionDir: join(root, "sessions"),
    config: () =>
      normalizeModelConfig({
        free: { provider: "ollama", model: "qwen2.5-coder:3b" },
      }),
    fetch: fetchFn,
    env: {},
  }).free;
  const debugAdapter: AgentAdapter = {
    ...free,
    id: "free",
    detect: () => free.detect(),
    async run(input) {
      repairs.push(input);
      assert.equal(input.cwd, builders[0].cwd);
      assert.equal(input.readOnly, false);
      assert.equal(input.network, false);
      assert.equal(input.fullAccess, false);
      assert.notEqual(input.resumeSessionId, "builder-session-1");
      assert.equal(teamStore.tasks(input.task!.runId)[0].attempt, 1);
      if (mode === "unavailable") {
        order.push("debugger:error");
        throw new Error("Local model is unavailable");
      }
      return free.run(input);
    },
  };
  let plannerCalls = 0;
  const planner: AgentAdapter = {
    id: "claude",
    detect: async () => ({ agent: "claude", installed: true }),
    async run(input) {
      plannerCalls++;
      if (plannerCalls === 2) {
        order.push("planner:evidence");
        assert.equal(builders.length, 1, "no automatic builder retry");
        const task = teamStore.tasks(input.task?.runId ?? activeRunId)[0];
        assert.equal(task.attempt, 1);
        assert.equal(task.sessionId, "builder-session-1");
        assert.equal(task.check?.passed, mode === "repair");
        if (mode !== "repair") {
          assert.match(input.prompt, /CHECK_VALUE=/);
          assert.equal(
            repairs.length,
            mode === "unfixable" ? 2 : mode === "absent" ? 0 : 1,
          );
          assert.equal(checks().length, mode === "unfixable" ? 3 : 1);
        }
        if (mode === "unfixable") {
          assert.match(task.check!.output, /CHECK_VALUE=still-broken-2/);
          return {
            exitCode: 0,
            durationMs: 1,
            finalText: actions({
              type: "delegate",
              id: "T2",
              role: "coder",
              title: "Follow up on failed check",
              instructions:
                "The previous task's actual check still fails. Set value.txt to fixed.",
            }),
          };
        }
      }
      return {
        exitCode: 0,
        durationMs: 1,
        finalText: actions(
          plannerCalls === 1
            ? {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "Repair value",
                instructions: "Set value.txt to fixed",
              }
            : { type: "finish", summary: "Finished" },
        ),
      };
    },
  };
  const builder: AgentAdapter = {
    id: "codex",
    detect: async () => ({ agent: "codex", installed: true }),
    async run(input) {
      builders.push(input);
      order.push(`builder:${builders.length}`);
      if (builders.length === 2) {
        assert.equal(
          repairs.length,
          mode === "unfixable" ? 2 : mode === "absent" ? 0 : 1,
        );
        assert.equal(checks().length, mode === "unfixable" ? 3 : 1);
        assert.equal(input.task?.taskId, "T2");
        assert.equal(
          input.resumeSessionId,
          undefined,
          "new task has no debugger or builder session",
        );
      }
      writeFileSync(
        join(input.cwd, "value.txt"),
        builders.length === 1 ? "broken\n" : "fixed\n",
      );
      return {
        exitCode: 0,
        durationMs: 1,
        sessionId: `builder-session-${builders.length}`,
        finalText: "Done",
      };
    },
  };
  let activeRunId = "";
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: { claude: planner, codex: builder, free: debugAdapter },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  return {
    root,
    work,
    team,
    teamStore,
    debuggerMember,
    orchestrator,
    builders,
    repairs,
    checks,
    order,
    toolResults,
    free,
    async run() {
      if (mode !== "absent") teamStore.addMember(team.id, debuggerMember);
      const run = await orchestrator.startRun(
        team.id,
        "PRIVATE_PLANNER_CONTEXT",
        { maxAttempts: 2 },
        {},
        { checkCommand: "node check.cjs" },
      );
      activeRunId = run.id;
      await orchestrator.idle(run.id);
      return orchestrator.snapshot(run.id)!;
    },
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

test("fake transport executes the real free-model sandbox and returns file-tool evidence", async () => {
  const f = fixture("repair");
  try {
    writeFileSync(join(f.work, "value.txt"), "broken\n");
    assert.throws(() =>
      execFileSync(process.execPath, ["check.cjs"], {
        cwd: f.work,
        stdio: "pipe",
      }),
    );
    const result = await f.free.run({
      cwd: f.work,
      prompt: "Minimally repair value.txt. CHECK_VALUE=broken",
      readOnly: false,
      network: false,
      fullAccess: false,
      timeoutMs: 30_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(read(join(f.work, "value.txt")), "fixed\n");
    assert.equal(existsSync(join(f.root, "escape.txt")), false);
    assert.equal(result.usage?.calls, 2);
    assert.ok(f.toolResults.some((s) => /^ERROR:/.test(s)));
    assert.ok(f.toolResults.some((s) => /Wrote/.test(s)));
  } finally {
    await f.cleanup();
  }
});

test("debugger repairs a failing real check with sandboxed free-model file tools before another builder turn", async () => {
  const f = fixture("repair");
  try {
    const snap = await f.run();
    const task = snap.tasks[0];
    assert.deepEqual(f.order, ["builder:1", "debugger:1", "planner:evidence"]);
    assert.equal(f.builders.length, 1);
    assert.equal(task.attempt, 1);
    assert.equal(task.sessionId, "builder-session-1");
    assert.equal(task.check?.passed, true);
    assert.match(task.check.output, /CHECK_VALUE=fixed/);
    assert.deepEqual(
      f.checks().map((c) => c.value),
      ["broken", "fixed"],
    );
    assert.ok(f.checks().every((c) => c.cwd === task.worktree));
    assert.equal(read(join(task.worktree!, "value.txt")), "fixed\n");
    assert.equal(read(join(f.work, "value.txt")), "initial\n");
    assert.equal(existsSync(join(task.worktree!, "..", "escape.txt")), false);
    assert.ok(f.toolResults.some((s) => /^ERROR:/.test(s)));
    assert.equal(task.debuggerUsage?.[0].member, "debugger1");
    assert.equal(task.debuggerUsage?.[0].usage.calls, 2);
    const breakdown = usageBreakdown({ tasks: [task], run: snap.run });
    assert.equal(
      breakdown.byRole.find((r) => r.key === "debugger")?.usage.calls,
      2,
    );
    assert.equal(
      breakdown.byMember.find((r) => r.key === "debugger1")?.usage.inputTokens,
      200,
    );
    assert.ok(task.drift?.paths.includes("value.txt"));
    assert.match(task.diffStat ?? "", /value\.txt/);
    assert.ok(
      snap.events.some((e) => e.kind === "check" && /failed/.test(e.message)),
    );
  } finally {
    await f.cleanup();
  }
});

test("two unsuccessful debugger turns expose failed check evidence before planner delegates subsequent builder work", async () => {
  const f = fixture("unfixable");
  try {
    const snap = await f.run();
    const task = snap.tasks.find((t) => t.id === "T1")!;
    const followup = snap.tasks.find((t) => t.id === "T2")!;
    assert.deepEqual(f.order, [
      "builder:1",
      "debugger:1",
      "debugger:2",
      "planner:evidence",
      "builder:2",
    ]);
    assert.deepEqual(
      f.checks().map((c) => c.value),
      ["broken", "still-broken-1", "still-broken-2", "fixed"],
    );
    assert.equal(f.repairs.length, 2);
    assert.equal(task.attempt, 1);
    assert.equal(task.sessionId, "builder-session-1");
    assert.equal(task.check?.passed, false);
    assert.match(task.check.output, /CHECK_VALUE=still-broken-2/);
    assert.equal(read(join(task.worktree!, "value.txt")), "still-broken-2\n");
    assert.equal(followup.attempt, 1);
    assert.equal(followup.sessionId, "builder-session-2");
    assert.equal(followup.check?.passed, true);
    assert.match(followup.check.output, /CHECK_VALUE=fixed/);
    assert.ok(
      f
        .checks()
        .slice(0, 3)
        .every((c) => c.cwd === f.builders[0].cwd),
    );
    assert.equal(f.checks()[3].cwd, f.builders[1].cwd);
  } finally {
    await f.cleanup();
  }
});

for (const mode of ["absent", "unavailable"] as const) {
  test(`${mode} debugger exposes failed check evidence to the planner without automatic builder retry`, async () => {
    const f = fixture(mode);
    try {
      const snap = await f.run();
      assert.deepEqual(
        f.order,
        mode === "absent"
          ? ["builder:1", "planner:evidence"]
          : ["builder:1", "debugger:error", "planner:evidence"],
      );
      assert.equal(snap.run.state, "done");
      assert.equal(f.builders.length, 1);
      assert.equal(f.repairs.length, mode === "absent" ? 0 : 1);
      assert.equal(snap.tasks[0].attempt, 1);
      assert.equal(snap.tasks[0].sessionId, "builder-session-1");
      assert.equal(snap.tasks[0].check?.passed, false);
      assert.match(snap.tasks[0].check.output, /CHECK_VALUE=broken/);
      assert.deepEqual(
        f.checks().map((c) => c.value),
        ["broken"],
      );
    } finally {
      await f.cleanup();
    }
  });
}

test("debugger member configuration rejects CLI agents, full access and CLI backups", async () => {
  const f = fixture("absent");
  try {
    for (const patch of [
      { agent: "codex" },
      { fullAccess: true },
      { backup: "codex" },
    ]) {
      assert.throws(() =>
        f.teamStore.addMember(f.team.id, {
          ...f.debuggerMember,
          ...patch,
        } as TeamMemberInput),
      );
    }
    f.teamStore.addMember(f.team.id, f.debuggerMember);
    assert.equal(f.teamStore.member(f.team.id, "debugger1")?.fullAccess, false);
    assert.throws(() =>
      f.teamStore.updateMember(f.team.id, "debugger1", { agent: "codex" }),
    );
    assert.throws(() =>
      f.teamStore.updateMember(f.team.id, "debugger1", { fullAccess: true }),
    );
    assert.throws(() =>
      f.teamStore.updateMember(f.team.id, "debugger1", { backup: "codex" }),
    );
  } finally {
    await f.cleanup();
  }
});

test("cancellation during debugger transport prevents tools and check reruns", async () => {
  const f = fixture("cancel");
  try {
    const snap = await f.run();
    assert.equal(snap.run.state, "stopped");
    assert.equal(snap.tasks[0].state, "cancelled");
    assert.equal(f.builders.length, 1);
    assert.equal(f.repairs.length, 1);
    assert.deepEqual(
      f.checks().map((c) => c.value),
      ["broken"],
    );
    assert.equal(read(join(snap.tasks[0].worktree!, "value.txt")), "broken\n");
  } finally {
    await f.cleanup();
  }
});

test("debugger defaults stay local and isolated from ordinary free workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-debugger-config-"));
  try {
    for (const baseUrl of [
      "https://example.com/v1",
      "http://localhost.evil/v1",
      "http://user:pass@127.0.0.1/v1",
    ])
      assert.throws(() =>
        normalizeModelConfig({ debugger: { model: "local", baseUrl } }),
      );
    const requests: {
      url: string;
      body: any;
      redirect: RequestRedirect | undefined;
    }[] = [];
    const free = apiAdapters({
      sessionDir: join(root, "sessions"),
      config: () =>
        normalizeModelConfig({
          free: {
            provider: "lmstudio",
            model: "ordinary",
          },
        }),
      fetch: (async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          redirect: init?.redirect,
        });
        return chat({ content: "Done" });
      }) as typeof fetch,
      env: {},
    }).free;
    const input = {
      cwd: root,
      prompt: "Check",
      readOnly: false,
      network: false,
      fullAccess: true,
      timeoutMs: 1000,
    };
    await free.run(input);
    await free.run({
      ...input,
      task: { teamId: "t", runId: "r", taskId: "T1", role: "debugger" },
    });
    assert.match(requests[0].url, /:1234/);
    assert.equal(requests[0].body.model, "ordinary");
    assert.ok(
      requests[0].body.tools.some(
        (t: any) => t.function.name === "run_command",
      ),
    );
    assert.equal(requests[1].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(requests[1].body.model, "qwen2.5-coder:3b");
    assert.equal(requests[1].redirect, "error");
    assert.ok(
      !requests[1].body.tools.some(
        (t: any) => t.function.name === "run_command",
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
