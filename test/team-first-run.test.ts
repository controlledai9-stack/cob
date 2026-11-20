import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../src/core/store";
import { TeamStore } from "../src/core/team/team-store";
import { bestAvailableMembers } from "../src/core/team/member-setup";
import { FirstRunCard, shouldOpenSetup } from "../src/renderer/first-run-card";

const render = (props: Partial<React.ComponentProps<typeof FirstRunCard>> = {}) =>
  renderToStaticMarkup(
    React.createElement(FirstRunCard, {
      detected: [{ agent: "codex", installed: true, version: "1.0" }, { agent: "claude", installed: false }],
      detecting: false,
      onDetect: () => {},
      proposed: bestAvailableMembers([{ agent: "codex", installed: true }]),
      hasMembers: false,
      accept: async () => {},
      brief: React.createElement("form", { "aria-label": "Session brief" }),
      startPilot: async () => {},
      close: () => {},
      ...props,
    }),
  );

test("an empty project shows the setup card with agents, a proposed team and the brief", () => {
  const html = render();
  for (const text of ["Set up your AI team", "Codex", "planner1", "coder1", "Accept this team", "Session brief", "Start Pilot", "Skip to chat"])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /Claude Code/, "agents that are not installed are not listed");
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start Pilot/, "Pilot needs a team first");
  assert.match(render({ detected: [] }), /No agent found/);
  assert.match(render({ hasMembers: true }), /Your team is set/);
});

test("accepting the proposed team stores it, free/local first when nothing else is installed", () => {
  const store = new Store(":memory:");
  try {
    store.saveProfile("Owner", "");
    const team = store.createTeam("T", "Plan", process.cwd());
    const members = new TeamStore(store);
    assert.equal(shouldOpenSetup(members.members(team.id)), true);
    for (const input of bestAvailableMembers([{ agent: "free", installed: true }]))
      members.addMember(team.id, input);
    const saved = members.members(team.id);
    assert.ok(saved.length >= 4);
    assert.ok(saved.every((m) => m.agent === "free"));
    // Once a team exists the normal chat shows instead of the card.
    assert.equal(shouldOpenSetup(saved), false);
  } finally {
    store.db.close();
  }
});

test("the brief form inside setup saves like the normal brief", async () => {
  const { CobbleService } = await import("../src/core/service");
  const service = new CobbleService(":memory:");
  try {
    service.store.saveProfile("Owner", "");
    service.store.createTeam("T", "Plan", process.cwd());
    const saved = service.saveTeamSessionBrief({
      time: "7",
      hoursPerDay: "",
      agents: "codex",
      apiSpendLimitUsd: "",
      priority: "Ship the demo",
    });
    assert.equal(saved.priority, "Ship the demo");
    assert.deepEqual(saved.agents, ["codex"]);
  } finally {
    await service.close();
  }
});
