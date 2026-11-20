import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { ProjectChat, parseProjectChatReply } from "../src/core/team/project-chat";
import type { AgentAdapter } from "../src/core/team/adapters";
import type { TeamAgentId } from "../src/core/team/types";
import { withOutsideAutomation } from "../src/core/service";

function fixture(opts: { plannerStopped?: boolean; plannerFails?: boolean }) {
  const store = new Store(":memory:");
  store.saveProfile("Owner", "");
  const team = store.createTeam("T", "Plan", process.cwd());
  const teamStore = new TeamStore(store);
  const asked: string[] = [];
  const prompts: string[] = [];
  const forwarded: string[] = [];
  const adapter = (id: TeamAgentId, reply: string, fail = false): AgentAdapter => ({
    id,
    detect: async () => ({ agent: id, installed: true }),
    async run(input) {
      asked.push(id);
      prompts.push(input.prompt);
      return fail
        ? { exitCode: 1, durationMs: 1, finalText: "429 usage limit", rateLimited: true }
        : { exitCode: 0, durationMs: 1, finalText: reply };
    },
  });
  const chat = new ProjectChat({
    teamStore,
    team: (id) => store.team(id),
    plannerAdapter: () => ({ agent: "codex", adapter: adapter("codex", "Hello from Codex", opts.plannerFails) }),
    chatFallbacks: () => [{ agent: "claude", adapter: adapter("claude", "Hello! Want the status?\n```cobble-forward\nAdd a footer to the page\n```") }],
    liveStatus: async () => "Working: Codex is building the footer.",
    forward: (_id, instruction) => forwarded.push(instruction),
    backlog: async () => "",
    limits: {
      status: (agent: TeamAgentId) => ({ agent, stopped: agent === "codex" && !!opts.plannerStopped }),
      stopsSince: () => [],
    } as never,
  });
  return { store, team, chat, asked, prompts, forwarded };
}

test("a planner at its usage limit is skipped: another model replies", async () => {
  const f = fixture({ plannerStopped: true });
  try {
    const { reply, forwarded } = await f.chat.ask(f.team.id, "hi");
    assert.deepEqual(f.asked, ["claude"]);
    assert.equal(reply.text, "Hello! Want the status?");
    assert.equal(reply.agent, "claude");
    assert.equal(forwarded, "Add a footer to the page");
    assert.deepEqual(f.forwarded, ["Add a footer to the page"]);
    assert.match(f.prompts[0]!, /You are Cobble/);
    assert.match(f.prompts[0]!, /Working: Codex is building the footer\./);
  } finally {
    f.store.db.close();
  }
});

test("a planner turn that fails falls through to the next model", async () => {
  const f = fixture({ plannerFails: true });
  try {
    const { reply } = await f.chat.ask(f.team.id, "hi");
    assert.deepEqual(f.asked, ["codex", "claude"]);
    assert.equal(reply.agent, "claude");
  } finally {
    f.store.db.close();
  }
});

test("the planner answers when it can; a forward block is not shown", async () => {
  const f = fixture({});
  try {
    const { reply } = await f.chat.ask(f.team.id, "hi");
    assert.deepEqual(f.asked, ["codex"]);
    assert.equal(reply.text, "Hello from Codex");
    assert.equal(parseProjectChatReply("Sure.\n```cobble-forward\nDo X\n```").prose, "Sure.");
  } finally {
    f.store.db.close();
  }
});

test("Pilot in another process counts as on while its process is alive", () => {
  const off = { active: false, branch: "", worktree: "", backlogPath: "", completed: [] } as never;
  const record = { options: { pilot: true, parallel: 2 }, heartbeatAt: 1_000_000, ownerPid: 42 };
  const now = 1_000_000 + 8 * 60_000;
  assert.equal(withOutsideAutomation(off, record, now, () => true).pilot, true);
  assert.equal(withOutsideAutomation(off, record, now, () => false).active, false);
  assert.equal(withOutsideAutomation(off, record, now + 40 * 60_000, () => true).active, false);
});
