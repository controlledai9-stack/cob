import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPlanFromBacklog } from "../src/core/team/build-plan";
import { BuildPlanPanel } from "../src/renderer/build-plan-panel";

const backlog = [
  "# Backlog",
  "- [x] (run 4d381e13) Token efficiency 1 — measure where tokens go: long text",
  "- [!] Debug specialist: an optional debugger — needs attention: Run 47fa09b8 conflicts with cobble/autopilot; its branch is kept",
  "- [m] (Claude is doing this one) Review the pilot, daemon: long text",
  "- [ ] Research mode, part 1 — sources and a research library: long",
  "- [ ] Demo flow end to end: one scripted scenario",
  "not a backlog line",
].join("\n");

test("the build plan groups the backlog into running, next, attention, Claude and done", () => {
  const view = buildPlanFromBacklog(
    backlog,
    ["Backlog item: Research mode, part 1 — sources and a research library: long"],
    "cobble/autopilot",
  );
  assert.deepEqual(view.running.map((i) => i.label), ["Research mode, part 1"]);
  assert.deepEqual(view.next.map((i) => i.label), ["Demo flow end to end"]);
  assert.deepEqual(view.attention, [
    {
      label: "Debug specialist",
      note: "Run 47fa09b8 conflicts with cobble/autopilot; its branch is kept",
    },
  ]);
  assert.deepEqual(view.claude.map((i) => i.label), ["Review the pilot, daemon"]);
  assert.deepEqual(view.done, [{ label: "Token efficiency 1", note: "run 4d381e13" }]);
});

test("the Build plan panel shows the groups with counts", () => {
  const html = renderToStaticMarkup(
    React.createElement(BuildPlanPanel, {
      initial: buildPlanFromBacklog(backlog, [], "cobble/autopilot"),
    }),
  );
  for (const text of ["Build plan", "1 of 5 done", "Next", "Needs attention", "Waiting for Claude", "Done", "Demo flow end to end"])
    assert.ok(html.includes(text), text);
});
