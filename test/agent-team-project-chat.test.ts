import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CobbleService } from "../src/core/service";
import { Store } from "../src/core/store";
import { TeamStore, TEAM_STORE_LIMITS } from "../src/core/team/team-store";
import {
  ProjectChat,
  parseProjectChatReply,
  projectChatPrompt,
} from "../src/core/team/project-chat";
import { parseStartCommand } from "../src/core/team/chat-command";
import type {
  AgentAdapter,
  AdapterRunInput,
  AdapterResult,
} from "../src/core/team/adapters";
import type { TeamRun } from "../src/core/team/types";

function setup() {
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("Team", "Build the app", process.cwd());
  const teamStore = new TeamStore(store);
  const calls: AdapterRunInput[] = [];
  let response: AdapterResult = {
    exitCode: 0,
    finalText: "Everything is ready.",
    durationMs: 1,
  };
  let wait: Promise<void> = Promise.resolve();
  const chat = new ProjectChat({
    teamStore,
    team: (id) => store.team(id),
    backlog: async () => "- [ ] Improve chat\n- [x] Done",
    plannerAdapter: () => ({
      agent: "codex",
      adapter: {
        id: "codex",
        detect: async () => ({ agent: "codex", installed: true }),
        run: async (input) => {
          calls.push(input);
          await wait;
          return response;
        },
      },
    }),
  });
  return {
    store,
    team,
    teamStore,
    chat,
    calls,
    response: (r: Partial<AdapterResult>) => {
      response = { ...response, ...r };
    },
    wait: (p: Promise<void>) => {
      wait = p;
    },
  };
}

test("status answers without a run; work proposes and starts only on request", async () => {
  const f = setup();
  try {
    const status = await f.chat.ask(f.team.id, "What's the status?");
    assert.equal(status.reply.text, "Everything is ready.");
    assert.equal(f.teamStore.runs(f.team.id).length, 0);
    assert.equal(f.calls[0].readOnly, true);
    assert.equal(f.calls[0].network, false);
    assert.equal(f.calls[0].timeoutMs, 300_000);
    assert.match(f.calls[0].prompt, /Open backlog items/);
    assert.equal(f.calls[0].prompt.split("What's the status?").length, 2);
    f.response({
      finalText:
        'I can improve it.\n```cobble-proposal\n{"goal":"Improve chat"}\n```',
    });
    const answer = await f.chat.ask(f.team.id, "Improve chat please");
    assert.equal(answer.proposal?.proposal?.status, "open");
    assert.equal(f.teamStore.runs(f.team.id).length, 0);
    await assert.rejects(
      f.chat.startProposal(
        f.team.id,
        answer.proposal!.id,
        undefined,
        async () => {
          throw new Error("start failed");
        },
      ),
      /start failed/,
    );
    assert.equal(f.chat.messages(f.team.id).at(-1)?.proposal?.status, "open");
    const run = await f.chat.startProposal(
      f.team.id,
      answer.proposal!.id,
      "Edited goal",
      async (goal) => {
        const run = {
          id: "run1",
          teamId: f.team.id,
          goal,
          state: "running",
          updatedAt: new Date().toISOString(),
        } as TeamRun;
        f.teamStore.saveRun(run);
        return run;
      },
    );
    assert.equal(run.goal, "Edited goal");
    assert.equal(f.teamStore.runs(f.team.id).length, 1);
    assert.equal(f.chat.messages(f.team.id).at(-1)?.proposal?.runId, "run1");
    await assert.rejects(
      f.chat.startProposal(
        f.team.id,
        answer.proposal!.id,
        undefined,
        async () => run,
      ),
      /already started/,
    );
    await assert.rejects(
      f.chat.startProposal(f.team.id, "unknown", undefined, async () => run),
      /Unknown proposal/,
    );
  } finally {
    f.store.close();
  }
});

