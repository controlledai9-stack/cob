import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  cleanAgentText,
  ClampedMessage,
  CHAT_PREVIEW_CHARS,
} from "../src/renderer/components/ui/agent-chat";
import { chatParticipants } from "../src/renderer/team-chat";
import type { TeamChatMessage } from "../src/shared/types";

test("agent messages hide code blocks and raw JSON, keep the words", () => {
  const raw = [
    "Done with T2: added the helpers.",
    "```ts",
    "export const x = 1;",
    "```",
    "{",
    '  "files": ["a.ts"],',
    '  "ok": true',
    "}",
    "Next: wire them into the chat.",
  ].join("\n");
  const clean = cleanAgentText(raw);
  assert.equal(
    clean.text,
    "Done with T2: added the helpers.\n\nNext: wire them into the chat.",
  );
  assert.equal(clean.hidden, 2);
  assert.equal(cleanAgentText('{"a":1}\nhi').text, "hi");
});

test("long agent messages are cut with Show more", () => {
  const long = "word ".repeat(400);
  const html = renderToStaticMarkup(
    React.createElement(ClampedMessage, {
      text: long,
      render: (text: string) => React.createElement("p", null, text),
    }),
  );
  assert.match(html, /Show more/);
  const shown = html.match(/<p>([^<]*)<\/p>/)![1]!;
  assert.ok(shown.length <= CHAT_PREVIEW_CHARS + 2, `${shown.length}`);
});

test("the people list has one entry per speaker and marks who is working", () => {
  const at = new Date().toISOString();
  const messages = [
    { id: "1", runId: "r", author: "user", kind: "message", text: "hi", createdAt: at },
    { id: "2", runId: "r", author: "agent", agent: "codex", role: "coder", member: "coder1", kind: "message", text: "ok", createdAt: at },
    { id: "3", runId: "r", author: "agent", agent: "codex", role: "coder", member: "coder1", kind: "report", text: "done", createdAt: at },
    { id: "4", runId: "r", author: "cobble", kind: "check", text: "passed", createdAt: at },
  ] as TeamChatMessage[];
  const people = chatParticipants(messages, [{ agent: "codex", role: "coder" }]);
  assert.deepEqual(
    people.map((p) => [p.name, !!p.active]),
    // People first, then Cobble, then agents by role.
    [
      ["You", false],
      ["Cobble", false],
      ["coder1", true],
    ],
  );
});

test("agent avatars: the role sets the colour, the member number the shape", async () => {
  const { shapeFor, roleColor } = await import(
    "../src/renderer/components/ui/agent-glyph"
  );
  assert.equal(shapeFor("coder1"), "circle");
  assert.equal(shapeFor("coder2"), "square");
  assert.equal(shapeFor("coder3"), "triangle");
  assert.equal(shapeFor("planner1"), "circle");
  assert.equal(shapeFor("reviewer"), shapeFor("reviewer"));
  assert.notEqual(roleColor("planner"), roleColor("coder"));
  assert.notEqual(roleColor("coder"), roleColor("generator"));
  assert.equal(roleColor("Coder"), roleColor("coder"));
});

test("planner messages and a member's own messages are told apart", () => {
  const at = new Date().toISOString();
  const people = chatParticipants([
    { id: "1", runId: "r", author: "agent", agent: "codex", role: "planner", member: "coder1", kind: "message", text: "a", createdAt: at },
    { id: "2", runId: "r", author: "agent", agent: "codex", role: "coder", member: "coder1", kind: "message", text: "b", createdAt: at },
  ] as TeamChatMessage[]);
  // The planner's chat messages are Cobble's one voice (even when they name a
  // member); coder1's own messages are coder1's.
  assert.deepEqual(people.map((p) => [p.name, p.role]), [["Cobble", "cobble"], ["coder1", "coder"]]);
});

test("the chat shows the planner is replying until it answers", async () => {
  const { awaitingPlanner } = await import("../src/renderer/team-chat");
  const m = (id: string, author: string, extra: object, minute: number) =>
    ({ id, runId: "r", author, kind: "message", text: id, createdAt: new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString(), ...extra }) as TeamChatMessage;
  const asked = [m("q", "user", {}, 1)];
  assert.equal(awaitingPlanner(asked), true);
  assert.equal(awaitingPlanner([...asked, m("a", "agent", { role: "planner", agent: "codex" }, 2)]), false);
  assert.equal(awaitingPlanner([m("t", "user", { to: "T1" }, 1)]), false, "messages to one task are not the planner's");
  assert.equal(awaitingPlanner([...asked, m("w", "agent", { role: "coder", agent: "codex" }, 2)]), true, "a worker post is not the planner's reply");
});

