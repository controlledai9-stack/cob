import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import { parsePlannerReply } from "../src/core/team/actions";
import {
  capHistory,
  compactStateTable,
  wakeNotes,
} from "../src/core/team/context-diet";
import { USER_NOTE } from "../src/core/team/orchestrator-context";
import type {
  AgentAdapter,
  AdapterRunInput,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamAgentId, TeamRole, TeamTask } from "../src/core/team/types";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
type Script = (input: AdapterRunInput, call: number) => Partial<AdapterResult>;
const actions = (body: object) =>
  "```cobble-actions\n" + JSON.stringify(body) + "\n```";
function fake(id: TeamAgentId, script: Script) {
  const calls: AdapterRunInput[] = [];
  const adapter: AgentAdapter = {
    id,
    detect: async () => ({ agent: id, installed: true, version: "fake" }),
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
function setup(planner: Script, coder: Script, reviewer: Script) {
  const root = mkdtempSync(join(tmpdir(), "cobble-context-diet-"));
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "README.md"), "hello\n");
  writeFileSync(join(work, "check.cjs"), "process.exit(0);\n");
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
  const team = store.createTeam(
    "Team",
    "Update README.md; keep changes local.",
    work,
  );
  const teamStore = new TeamStore(store);
  for (const [role, agent] of Object.entries({
    planner: "claude",
    coder: "codex",
    reviewer: "gemini",
  }))
    teamStore.setRole(team.id, role as TeamRole, agent as TeamAgentId);
  const p = fake("claude", planner);
  const c = fake("codex", coder);
  const r = fake("gemini", reviewer);
  const orchestrator = new TeamOrchestrator({
    teamStore,
    adapters: { claude: p.adapter, codex: c.adapter, gemini: r.adapter },
    worktreeRoot: join(root, "trees"),
    team: (id) => store.team(id),
  });
  return {
    team,
    orchestrator,
    plannerCalls: p.calls,
    workerCalls: c.calls,
    reviewerCalls: r.calls,
    async cleanup() {
      await orchestrator.close();
      store.db.close();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    },
  };
}

test("context diet reaches planner, worker and reviewer through one real git run", async () => {
  const checkCommand = 'node -e "process.exit(0)"';
  const f = setup(
    (_input, call) => ({
      sessionId: "planner-context-session",
      finalText: actions({
        actions:
          call === 1
            ? [
                {
                  type: "delegate",
                  id: "T1",
                  role: "coder",
                  title: "Update greeting",
                  instructions: "Update README.md",
                  files: ["README.md", "check.cjs"],
                  acceptance: ["Greeting is updated"],
                },
              ]
            : call === 2
              ? [
                  {
                    type: "delegate",
                    id: "R1",
                    role: "reviewer",
                    title: "Review greeting",
                    instructions: "Review T1",
                    reviews: "T1",
                  },
                ]
              : [{ type: "finish", summary: "Reviewed greeting" }],
      }),
    }),
    (input) => {
      writeFileSync(join(input.cwd, "README.md"), "hello context diet\n");
      return {
        finalText:
          '```cobble-report\n{"status":"done","summary":"Updated greeting","files":["README.md"]}\n```',
      };
    },
    () => ({
      finalText:
        '```cobble-report\n{"status":"done","summary":"Reviewed","verdict":"approve","files":[]}\n```',
    }),
  );
  try {
    const run = await f.orchestrator.startRun(
      f.team.id,
      "Update and review the greeting",
      {},
      {},
      { checkCommand },
    );
    await f.orchestrator.idle(run.id);
    const snap = f.orchestrator.snapshot(run.id)!;
    assert.equal(snap.run.state, "done", JSON.stringify(snap.events));
    assert.equal(f.plannerCalls.length, 3);
    const [first, second] = f.plannerCalls.map((call) => call.prompt);
    assert.equal(f.plannerCalls[1].resumeSessionId, "planner-context-session");
    assert.ok(
      second.length < first.length * 0.5,
      `${second.length} vs ${first.length}`,
    );
    assert.ok(second.length < 4_000, `${second.length} chars`);
    assert.equal(f.workerCalls.length, 1);
    assert.match(
      f.workerCalls[0].prompt,
      /## Relevant files \(from the planner\)\n- README\.md\n- check\.cjs/,
    );
    assert.match(
      f.workerCalls[0].prompt,
      /Start from these; open other files only when needed\./,
    );
    assert.equal(f.reviewerCalls.length, 1);
    const review = f.reviewerCalls[0].prompt;
    assert.match(review, /```diff\n/);
    assert.match(review, /^\+hello context diet$/m);
    assert.ok(
      review.includes(`Cobble's check \`${checkCommand}\`: PASSED`),
      review,
    );
    assert.match(
      review,
      /Review only this diff and the files it touches; do not explore the whole repository\./,
    );
    assert.equal(
      snap.tasks.find((task) => task.id === "T1")?.check?.passed,
      true,
    );
    const prompts = snap.events.filter((event) => event.kind === "prompt");
    assert.ok(
      prompts.some((event) => event.message.startsWith("planner prompt:")),
    );
    assert.ok(
      prompts.some(
        (event) =>
          event.taskId === "T1" && event.message.startsWith("T1 coder prompt:"),
      ),
    );
    assert.ok(
      prompts.some(
        (event) =>
          event.taskId === "R1" &&
          event.message.startsWith("R1 reviewer prompt:"),
      ),
    );
  } finally {
    await f.cleanup();
  }
});

