import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PassThrough } from "node:stream";
import {
  ControlCard,
  ProposalCard,
  ProposalItems,
} from "../src/renderer/team-chat";
import { runChatRepl, type ChatReplApi } from "../src/core/team/chat-repl";
import type { TeamChatMessage } from "../src/core/team/types";

function message(extra: Partial<TeamChatMessage> = {}): TeamChatMessage {
  return {
    id: "m1",
    runId: "",
    author: "cobble",
    kind: "message",
    text: "Status ready",
    createdAt: "2026-11-16T00:00:00Z",
    ...extra,
  };
}
const pending = message({
  kind: "control",
  control: { command: { kind: "stop" }, status: "pending" },
});
const proposal = message({
  kind: "proposal",
  proposal: { goal: "Build", items: ["First", "Second"], status: "open" },
});

test("control cards render confirmation or terminal status and escaped result", () => {
  const html = renderToStaticMarkup(
    React.createElement(ControlCard, {
      message: pending,
      confirm: async () => {},
    }),
  );
  assert.match(html, />Confirm</);
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, /disabled/);
  for (const status of ["done", "cancelled", "failed"] as const) {
    const result = renderToStaticMarkup(
      React.createElement(ControlCard, {
        message: message({
          control: { command: { kind: "stop" }, status, result: "<result>" },
        }),
      }),
    );
    assert.match(
      result,
      new RegExp(status[0]!.toUpperCase() + status.slice(1)),
    );
    assert.match(result, /&lt;result&gt;/);
    assert.doesNotMatch(result, /<button/);
  }
});

test("item proposals render backlog and individual start buttons; legacy goals still render", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProposalItems, {
      message: proposal,
      add: async () => {},
      startItem: async () => {},
    }),
  );
  assert.match(html, /Add to backlog/);
  assert.equal((html.match(/Start now/g) ?? []).length, 2);
  assert.doesNotMatch(html, /disabled/);
  const added = renderToStaticMarkup(
    React.createElement(ProposalItems, {
      message: {
        ...proposal,
        proposal: { ...proposal.proposal!, status: "added" },
      },
      add: async () => {},
    }),
  );
  assert.match(added, /disabled="">Add to backlog/);
  const legacy = renderToStaticMarkup(
    React.createElement(ProposalCard, {
      message: message({ proposal: { goal: "Legacy goal", status: "open" } }),
      busy: false,
      canStart: true,
      startHint: "",
      start: async () => {},
    }),
  );
  assert.match(legacy, /Legacy goal/);
  assert.match(legacy, /Start run/);
});

function fixture() {
  const calls: unknown[][] = [];
  const api: ChatReplApi = {
    async teamControl(text) {
      calls.push(["control", text]);
      return {
        message:
          text === "stop" ? pending : text === "plan" ? proposal : message(),
      };
    },
    async confirmTeamControl(id, yes) {
      calls.push(["confirm", id, yes]);
      return message({ text: yes ? "Stopped" : "Cancelled" });
    },
    async addTeamProposalToBacklog(id) {
      calls.push(["add", id]);
      return message({ text: "Added" });
    },
    async startTeamProposalItem(id, item) {
      calls.push(["start", id, item]);
    },
  };
  return { api, calls };
}
async function run(
  text: string,
  api: ChatReplApi,
  opts?: Parameters<typeof runChatRepl>[2],
) {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += String(chunk);
  });
  const done = runChatRepl(api, { input, output }, opts);
  input.end(text);
  await done;
  return printed;
}

test("REPL prints status and confirms only y/yes; N and blank cancel", async () => {
  const { api, calls } = fixture();
  const output = await run(
    "status\nstop\ny\nstop\nN\nstop\n\nstop\nyes\nquit\n",
    api,
  );
  assert.match(output, /Status ready/);
  assert.match(output, /\[y\/N\]/);
  assert.deepEqual(
    calls.filter((c) => c[0] === "confirm").map((c) => c[2]),
    [true, false, false, true],
  );
});

test("REPL adds a proposal and starts numbered items only once", async () => {
  const { api, calls } = fixture();
  const output = await run(
    "plan\nadd\nadd\nstart 2\nstart 2\nstart 1\nstart 9\nexit\n",
    api,
  );
  assert.match(output, /1\. First\n2\. Second/);
  assert.deepEqual(
    calls.filter((c) => c[0] !== "control"),
    [
      ["add", "m1"],
      ["start", "m1", "Second"],
      ["start", "m1", "First"],
    ],
  );
});

test("REPL refuses confirmation when active team changes", async () => {
  const { api, calls } = fixture();
  let active = "a";
  const control = api.teamControl;
  api.teamControl = async (text) => {
    const result = await control(text);
    active = "b";
    return result;
  };
  const output = await run("stop\ny\n", api, {
    teamId: "a",
    activeTeamId: () => active,
  });
  assert.match(output, /active team changed/);
  assert.equal(calls.filter((c) => c[0] === "confirm").length, 0);
});

test("REPL blocks exit while canExit gives a reason, then accepts exit", async () => {
  const { api, calls } = fixture();
  let checks = 0;
  const output = await run("exit\nstatus\nquit\n", api, {
    canExit: () => (++checks === 1 ? "Work still running" : null),
  });
  assert.match(output, /Work still running/);
  assert.deepEqual(calls, [["control", "status"]]);
  let eofChecks = 0;
  assert.match(
    await run("", api, {
      canExit: () => (++eofChecks < 3 ? "Work still running" : null),
    }),
    /Work still running/,
  );
  assert.ok(eofChecks >= 3);
});
