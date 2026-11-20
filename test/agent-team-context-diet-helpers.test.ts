import test from "node:test";
import assert from "node:assert/strict";
import {
  capHistory,
  compactStateTable,
  CONTEXT_LIMITS,
  wakeNotes,
} from "../src/core/team/context-diet";
import { plannerWakePrompt } from "../src/core/team/prompts";
import {
  USER_NOTE,
  TEAMMATE_NOTE,
} from "../src/core/team/orchestrator-context";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamTask,
  type TeamRun,
} from "../src/core/team/types";
import type { Team } from "../src/shared/types";

function task(id: string, extra: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    runId: "run",
    role: "coder",
    agent: "codex",
    title: "Implement change",
    instructions: "",
    acceptance: [],
    dependsOn: [],
    state: "running",
    attempt: 1,
    createdAt: "2026-11-16",
    ...extra,
  };
}

test("capHistory retains newest clipped items and counts omissions within the total cap", () => {
  assert.equal(
    capHistory([], { maxItems: 12, maxChars: 5000, eachChars: 600 }),
    "",
  );
  assert.equal(
    capHistory(["old", "middle", "newest"], {
      maxItems: 2,
      maxChars: 100,
      eachChars: 5,
    }),
    "(1 earlier items omitted)\nmidd…\nnewe…",
  );
  const result = capHistory(["a".repeat(20), "b".repeat(20), "c".repeat(20)], {
    maxItems: 3,
    maxChars: 50,
    eachChars: 20,
  });
  assert.equal(result, "(2 earlier items omitted)\n" + "c".repeat(20));
  assert.ok(result.length <= 50);
});

test("wakeNotes never drops notes and preserves all user and teammate notes whole", () => {
  const prefixes = [
    USER_NOTE,
    TEAMMATE_NOTE,
    "The user answered",
    "The user skipped",
    "The user wrote to",
  ];
  const protectedNotes = prefixes.map(
    (prefix) => `${prefix}: ${"x".repeat(2000)}\ncontinuation`,
  );
  const notes = ["system: " + "y".repeat(2000), ...protectedNotes, "last note"];
  const result = wakeNotes(notes);
  assert.ok(result.startsWith(wakeNotes([notes[0]])));
  assert.equal(wakeNotes([notes[0]]).length, CONTEXT_LIMITS.noteEach);
  for (const note of protectedNotes) assert.ok(result.includes(note));
  assert.ok(result.endsWith("last note"));
  assert.equal(wakeNotes([]), "");
});

test("compactStateTable keeps task shape and flags and bounds titles", () => {
  assert.equal(
    compactStateTable([
      task("T3", {
        merged: true,
        check: { command: "test", passed: true, output: "" },
      }),
    ]),
    "- T3 [running] coder/codex: Implement change (merged, check passed)",
  );
  const result = compactStateTable([task("T1", { title: "x".repeat(100) })]);
  assert.equal(result.split(": ")[1].length, 60);
  assert.equal(compactStateTable([]), "(none yet)");
});

test("compactStateTable prioritizes active tasks then newest terminal tasks without mutating input", () => {
  const tasks = Array.from({ length: 45 }, (_, i) =>
    task(`T${i}`, { state: "done", createdAt: String(i).padStart(3, "0") }),
  );
  tasks[0].state = "running";
  const result = compactStateTable(tasks);
  assert.ok(result.startsWith("- T0 [running]"));
  assert.ok(result.split("\n")[1].startsWith("- T44"));
  assert.ok(result.endsWith("(+5 older tasks omitted)"));
  assert.equal(result.split("\n").length, 41);
  assert.equal(tasks[1].id, "T1");
  assert.ok(!result.includes("- T1 ["));
});

test("plannerWakePrompt delta omits saved context and delivered question text while full retains it", () => {
  const team = { version: 2 } as Team;
  const run: TeamRun = {
    id: "run",
    teamId: "team",
    goal: "Build this",
    state: "running",
    plannerTurns: 2,
    planVersion: 2,
    budget: DEFAULT_BUDGET,
    policy: DEFAULT_POLICY,
    baseBranch: "main",
    runBranch: "run",
    approvals: [],
    invalidPlannerReplies: 0,
    pendingNotes: ["Updated"],
    wakeRequested: true,
    workspace: ".",
    brief: "Architecture",
    briefVersion: 3,
    createdAt: "",
    updatedAt: "",
  };
  const tasks = [
    task("T1", {
      state: "needs_decision",
      question: { text: "old question", options: [], delivered: true },
    }),
    task("T2", {
      state: "needs_decision",
      question: {
        text: "new question",
        options: ["one", "two"],
        delivered: false,
      },
    }),
  ];
  const answers = [{ question: "Where?", answer: "Local only", at: "" }];
  const brief = {
    agents: ["codex" as const],
    priority: "Session priority",
    createdAt: "",
    updatedAt: "",
  };
  const decisions = [
    {
      id: "D1",
      runId: "run",
      question: "Which?",
      choice: "Chosen option",
      why: "Simple",
      createdAt: "",
    },
  ];
  const full = plannerWakePrompt(
    team,
    run,
    tasks,
    [],
    decisions,
    "Updated",
    answers,
    brief,
  );
  const delta = plannerWakePrompt(
    team,
    { ...run, plannerSessionId: "session" },
    tasks,
    [],
    decisions,
    "Updated",
    answers,
    brief,
  );
  for (const text of [
    "Project decisions",
    "Session brief",
    "Session priority",
    "Decisions so far",
    "Chosen option",
  ]) {
    assert.ok(full.includes(text));
    assert.ok(!delta.includes(text));
  }
  for (const text of [
    "Goal: Build this",
    "Version 3 is published",
    "T1 still waiting for your answer",
    "new question",
    "Options: one | two",
    "## Newly finished",
    "## State",
    "## Budget left",
    "Updated",
  ])
    assert.ok(delta.includes(text));
  assert.ok(full.includes("old question"));
  assert.ok(!delta.includes("old question"));
  assert.ok(delta.length < 3000);
  assert.ok(delta.indexOf("## Newly finished") < delta.indexOf("## State"));
});