test("context helpers cap history, preserve user notes and keep the task row shape", () => {
  assert.equal(
    capHistory([], { maxItems: 2, maxChars: 100, eachChars: 10 }),
    "",
  );
  assert.equal(
    capHistory(["old", "middle", "new"], {
      maxItems: 2,
      maxChars: 100,
      eachChars: 10,
    }),
    "(1 earlier items omitted)\nmiddle\nnew",
  );
  assert.equal(
    capHistory(["old".repeat(10), "middle".repeat(10), "new"], {
      maxItems: 3,
      maxChars: 30,
      eachChars: 30,
    }),
    "(2 earlier items omitted)\nnew",
  );
  const userNote = `${USER_NOTE}: ${"u".repeat(3_000)}`;
  assert.equal(wakeNotes([userNote]), userNote);
  const notes = wakeNotes(["x".repeat(3_000), userNote]);
  assert.equal(notes.split("\n")[0].length, 1_500);
  assert.ok(notes.endsWith(userNote));
  const task: TeamTask = {
    id: "T3",
    runId: "run",
    role: "coder",
    agent: "codex",
    title: "Update greeting",
    instructions: "Update README",
    acceptance: [],
    dependsOn: [],
    state: "running",
    attempt: 1,
    createdAt: "2026-01-01T00:00:00Z",
    merged: true,
    check: { command: "check", passed: true, output: "" },
  };
  assert.equal(
    compactStateTable([task]),
    "- T3 [running] coder/codex: Update greeting (merged, check passed)",
  );
  const many = Array.from({ length: 42 }, (_, i): TeamTask => ({
    ...task,
    id: `T${i}`,
    state: i === 0 ? "running" : "done",
  }));
  const table = compactStateTable(many);
  assert.match(table, /^- T0 \[running\]/);
  assert.match(table, /\(\+2 older tasks omitted\)$/);
  assert.equal(table.split("\n").length, 41);
});

test("delegate rejects invalid files with a field-specific parse error", () => {
  for (const files of [
    "README.md",
    [""],
    [42],
    ["x".repeat(301)],
    Array(31).fill("README.md"),
  ]) {
    assert.throws(
      () =>
        parsePlannerReply(
          actions({
            actions: [
              {
                type: "delegate",
                id: "T1",
                role: "coder",
                title: "Greeting",
                instructions: "Update",
                files,
              },
            ],
          }),
          new Set(),
          new Set<TeamRole>(["planner", "coder"]),
        ),
      /actions\[0\]\.files/,
    );
  }
});
