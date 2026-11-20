import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPilot, type PilotDeps } from "../src/core/team/pilot";
import { plannerWakePrompt } from "../src/core/team/prompts";
import { CobbleService } from "../src/core/service";
import type { HelperRunner } from "../src/core/team/helpers";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";
import type { Team } from "../src/shared/types";

const block = (items: unknown[]) =>
  "```cobble-pilot\n" + JSON.stringify({ done: false, items }) + "\n```";

function pilotDeps(helper?: HelperRunner) {
  let now = 0;
  const messages: string[] = [];
  const added: string[][] = [];
  const deps: PilotDeps = {
    now: () => now,
    brief: () => ({ days: 1, agents: [], priority: "tests", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }),
    planner: () => ({
      id: "codex",
      detect: async () => ({ agent: "codex", installed: true }),
      run: async () => ({
        exitCode: 0,
        durationMs: 0,
        finalText: block([
          { item: "- [ ] Add tests — done when: test passes in test/pilot.test.ts", role: "coder", minutes: 1, label: "UI: settings page" },
        ]),
      }),
    }),
    cwd: "fake",
    roles: ["coder"],
    context: async () => ({ planText: "plan", digest: "digest", questions: [] }),
    readBacklog: async () => "",
    addItems: async (_goal, items) => {
      added.push(items);
    },
    notify: async (s) => {
      messages.push(s);
    },
    sendDigest: async () => {},
    spentUsd: () => 0,
    shouldStop: () => false,
    sleep: async () => {},
    runItems: async () => {
      now += 43_200_000;
      return { stoppedReason: "empty" };
    },
    ...(helper ? { helper } : {}),
  };
  return { deps, messages, added };
}

test("Pilot's Next up wording comes from the local helper when it is on", async () => {
  const jobs: string[] = [];
  const h = pilotDeps(async (req) => {
    jobs.push(req.job);
    return "Settings page: tests";
  });
  await runPilot(h.deps);
  assert.ok(jobs.includes("next-up"));
  assert.ok(h.messages.some((m) => m.includes("• Settings page: tests")), h.messages.join("|"));
  // The work item itself is never reworded.
  assert.ok(h.added.flat().every((item) => item.includes("Add tests — done when: test passes in test/pilot.test.ts")), h.added.flat().join("|"));
});

test("Pilot keeps its own wording when the helper is off or unsure", async () => {
  const off = pilotDeps();
  await runPilot(off.deps);
  assert.ok(off.messages.some((m) => m.includes("• UI: settings page")));
  const unsure = pilotDeps(async (req) => req.fallback);
  await runPilot(unsure.deps);
  assert.ok(unsure.messages.some((m) => m.includes("• UI: settings page")));
  const broken = pilotDeps(async () => {
    throw new Error("down");
  });
  await runPilot(broken.deps);
  assert.ok(broken.messages.some((m) => m.includes("• UI: settings page")));
});

test("the planner reads a condensed failing check when the helper made one", () => {
  const run: TeamRun = {
    id: "run",
    teamId: "team",
    goal: "Build this",
    state: "running",
    plannerTurns: 1,
    planVersion: 1,
    budget: DEFAULT_BUDGET,
    policy: DEFAULT_POLICY,
    baseBranch: "main",
    runBranch: "run",
    approvals: [],
    invalidPlannerReplies: 0,
    pendingNotes: [],
    wakeRequested: true,
    workspace: ".",
    briefVersion: 0,
    createdAt: "",
    updatedAt: "",
  };
  const task = (check: TeamTask["check"]): TeamTask => ({
    id: "T1",
    runId: "run",
    role: "coder",
    agent: "codex",
    title: "Change",
    instructions: "",
    acceptance: [],
    dependsOn: [],
    state: "done",
    attempt: 1,
    createdAt: "",
    check,
  });
  const raw = "RAW-LOG-LINE ".repeat(800);
  const condensed = plannerWakePrompt(
    { version: 1 } as Team,
    run,
    [],
    [task({ command: "npm test", passed: false, output: raw, condensed: "1 test failed: footer.test.ts expects a link" })],
    [],
  );
  assert.match(condensed, /Condensed by the local helper/);
  assert.match(condensed, /footer\.test\.ts expects a link/);
  assert.ok(!condensed.includes("RAW-LOG-LINE"));
  const plain = plannerWakePrompt(
    { version: 1 } as Team,
    run,
    [],
    [task({ command: "npm test", passed: false, output: "short failure" })],
    [],
  );
  assert.match(plain, /short failure/);
});

test("helpers are off by default; on uses the default model; off turns them off", async () => {
  const root = mkdtempSync(join(tmpdir(), "cobble-helpers-"));
  const service = new CobbleService(join(root, "c.sqlite"), undefined, {
    teamWorktreeRoot: join(root, "trees"),
    teamAdapters: {},
  });
  try {
    assert.equal(service.teamHelpers().model, null);
    assert.equal(service.setTeamHelpers("on").model, "qwen2.5-coder:1.5b");
    assert.equal(service.setTeamHelpers("llama3.2:3b").model, "llama3.2:3b");
    assert.throws(() => service.setTeamHelpers("bad name"), /no spaces/);
    assert.equal(service.teamHelpers().model, "llama3.2:3b");
    assert.equal(service.setTeamHelpers("off").model, null);
  } finally {
    await service.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows locks */
    }
  }
});