test("a team of 8 people with 16 agents: one entry per person and per agent", () => {
  const at = new Date().toISOString();
  const messages: TeamChatMessage[] = [];
  const people = ["Aarya", "Rahul", "Mira", "Dev", "Sana", "Kiran", "Leo", "Ivy"];
  people.forEach((name, i) => {
    messages.push({ id: `u${i}`, runId: "r", author: "user", kind: "message", text: "hi", createdAt: at, ...(i ? { memberName: name } : {}) } as TeamChatMessage);
    for (const role of ["coder", "generator"])
      messages.push({ id: `${role}${i}`, runId: "r", author: "agent", agent: "codex", role, member: `${role}${i + 1}`, kind: "message", text: "ok", createdAt: at } as TeamChatMessage);
  });
  const list = chatParticipants(messages);
  assert.equal(list.length, 8 + 16);
  assert.deepEqual(
    list.filter((p) => !p.role).map((p) => p.name),
    ["You", ...people.slice(1)],
  );
  assert.equal(new Set(list.map((p) => p.id)).size, list.length);
});

test("Your chat vs Team chat: agents' own talk goes to Team chat, Cobble never does", async () => {
  const { chatView } = await import("../src/renderer/team-chat");
  const m = (extra: object) => ({ id: "x", runId: "r", kind: "message", text: "t", createdAt: new Date().toISOString(), ...extra }) as TeamChatMessage;
  assert.equal(chatView(m({ author: "user" })), "you");
  assert.equal(chatView(m({ author: "cobble", kind: "check" })), "you");
  assert.equal(chatView(m({ author: "agent", role: "planner" })), "you", "the planner talking to you");
  assert.equal(chatView(m({ author: "agent", role: "researcher", kind: "report" })), "you");
  assert.equal(chatView(m({ author: "agent", role: "planner", kind: "delegate", taskId: "T1" })), "team");
  assert.equal(chatView(m({ author: "agent", role: "coder", kind: "report", taskId: "T1" })), "team");
  assert.equal(chatView(m({ author: "agent", role: "coder", kind: "question", taskId: "T1" })), "team");
});

test("writing to a paused run: says who is out, until when, and the instant answers", async () => {
  const { pausedReplyText } = await import("../src/core/service");
  const limited = pausedReplyText({ retryAt: "2026-11-20T00:45:00.000Z" }, "Codex");
  assert.match(limited, /The planner \(Codex\) has hit its usage limit and can't reply until .*Your message is saved/);
  assert.match(limited, /`status`, `limits` or `what needs me`/);
  assert.doesNotMatch(limited, /continue/);
  assert.match(pausedReplyText({ pausedReason: "Paused by you" }), /\(Paused by you\).*type \*\*continue\*\*/);
});

test("a planner hand-off is labelled as the planner handing work to a member", async () => {
  const { author, chatParticipants } = await import("../src/renderer/team-chat");
  const handOff = { id: "d", runId: "r", author: "agent", agent: "codex", role: "planner", member: "coder1", taskId: "T3", kind: "delegate", text: "@codex T3", createdAt: new Date().toISOString() } as TeamChatMessage;
  assert.equal(author(handOff), "Codex · planner → coder1");
  const report = { ...handOff, id: "r1", role: "coder", kind: "report" } as TeamChatMessage;
  assert.equal(author(report), "coder1 (Codex) · coder · T3");
  assert.deepEqual(chatParticipants([handOff, report]).map((p) => [p.name, p.role]), [["planner", "planner"], ["coder1", "coder"]]);
});

test("Your chat speaks with one voice: the planner's replies are Cobble", async () => {
  const { author, isCobbleVoice, chatParticipants } = await import("../src/renderer/team-chat");
  const at = new Date().toISOString();
  const reply = { id: "a", runId: "", author: "agent", agent: "claude", role: "planner", kind: "message", text: "Hi! Want the status?", createdAt: at } as TeamChatMessage;
  const handOff = { ...reply, id: "b", kind: "delegate", taskId: "T1", member: "coder1" } as TeamChatMessage;
  assert.equal(author(reply), "Cobble");
  assert.equal(isCobbleVoice(handOff), false);
  assert.equal(author(handOff), "Claude · planner → coder1");
  const note = { id: "c", runId: "", author: "cobble", kind: "message", text: "note", createdAt: at } as TeamChatMessage;
  assert.deepEqual(chatParticipants([reply, note]).map((p) => p.name), ["Cobble"]);
});
