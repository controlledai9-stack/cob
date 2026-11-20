import { CobbleService } from "../src/core/service";
import { withUnavailable } from "../src/core/team/adapters";
import type Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { TeamOrchestrator } from "../src/core/team/orchestrator";
import type { AgentAdapter, AdapterRunInput } from "../src/core/team/adapters";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { bestAvailableMembers } from "../src/core/team/member-setup";
import {
  memberModelError,
  TEAM_ROLES,
  type TeamAgentId,
} from "../src/core/team/types";
import { claudeSpec, codexSpec, geminiSpec } from "../src/core/team/adapters";
import {
  apiAdapters,
  DEFAULT_MODEL_CONFIG,
  normalizeModelConfig,
} from "../src/core/team/api-agent";

const input = {
  cwd: ".",
  prompt: "test",
  readOnly: true,
  network: false,
  timeoutMs: 100,
};
for (const spec of [claudeSpec, codexSpec, geminiSpec]) {
  test(`${spec.id} validates and passes member model in fresh and resumed arguments`, () => {
    for (const resumeSessionId of [undefined, "session-1"]) {
      const args = spec.args({
        ...input,
        resumeSessionId,
        model: "vendor/model:v1@fast+test",
      });
      const index = args.indexOf(spec.id === "claude" ? "--model" : "-m");
      assert.ok(index >= 0);
      assert.equal(args[index + 1], "vendor/model:v1@fast+test");
      if (spec.id === "codex") {
        assert.deepEqual(
          args.slice(0, index),
          resumeSessionId ? ["exec", "resume", resumeSessionId] : ["exec"],
        );
        assert.ok(index < args.indexOf("--json"));
        assert.equal(args.at(-1), "-");
      }
      assert.throws(() => spec.args({ ...input, model: "--bad" }));
      assert.ok(!spec.args(input).includes("--model"));
      assert.ok(!spec.args(input).includes("-m"));
    }
  });
}
test("model validation rejects malformed input", () => {
  for (const value of [undefined, null, "", "gpt-5.5", "a".repeat(120)])
    assert.equal(memberModelError(value), null);
  for (const value of [
    false,
    1,
    {},
    [],
    "-x",
    " x",
    "x y",
    "x\n",
    "x;rm",
    "x$y",
    "a".repeat(121),
  ])
    assert.ok(memberModelError(value));
});

