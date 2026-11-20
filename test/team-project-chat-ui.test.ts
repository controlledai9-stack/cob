import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  loadChatMessages,
  mergeChatMessages,
  ProposalCard,
  sendChatMessage,
  TeamChat,
} from "../src/renderer/team-chat";
import type { DesktopApi, TeamChatMessage } from "../src/shared/types";

const message = (id: string, minute: number): TeamChatMessage => ({
  id,
  runId: "",
  author: "agent",
  role: "planner",
  kind: "message",
  text: id,
  createdAt: new Date(Date.UTC(2026, 10, 14, 10, minute)).toISOString(),
});

test("project and run messages share a chronological thread, including without a run", async () => {
  const project = [message("project", 2)];
  const run = [message("run", 1), message("later", 3)];
  const api = {
    teamProjectChat: async () => project,
    teamChat: async () => run,
    sendTeamChat: async () => ({ runId: null, started: false }),
  };
  assert.deepEqual(
    (await loadChatMessages(api, "r")).map((m) => m.id),
    ["run", "project", "later"],
  );
  assert.deepEqual(await loadChatMessages(api), project);
  assert.deepEqual(
    await loadChatMessages({ ...api, teamProjectChat: undefined }),
    [],
  );
  assert.deepEqual(
    mergeChatMessages(project, run).map((m) => m.id),
    ["run", "project", "later"],
  );
  assert.equal(project.length, 1);
});

test("ordinary idle chat asks the planner; explicit commands start with the parsed goal", async () => {
  const sent: [string | null, string][] = [];
  const goals: string[] = [];
  const api = {
    teamChat: async () => [],
    sendTeamChat: (async (id, text) => {
      sent.push([id, text]);
      return { runId: id, started: false };
    }) as NonNullable<DesktopApi["sendTeamChat"]>,
  };
  const start = async (goal: string) => {
    goals.push(goal);
  };
  await sendChatMessage(api, null, "What is the status?", start);
  await sendChatMessage(
    api,
    null,
    "  @planner start:  Build the page  ",
    start,
  );
  await sendChatMessage(api, "live", "@planner start: discuss this", start);
  assert.deepEqual(sent, [
    [null, "What is the status?"],
    ["live", "@planner start: discuss this"],
  ]);
  assert.deepEqual(goals, ["Build the page"]);
});

test("proposal offers Start run and Edit; started proposals only show Started", () => {
  const proposal: TeamChatMessage = {
    ...message("proposal", 1),
    kind: "proposal",
    text: "Build <a page>",
    proposal: { goal: "Build <a page>", status: "open" },
  };
  const render = () =>
    renderToStaticMarkup(
      React.createElement(ProposalCard, {
        message: proposal,
        busy: false,
        canStart: true,
        startHint: "",
        start: async () => {},
      }),
    );
  const open = render();
  assert.match(open, /agent-team-chat-card/);
  assert.match(open, />Start run</);
  assert.match(open, />Edit</);
  assert.match(open, /Build &lt;a page&gt;/);
  proposal.proposal = { goal: proposal.text, status: "started", runId: "r" };
  const started = render();
  assert.match(started, />Started</);
  assert.doesNotMatch(started, /<button/);
});

test("proposal edit mode offers Start run and Cancel", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProposalCard, {
      message: {
        ...message("proposal", 1),
        kind: "proposal",
        proposal: { goal: "Original goal", status: "open" },
      },
      busy: false,
      canStart: true,
      startHint: "",
      start: async () => {},
      initialEditing: true,
    }),
  );
  assert.match(
    html,
    /<textarea[^>]*aria-label="Edit proposed goal"[^>]*>Original goal<\/textarea>/,
  );
  assert.match(html, />Start run</);
  assert.match(html, />Cancel</);
  assert.doesNotMatch(html, />Edit<|Done editing/);
});

test("blocked chat omits an empty hint paragraph", () => {
  const render = (chatHint: string) =>
    renderToStaticMarkup(
      React.createElement(TeamChat, {
        api: {
          teamChat: async () => [],
          sendTeamChat: async () => ({ runId: null, started: false }),
        },
        snapshot: null,
        pending: false,
        canStart: false,
        canChat: false,
        chatHint,
        startHint: "",
        startProposal: async () => {},
        start: async () => {},
        command: () => {},
        onChanged: () => {},
      }),
    );
  assert.doesNotMatch(render(""), /<p class="small">/);
  assert.match(
    render("Choose a workspace folder first."),
    /<p class="small">Choose a workspace folder first\.<\/p>/,
  );
});
