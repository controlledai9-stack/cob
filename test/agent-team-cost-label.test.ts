import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  costLabel,
  formatCostParts,
  parseAgentLoginType,
} from "../src/shared/cost-label";
import {
  controlStatusText,
  type ControlStatusInput,
} from "../src/core/team/control-commands";
import { breakdownLines, usageCostText } from "../src/core/team/usage-report";
import { emptyUsage, runCostUsd } from "../src/core/team/usage";
import { AiUsageCard } from "../src/renderer/team-usage";

const subscription = "API-equivalent value (subscription, not billed)";
const api = "estimated API cost";
const base: ControlStatusInput = {
  runs: [],
  autopilot: { active: false },
  daemon: { running: false, pid: null },
  queue: [],
  lastMerges: [],
};

test("fixture login outputs produce exact cost labels and chat status wording", () => {
  const fixtures = [
    {
      agent: "claude",
      output: '{"loggedIn":true,"authMethod":"claude.ai"}',
      login: "subscription",
      label: subscription,
    },
    {
      agent: "codex",
      output: "Logged in using ChatGPT",
      login: "subscription",
      label: subscription,
    },
    {
      agent: "claude",
      output: '{"loggedIn":true,"authMethod":"api_key"}',
      login: "api",
      label: api,
    },
    {
      agent: "codex",
      output: "Logged in using an API key",
      login: "api",
      label: api,
    },
  ] as const;
  for (const fixture of fixtures) {
    const loginType = parseAgentLoginType(fixture.agent, fixture.output);
    assert.equal(loginType, fixture.login);
    assert.equal(costLabel(loginType), fixture.label);
    const text = controlStatusText({
      ...base,
      usage: { tokens: 20, costParts: [{ loginType, valueUsd: 1.25 }] },
    });
    assert.ok(
      text.includes(
        `Usage: tokens 20; ${formatCostParts([{ loginType, valueUsd: 1.25 }])}`,
      ),
    );
    assert.ok(text.includes(fixture.label));
    assert.ok(text.includes("$1.25"));
  }
});

test("unknown, mixed, explicit zero and legacy status retain provenance", () => {
  for (const output of ["", "{broken", '{"authMethod":"other"}']) {
    assert.equal(parseAgentLoginType("claude", output), "unknown");
  }
  assert.equal(
    parseAgentLoginType("unsupported", "Logged in using ChatGPT"),
    "unknown",
  );
  const parts = [
    { loginType: "subscription", valueUsd: 0 },
    { loginType: "api", valueUsd: 2 },
    { loginType: "unknown", valueUsd: 3 },
  ] as const;
  const text = controlStatusText({ ...base, usage: { costParts: [...parts] } });
  for (const value of [
    subscription,
    api,
    "$0.00",
    "$2.00",
    "$3.00",
    "(login type unknown)",
  ])
    assert.ok(text.includes(value));
  assert.ok(
    controlStatusText({ ...base, usage: { costUsd: 0 } }).includes("$0.00"),
  );
  assert.ok(
    controlStatusText({ ...base, usage: { costUsd: 4 } }).includes(
      "(login type unknown)",
    ),
  );
  assert.ok(controlStatusText(base).includes("unknown"));
  assert.equal(formatCostParts([]), "unknown");
});

test("run and digest breakdown presentation preserves cap accounting", () => {
  const usage = {
    ...emptyUsage(),
    calls: 1,
    costUsd: 2,
    cliCostUsd: 5,
    costParts: [
      { loginType: "api" as const, valueUsd: 2 },
      { loginType: "subscription" as const, valueUsd: 5 },
    ],
  };
  const before = JSON.stringify(usage);
  const text = usageCostText(usage);
  assert.ok(text.includes(subscription));
  assert.ok(text.includes(api));
  assert.ok(text.includes("$5.00"));
  const row = { key: "coder", agents: [], usage, tokens: "unknown" };
  assert.ok(
    breakdownLines({ byRole: [row], byMember: [] })
      .join("\n")
      .includes(text),
  );
  assert.equal(runCostUsd(usage, []), 2);
  assert.equal(JSON.stringify(usage), before);
  assert.ok(
    usageCostText({ ...emptyUsage(), cliCostUsd: 0 }).includes(
      "(login type unknown)",
    ),
  );
});

test("AI usage card renders labels while preserving quota and reset information", () => {
  const html = renderToStaticMarkup(
    createElement(AiUsageCard, {
      setStopAt() {},
      view: {
        stopAt: 95,
        agents: [
          {
            agent: "claude",
            loginType: "subscription",
            percent: 42,
            source: "reported",
            windowHours: 5,
            resetsAt: "2026-01-01T12:00:00Z",
            stopped: false,
            budgetTokens: null,
          },
          {
            agent: "codex",
            percent: null,
            source: "estimated",
            windowHours: null,
            resetsAt: null,
            stopped: false,
            budgetTokens: null,
          },
        ],
      },
    }),
  );
  assert.ok(html.includes(subscription));
  assert.ok(html.includes(api));
  assert.ok(html.includes("(login type unknown)"));
  assert.ok(html.includes('aria-valuenow="42"'));
  assert.ok(html.includes('dateTime="2026-01-01T12:00:00Z"'));
});
