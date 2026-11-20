import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppHubAction, AppHubSnapshot } from "../src/core/team/app-hub";
import {
  TeamNeedsYou,
  submitAppHubAction,
} from "../src/renderer/team-needs-you";
import { TeamHealthBanner } from "../src/renderer/team-health-banner";

const action = (
  kind: AppHubAction["kind"],
  humanOnly = false,
): AppHubAction => ({
  id: `target-${kind}`,
  label: kind,
  kind,
  runId: "run-1",
  taskId: "T1",
  gateId: "gate-1",
  humanOnly,
});
const fixture: AppHubSnapshot = {
  needsYou: [
    {
      id: "question",
      title: "Choose a theme",
      detail: "Blue or green?",
      actions: [action("answer")],
    },
    {
      id: "gate",
      title: "Review changes",
      actions: [
        action("approve"),
        action("deny"),
        action("skip"),
        action("retry"),
        action("review-later"),
      ],
    },
    {
      id: "production",
      title: "Production sign-in",
      detail: "Use the existing approval window.",
      actions: [action("approve", true), action("deny", true)],
    },
  ],
  health: [
    {
      id: "daemon",
      severity: "error",
      title: "Daemon stopped",
      actions: [action("restart")],
    },
    {
      id: "orphan",
      severity: "warning",
      title: "Orphaned run",
      actions: [action("recover")],
    },
    {
      id: "timeout",
      severity: "info",
      title: "Check timed out",
      detail: "Retry the check",
      actions: [action("retry-check")],
    },
  ],
};
const noop = () => {};

test("Needs you renders question input, permitted gates and human path instructions", () => {
  const html = renderToStaticMarkup(
    React.createElement(TeamNeedsYou, {
      items: fixture.needsYou,
      onAction: noop,
    }),
  );
  assert.match(html, /Choose a theme/);
  assert.match(html, /<form/);
  assert.match(html, /<label>.*answer.*<input/s);
  for (const label of ["approve", "deny", "retry", "skip", "review-later"]) {
    assert.match(html, new RegExp(`>${label}</button>`));
  }
  const human = renderToStaticMarkup(
    React.createElement(TeamNeedsYou, {
      items: [fixture.needsYou[2]],
      onAction: noop,
    }),
  );
  assert.match(human, /existing human approval or sign-in path/);
  assert.doesNotMatch(human, /<button|<input|<form/);
});

test("health displays severities and only supplied remediation actions", () => {
  const html = renderToStaticMarkup(
    React.createElement(TeamHealthBanner, {
      items: fixture.health,
      onAction: noop,
    }),
  );
  for (const label of ["restart", "recover", "retry-check"])
    assert.match(html, new RegExp(`>${label}</button>`));
  for (const severity of ["info", "warning", "error"])
    assert.match(html, new RegExp(`is-${severity}`));
  assert.doesNotMatch(html, />approve</);
});

test("empty states and external busy state are visible and disable controls", () => {
  assert.match(
    renderToStaticMarkup(
      React.createElement(TeamNeedsYou, { items: [], onAction: noop }),
    ),
    /Nothing needs your attention/,
  );
  assert.match(
    renderToStaticMarkup(
      React.createElement(TeamHealthBanner, { items: [], onAction: noop }),
    ),
    /No pipeline health issues reported/,
  );
  const html = renderToStaticMarkup(
    React.createElement(TeamHealthBanner, {
      items: fixture.health,
      onAction: noop,
      busyActionId: "target-restart",
    }),
  );
  assert.match(html, /restart…/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
  assert.match(html, /aria-busy="true"/);
});

test("submission preserves action target and trims answers, rejecting blank, busy and human-only submissions", async () => {
  const calls: [AppHubAction, string | undefined][] = [];
  const onAction = (value: AppHubAction, answer?: string) => {
    calls.push([value, answer]);
  };
  const question = action("answer");
  assert.equal(await submitAppHubAction(question, onAction, "  green  "), true);
  assert.deepEqual(calls, [[question, "green"]]);
  assert.equal(await submitAppHubAction(question, onAction, "  "), false);
  assert.equal(
    await submitAppHubAction(action("approve"), onAction, undefined, true),
    false,
  );
  for (const kind of ["approve", "deny", "answer", "restart"] as const) {
    assert.equal(
      await submitAppHubAction(action(kind, true), onAction, "yes"),
      false,
    );
  }
  assert.equal(calls.length, 1);
  const retry = action("retry");
  await submitAppHubAction(retry, onAction, "unused");
  assert.deepEqual(calls[1], [retry, undefined]);
});

test("action failures propagate to the renderer without a second authorization attempt", async () => {
  let calls = 0;
  await assert.rejects(
    submitAppHubAction(action("approve"), () => {
      calls++;
      throw new Error("Gate no longer pending");
    }),
    /Gate no longer pending/,
  );
  assert.equal(calls, 1);
});
