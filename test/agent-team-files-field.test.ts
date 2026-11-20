import test from "node:test";
import assert from "node:assert/strict";
import { parsePlannerReply } from "../src/core/team/actions";
import { workerPrompt } from "../src/core/team/prompts";
import { promptSize, promptSizeMessage } from "../src/core/team/prompt-size";
import { DEFAULT_BUDGET, DEFAULT_POLICY, type TeamRun, type TeamTask } from "../src/core/team/types";
import type { Team } from "../src/shared/types";

function parseFiles(files: unknown) {
  return parsePlannerReply(JSON.stringify({ actions: [{
    type: "delegate", id: "T1", role: "coder", title: "Fix", instructions: "Fix it", files,
  }] }), new Set(), new Set(["coder"])).actions[0];
}

test("delegate files are parsed, trimmed and omitted when empty", () => {
  const action = parseFiles([" src/a.ts ", "test/a.ts"]);
  assert.equal(action.type, "delegate");
  if (action.type === "delegate") assert.deepEqual(action.files, ["src/a.ts", "test/a.ts"]);
  assert.equal("files" in parseFiles([]), false);
});

test("delegate files reject excessive lists and invalid entries", () => {
  for (const files of [Array(31).fill("a"), "a", [42], [" "], ["a".repeat(301)]]) {
    assert.throws(() => parseFiles(files), /actions\[0\]\.files/);
  }
});

const team = { version: 1, plan: "Build" } as Team;
const run = {
  budget: DEFAULT_BUDGET, policy: DEFAULT_POLICY, baseBranch: "main", runBranch: "run",
  briefVersion: 1, goal: "Fix",
} as TeamRun;
const task: TeamTask = {
  id: "T1", runId: "r", role: "coder", agent: "codex", title: "Fix", instructions: "Fix it",
  acceptance: ["Works"], dependsOn: [], state: "done", attempt: 1, createdAt: "now",
};

test("worker prompt lists relevant files after acceptance", () => {
  const prompt = workerPrompt(team, run, { ...task, files: ["src/a.ts", "test/a.ts"] });
  assert.match(prompt, /## Relevant files \(from the planner\)\n- src\/a.ts\n- test\/a.ts/);
  assert.match(prompt, /Start from these; open other files only when needed\./);
  assert.ok(prompt.indexOf("## Acceptance") < prompt.indexOf("## Relevant files"));
  assert.doesNotMatch(workerPrompt(team, run, task), /## Relevant files/);
});

test("reviewer prompt includes inline diff, checks and drift while keeping existing lines", () => {
  const reviewer = { ...task, id: "T2", role: "reviewer" as const };
  const reviewed = {
    ...task, base: "base", branch: "branch",
    drift: { classification: "on-plan", alert: false, explanation: "ok", paths: ["src/a.ts"] },
    check: { command: "npm test", passed: true, output: "success" },
  };
  const prompt = workerPrompt(team, run, reviewer, undefined, { task: reviewed, diff: "+fixed" });
  assert.match(prompt, /See its changes with: git diff base\.\.branch/);
  assert.match(prompt, /Files: src\/a.ts/);
  assert.match(prompt, /```diff\n\+fixed\n```/);
  assert.match(prompt, /Cobble's check `npm test`: PASSED/);
  assert.match(prompt, /Drift: on-plan/);
  assert.match(prompt, /Review only this diff and the files it touches; do not explore the whole repository\./);
  const failed = workerPrompt(team, run, reviewer, undefined, {
    task: { ...reviewed, check: { command: "npm test", passed: false, output: "x".repeat(3000) } },
  });
  assert.match(failed, /Cobble's check `npm test`: FAILED/);
  assert.ok(!failed.includes("x".repeat(2001)));
  assert.doesNotMatch(workerPrompt(team, run, reviewer), /do not explore the whole repository/);
});

test("reviewer diff fence encloses backticks through the last diff line", () => {
  const reviewer = { ...task, id: "T2", role: "reviewer" as const };
  const diff = "+```\n+last diff line";
  const prompt = workerPrompt(team, run, reviewer, undefined, { task, diff });
  assert.ok(prompt.includes(`\n\`\`\`\`diff\n${diff}\n\`\`\`\`\n`));
});

test("promptSizeMessage reports characters and rounded token estimates", () => {
  assert.deepEqual(promptSize(""), { chars: 0, approxTokens: 0 });
  assert.deepEqual(promptSize("12345"), { chars: 5, approxTokens: 2 });
  assert.equal(promptSizeMessage("planner", "x".repeat(12345)), "planner prompt: 12345 chars (~3087 tokens)");
  assert.equal(promptSizeMessage("T1 coder", "abcd"), "T1 coder prompt: 4 chars (~1 tokens)");
});
