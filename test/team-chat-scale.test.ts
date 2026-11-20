import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamChat, chatParticipants } from "../src/renderer/team-chat";
import { AgentChatShell } from "../src/renderer/components/ui/agent-chat";
import {
  CHAT_PAGE,
  createCoalescer,
  filterParticipants,
  pageMessages,
} from "../src/renderer/chat-scale";
import type { TeamChatMessage } from "../src/shared/types";

const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const many = Array.from({ length: 2000 }, (_, i) => ({
  id: `m${i}`,
  runId: "r",
  author: "user",
  kind: "message",
  text: `message ${i}`,
  createdAt: at(i),
})) as TeamChatMessage[];

test("2,000 messages render the latest 200 with Show earlier", () => {
  const html = renderToStaticMarkup(
    React.createElement(TeamChat, {
      api: { teamChat: async () => [], sendTeamChat: async () => ({ runId: "r", started: false }) },
      snapshot: null,
      pending: false,
      canStart: true,
      canChat: true,
      chatHint: "",
      startProposal: async () => {},
      startHint: "",
      start: async () => {},
      command: () => {},
      onChanged: () => {},
      initialMessages: many,
    }),
  );
  assert.equal(html.match(/class="agent-team-chat-message /g)?.length, CHAT_PAGE);
  assert.match(html, /Show earlier \(1800 more\)/);
  assert.match(html, /message 1999/);
  assert.doesNotMatch(html, />message 1799</);
});

test("the next page adds 200 older messages", () => {
  const first = pageMessages(many, CHAT_PAGE);
  const next = pageMessages(many, CHAT_PAGE * 2);
  assert.equal(next.visible.length, 400);
  assert.equal(next.hidden, 1600);
  assert.deepEqual(next.visible.slice(200), first.visible);
});

test("24 people and agents: people first, agents by role, searchable", () => {
  const messages: TeamChatMessage[] = [];
  const roles = ["reviewer", "coder", "researcher", "generator"];
  for (let i = 0; i < 16; i++) {
    const role = roles[i % 4]!;
    messages.push({ id: `a${i}`, runId: "r", author: "agent", agent: "codex", role, member: `${role}${Math.floor(i / 4) + 1}`, kind: "message", text: "x", createdAt: at(i) } as TeamChatMessage);
  }
  for (const name of ["Rahul", "Mira", "Dev", "Sana", "Kiran", "Leo", "Ivy"])
    messages.push({ id: name, runId: "r", author: "user", memberName: name, kind: "message", text: "hi", createdAt: at(50) } as TeamChatMessage);
  messages.push({ id: "me", runId: "r", author: "user", kind: "message", text: "hi", createdAt: at(60) } as TeamChatMessage);
  const list = chatParticipants(messages);
  assert.equal(list.length, 24);
  assert.deepEqual(list.slice(0, 8).map((p) => p.name), ["You", "Rahul", "Mira", "Dev", "Sana", "Kiran", "Leo", "Ivy"]);
  assert.deepEqual(list.slice(8, 12).map((p) => p.name), ["coder1", "coder2", "coder3", "coder4"]);
  assert.deepEqual(list.slice(12, 16).map((p) => p.name), ["generator1", "generator2", "generator3", "generator4"]);
  assert.deepEqual(filterParticipants(list, "REVIEW").map((p) => p.name), ["reviewer1", "reviewer2", "reviewer3", "reviewer4"]);
  const html = renderToStaticMarkup(
    React.createElement(AgentChatShell, {
      title: "Team Chat",
      participants: list,
      selected: null,
      onSelect: () => {},
      footer: null,
      children: null,
    }),
  );
  assert.match(html, /aria-label="Find a person or agent"/);
});

test("50 rapid change events cause one chat refresh", () => {
  const pending: (() => void)[] = [];
  let cleared = 0;
  let refreshes = 0;
  const coalescer = createCoalescer(() => refreshes++, 150, {
    set: (fn) => {
      pending.push(fn);
      return pending.length - 1;
    },
    clear: () => {
      cleared++;
    },
  });
  for (let i = 0; i < 50; i++) coalescer.trigger();
  assert.equal(cleared, 49);
  pending.at(-1)!();
  assert.equal(refreshes, 1);
});