test("models survive CRUD, rename and database restart; explicit clears remove metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "member-model-"));
  const file = join(dir, "store.db");
  let store = new Store(file);
  try {
    store.saveProfile("Tester", "tester@example.com");
    const id = store.createTeam("Test", "Build", process.cwd()).id;
    let members = new TeamStore(store);
    members.addMember(id, {
      name: "worker",
      role: "coder",
      agent: "codex",
      model: "gpt-5.5",
    });
    members.updateMember(id, "worker", { name: "worker2" });
    assert.equal(members.member(id, "worker2")?.model, "gpt-5.5");
    store.db.close();
    store = new Store(file);
    members = new TeamStore(store);
    assert.equal(members.member(id, "worker2")?.model, "gpt-5.5");
    assert.throws(() =>
      members.updateMember(id, "worker2", { model: "bad name" }),
    );
    for (const model of [null, ""]) {
      members.updateMember(id, "worker2", { model });
      assert.equal(members.member(id, "worker2")?.model, undefined);
      members.updateMember(id, "worker2", { model: "fast" });
    }
    members.removeMember(id, "worker2");
    members.addMember(id, { name: "worker2", role: "coder", agent: "codex" });
    assert.equal(members.member(id, "worker2")?.model, undefined);
    members.updateMember(id, "worker2", { model: "cleared-with-role" });
    members.setRole(id, "coder", null);
    members.addMember(id, { name: "worker2", role: "coder", agent: "codex" });
    assert.equal(members.member(id, "worker2")?.model, undefined);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const agents of [
  ["free"],
  ["codex"],
  ["claude", "codex"],
] as TeamAgentId[][]) {
  test(`first setup: ${agents.join(" plus ")}; preserves changes and deliberate emptiness`, () => {
    const store = new Store(":memory:");
    try {
      store.saveProfile("Tester", "tester@example.com");
      const id = store.createTeam("Test", "Build", process.cwd()).id;
      const members = new TeamStore(store);
      const detected = agents.map((agent) => ({ agent, installed: true }));
      members.initializeMembers(id, []);
      assert.deepEqual(members.members(id), []);
      members.initializeMembers(id, detected);
      // Every role is filled except the debugger, which needs a local model.
      assert.equal(
        members.members(id).length,
        TEAM_ROLES.length - (agents.includes("free") ? 0 : 1),
      );
      assert.equal(
        members.members(id).some((m) => m.role === "debugger"),
        agents.includes("free"),
      );
      assert.equal(
        members.planner(id)?.agent,
        agents.includes("claude") ? "claude" : agents[0],
      );
      assert.equal(
        members.member(id, "coder1")?.agent,
        agents.includes("codex") ? "codex" : "free",
      );
      members.updateMember(id, "coder1", { model: "custom" });
      members.initializeMembers(id, [{ agent: "gemini", installed: true }]);
      assert.equal(members.member(id, "coder1")?.model, "custom");
      for (const member of members.members(id))
        members.removeMember(id, member.name);
      new TeamStore(store).initializeMembers(id, detected);
      assert.deepEqual(members.members(id), []);
    } finally {
      store.db.close();
    }
  });
}
test("setup excludes paid API and teammate and migrates existing roles first", () => {
  assert.deepEqual(
    bestAvailableMembers([
      { agent: "claude-api", installed: true },
      { agent: "teammate", installed: true },
    ]),
    [],
  );
  const store = new Store(":memory:");
  try {
    store.saveProfile("Tester", "tester@example.com");
    const id = store.createTeam("Test", "Build", process.cwd()).id;
    const members = new TeamStore(store);
    store.db
      .prepare("INSERT INTO team_roles VALUES(?,?,?)")
      .run(id, "planner", "gemini");
    members.initializeMembers(id, [{ agent: "codex", installed: true }]);
    assert.equal(members.members(id).length, 1);
    assert.equal(members.planner(id)?.agent, "gemini");
  } finally {
    store.db.close();
  }
});
test("Ollama discovery saves a deterministic real local model via worker config", async () => {
  let config = normalizeModelConfig({}, DEFAULT_MODEL_CONFIG);
  const adapters = apiAdapters({
    sessionDir: ".",
    config: () => config,
    saveConfig: (patch) => {
      config = normalizeModelConfig(patch, config);
    },
    fetch: async () =>
      new Response(
        JSON.stringify({ data: [{ id: "z:latest" }, { id: "a:latest" }] }),
      ),
  });
  assert.equal((await adapters.free.detect()).installed, true);
  assert.equal(config.free.model, "a:latest");
  assert.equal(config.claudeModel, DEFAULT_MODEL_CONFIG.claudeModel);
  config = normalizeModelConfig({ free: { model: "z:latest" } }, config);
  await adapters.free.detect();
  assert.equal(config.free.model, "z:latest");
});

test("named planner and worker models propagate while a fallback provider gets its default", async () => {
  const root = mkdtempSync(join(tmpdir(), "member-invocation-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--allow-empty",
    "-qm",
    "init",
  );
  const store = new Store(":memory:");
  store.saveProfile("Tester", "tester@example.com");
  const team = store.createTeam("Test", "Investigate only", root);
  const members = new TeamStore(store);
  members.addMember(team.id, {
    name: "planner1",
    role: "planner",
    agent: "claude",
    model: "haiku",
    backup: "codex",
  });
  members.addMember(team.id, {
    name: "researcher1",
    role: "researcher",
    agent: "codex",
    backup: "gemini",
    model: "gpt-fast",
  });
  const calls: Partial<Record<TeamAgentId, AdapterRunInput[]>> = {};
  const fake = (id: TeamAgentId): AgentAdapter => ({
    id,
    detect: async () => ({ agent: id, installed: true }),
    run: async (input) => {
      (calls[id] ??= []).push(input);
      const actions =
        calls.claude?.length === 1
          ? [
              {
                type: "delegate",
                id: "T1",
                member: "researcher1",
                role: "researcher",
                title: "Inspect",
                instructions: "Inspect",
                acceptance: [],
              },
            ]
          : [{ type: "finish", summary: "done" }];
      const rateLimited =
        (id === "codex" && !!input.task) ||
        (id === "claude" && (calls.claude?.length ?? 0) > 1);
      return {
        exitCode: rateLimited ? 1 : 0,
        durationMs: 1,
        rateLimited,
        finalText:
          id === "claude" || (id === "codex" && !input.task)
            ? "```cobble-actions\n" + JSON.stringify({ actions }) + "\n```"
            : "```cobble-report\n" +
              JSON.stringify({ status: "done", summary: "done", files: [] }) +
              "\n```",
      };
    },
  });
  const orchestrator = new TeamOrchestrator({
    teamStore: members,
    adapters: {
      claude: fake("claude"),
      codex: fake("codex"),
      gemini: fake("gemini"),
    },
    team: (id) => store.team(id),
    worktreeRoot: join(root, "trees"),
  });
  try {
    const run = await orchestrator.startRun(team.id, "Inspect");
    await orchestrator.idle(run.id);
    assert.equal(calls.claude?.[0].model, "haiku");
    assert.equal(calls.codex?.[0].model, "gpt-fast");
    assert.equal(calls.gemini?.length, 1);
    assert.equal(calls.gemini?.[0].model, undefined);
    const backupPlanner = calls.codex?.find((call) => !call.task);
    assert.ok(backupPlanner);
    assert.equal(backupPlanner.model, undefined);
  } finally {
    await orchestrator.close();
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("free and Claude API workers keep provider configuration despite CLI member metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "member-api-"));
  const config = normalizeModelConfig({ free: { model: "local-model" } });
  let freeModel: unknown;
  let claudeModel: unknown;
  const client = {
    beta: {
      messages: {
        stream: (request: { model: string }) => {
          claudeModel = request.model;
          return {
            finalMessage: async () => ({
              model: config.claudeModel,
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  const adapters = apiAdapters({
    sessionDir: dir,
    config: () => config,
    claudeClient: () => client,
    fetch: async (_url, request) => {
      freeModel = (JSON.parse(String(request?.body)) as { model: unknown })
        .model;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  });
  try {
    const runInput = {
      ...input,
      cwd: dir,
      timeoutMs: 5000,
      model: "incompatible-cli-model",
    };
    assert.equal((await adapters.free.run(runInput)).exitCode, 0);
    assert.equal((await adapters["claude-api"].run(runInput)).exitCode, 0);
    assert.equal(freeModel, "local-model");
    assert.equal(claudeModel, config.claudeModel);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service detection retains its response and initializes the active team's members", async () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("Tester", "tester@example.com");
    const team = store.createTeam("Test", "Build", process.cwd());
    const teamStore = new TeamStore(store);
    const codex: AgentAdapter = {
      id: "codex",
      detect: async () => ({
        agent: "codex",
        installed: true,
        version: "fake",
      }),
      run: async () => {
        throw new Error("detection must never run a worker");
      },
    };
    let shared: unknown;
    const service = {
      teamStore,
      teamAdapters: withUnavailable({ codex }),
      activeTeam: () => team,
      emit: () => {},
      shareRoster: (found: unknown) => {
        shared = found;
      },
    } as unknown as CobbleService;
    const found = await CobbleService.prototype.detectTeamAgents.call(service);
    assert.equal(found.find((d) => d.agent === "codex")?.version, "fake");
    assert.equal(shared, found);
    // Only Codex is installed: every role but the (local-only) debugger.
    assert.equal(teamStore.members(team.id).length, TEAM_ROLES.length - 1);
  } finally {
    store.db.close();
  }
});

test("a deliberately empty configuration from before automatic setup stays empty", () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("Tester", "tester@example.com");
    const team = store.createTeam("Test", "Build", process.cwd());
    store.set(`teamMembersMigrated:${team.id}`, true);
    const members = new TeamStore(store);
    members.initializeMembers(team.id, [{ agent: "codex", installed: true }]);
    assert.deepEqual(members.members(team.id), []);
  } finally {
    store.db.close();
  }
});

test("planner adapters used by project chat, roadmap and pilot preserve the named model", async () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("Tester", "tester@example.com");
    const team = store.createTeam("Test", "Build", process.cwd());
    const teamStore = new TeamStore(store);
    teamStore.addMember(team.id, {
      name: "planner1",
      role: "planner",
      agent: "claude",
      model: "haiku",
    });
    const calls: AdapterRunInput[] = [];
    const claude: AgentAdapter = {
      id: "claude",
      detect: async () => ({ agent: "claude", installed: true }),
      run: async (input) => {
        calls.push(input);
        return { exitCode: 0, finalText: "done", durationMs: 1 };
      },
    };
    const service = {
      teamStore,
      teamAdapters: withUnavailable({ claude }),
    } as unknown as CobbleService;
    const planner = CobbleService.prototype["memberPlannerAdapter"].call(
      service,
      team.id,
    );
    assert.ok(planner);
    await planner.run({ ...input, model: "other" });
    assert.equal(calls[0].model, "haiku");
    assert.equal((await planner.detect()).installed, true);
  } finally {
    store.db.close();
  }
});