test("busy lock rejects before storing and releases after failures", async () => {
  const f = setup();
  try {
    let release!: () => void;
    f.wait(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const pending = f.chat.ask(f.team.id, "status");
    await assert.rejects(f.chat.ask(f.team.id, "second"), /still answering/);
    assert.equal(f.chat.messages(f.team.id).length, 1);
    release();
    await pending;
    f.response({ authRequired: { service: "codex", hint: "Sign in" } });
    await assert.rejects(
      f.chat.ask(f.team.id, "status"),
      /Planner authentication required: Sign in/,
    );
    assert.equal(f.chat.busy(f.team.id), false);
    assert.match(
      f.chat.messages(f.team.id).at(-1)!.text,
      /Planner sign-in needed/,
    );
    f.response({ authRequired: undefined, exitCode: 1, finalText: "failure" });
    await assert.rejects(
      f.chat.ask(f.team.id, "status"),
      /could not answer: failure/,
    );
    f.response({ exitCode: 0, finalText: "" });
    assert.equal(
      (await f.chat.ask(f.team.id, "status")).reply.text,
      "The planner sent no answer.",
    );
  } finally {
    f.store.close();
  }
});

test("project storage caps, isolates and preserves oldest-first ordering", () => {
  const f = setup();
  try {
    for (let i = 0; i < 502; i++)
      f.teamStore.projectChat(f.team.id, {
        author: "user",
        kind: "message",
        text: String(i),
      });
    const messages = f.chat.messages(f.team.id);
    assert.equal(messages.length, TEAM_STORE_LIMITS.projectChatPerTeam);
    assert.equal(messages[0].text, "2");
    assert.equal(messages.at(-1)!.runId, "");
    assert.equal(
      f.teamStore.projectChat(f.team.id, {
        author: "user",
        kind: "message",
        text: "x".repeat(9000),
      }).text.length,
      TEAM_STORE_LIMITS.chatText,
    );
    const other = f.store.createTeam("Other", "Plan", process.cwd());
    assert.deepEqual(f.chat.messages(other.id), []);
    assert.equal(
      f.teamStore.updateProjectChatProposal(other.id, messages[0].id, {
        goal: "x",
        status: "open",
      }),
      null,
    );
  } finally {
    f.store.close();
  }
});

test("command and reply contracts reject invalid goals and strip action blocks", () => {
  assert.equal(parseStartCommand(" @PLANNER start:  do it  "), "do it");
  assert.equal(parseStartCommand("@planner start:  "), null);
  assert.equal(parseStartCommand("status"), null);
  assert.equal(
    parseStartCommand("@planner start: " + "x".repeat(5000))!.length,
    4000,
  );
  assert.deepEqual(
    parseProjectChatReply(
      'Hello\n```cobble-actions\n{}\n```\n```cobble-proposal\n{"goal":"  fix it  "}\n```',
    ),
    { prose: "Hello", proposal: { goal: "fix it" } },
  );
  for (const goal of ["", 42, "x".repeat(4001)])
    assert.equal(
      parseProjectChatReply(
        "```cobble-proposal\n" + JSON.stringify({ goal }) + "\n```",
      ).proposal,
      undefined,
    );
  assert.equal(
    parseProjectChatReply("```cobble-proposal\ninvalid\n```").prose,
    "",
  );
});

test("validation and prompt limits", async () => {
  const f = setup();
  try {
    await assert.rejects(f.chat.ask(f.team.id, "  "), /Type a message first/);
    const absent = new ProjectChat({
      teamStore: f.teamStore,
      team: () => null,
      plannerAdapter: () => undefined,
      backlog: async () => "",
    });
    await assert.rejects(
      absent.ask(f.team.id, "hello"),
      /Choose a workspace folder first/,
    );
    const noPlanner = new ProjectChat({
      teamStore: f.teamStore,
      team: () => f.team,
      plannerAdapter: () => undefined,
      backlog: async () => "",
    });
    await assert.rejects(noPlanner.ask(f.team.id, "hello"), /Assign an agent/);
    f.response({ finalText: '```cobble-proposal\n{"goal":"Fix chat"}\n```' });
    const answer = await f.chat.ask(f.team.id, "fix it");
    assert.equal(answer.reply.text, "Here is a proposed run:");
    for (const goal of [" ", "x".repeat(4001)]) {
      await assert.rejects(
        f.chat.startProposal(f.team.id, answer.proposal!.id, goal, async () => {
          throw new Error("should not start");
        }),
        /Describe the goal/,
      );
    }
    const prompt = projectChatPrompt(
      {
        team: f.team,
        answers: [],
        sessionBrief: null,
        runs: [],
        digest: "x".repeat(40000),
        backlog: [],
        history: [],
      },
      "latest message",
    );
    assert.equal(prompt.length, 30000);
    assert.ok(prompt.endsWith("latest message"));
  } finally {
    f.store.close();
  }
});

test(
  "service project chat answers, proposes, and starts real runs explicitly",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cobble-project-chat-"));
    const work = join(root, "work");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
    let service: CobbleService | undefined;
    try {
      mkdirSync(work);
      git("init", "-q", "-b", "main");
      writeFileSync(join(work, "README.md"), "hello\n");
      git("add", ".");
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
      const plannerCalls: AdapterRunInput[] = [];
      let reply = "Everything is ready.";
      const planner: AgentAdapter = {
        id: "claude",
        detect: async () => ({ agent: "claude", installed: true }),
        run: async (input) => {
          plannerCalls.push(input);
          return {
            exitCode: 0,
            durationMs: 1,
            finalText: input.readOnly
              ? reply
              : '```cobble-actions\n{"actions":[{"type":"wait"}]}\n```',
          };
        },
      };
      const coder: AgentAdapter = {
        id: "codex",
        detect: async () => ({ agent: "codex", installed: true }),
        run: async () => ({ exitCode: 0, durationMs: 1, finalText: "" }),
      };
      service = new CobbleService(join(root, "service.sqlite"), undefined, {
        teamWorktreeRoot: join(root, "trees"),
        teamAdapters: { claude: planner, codex: coder },
      });
      service.store.saveProfile("Owner", "");
      const team = service.store.createTeam("Team", "Build the app", work);
      service.teamStore.setRole(team.id, "planner", "claude");
      service.teamStore.setRole(team.id, "coder", "codex");
      service.store.set("activeTeamId", team.id);

      const status = await service.sendTeamChat(null, "what is the status?");
      assert.equal(status.runId, null);
      assert.equal(status.started, false);
      assert.equal(status.reply?.text, "Everything is ready.");
      assert.deepEqual(service.teamRuns(), []);
      assert.equal(plannerCalls[0].readOnly, true);

      reply = 'I can add it.\n```cobble-proposal\n{"goal":"Add a footer"}\n```';
      const answer = await service.sendTeamChat(null, "please add a footer");
      assert.equal(answer.runId, null);
      assert.equal(answer.started, false);
      assert.equal(answer.proposal?.kind, "proposal");
      assert.deepEqual(service.teamRuns(), []);
      const proposal = answer.proposal!;
      const run = await service.startTeamProposal(proposal.id);
      assert.equal(run.goal, proposal.proposal!.goal);
      assert.equal(service.teamRun(run.id).run.id, run.id);
      assert.deepEqual(
        service.teamProjectChat().find((message) => message.id === proposal.id)
          ?.proposal,
        { goal: run.goal, status: "started", runId: run.id },
      );
      // End the proposal run before testing the separate explicit start command.
      await service.teamRunCommand(run.id, "stop");
      const started = await service.sendTeamChat(
        null,
        "@planner start: Build X",
      );
      assert.equal(started.started, true);
      assert.ok(started.runId);
      assert.equal(service.teamRun(started.runId).run.goal, "Build X");
    } finally {
      await service?.close();
      assert.equal(
        resolve(root).startsWith(resolve(tmpdir()) + "/") ||
          resolve(root).startsWith(resolve(tmpdir()) + "\\"),
        true,
      );
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* Windows file locks */
      }
    }
  },
);
