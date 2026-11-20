import { CobbleService } from "../src/core/service";
import { UsageLimits, memorySettings } from "../src/core/team/usage-limits";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentLoginType,
  costLabel,
  formatCostParts,
} from "../src/shared/cost-label";
import {
  claudeSpec,
  codexSpec,
  cliUsage,
  detectAgentLoginType,
  type AuthStatusRunner,
} from "../src/core/team/adapters";
import {
  addUsage,
  emptyUsage,
  totalUsage,
  runCostUsd,
} from "../src/core/team/usage";
import type { TeamUsage } from "../src/core/team/types";

test("login fixtures yield normalized labels without identity data", () => {
  for (const [agent, output, expected] of [
    [
      "claude",
      '{"loggedIn":true,"authMethod":"claude.ai","email":"private@example.test"}',
      "subscription",
    ],
    ["claude", '{"authMethod":"api_key"}', "api"],
    ["codex", "Logged in using ChatGPT", "subscription"],
    ["codex", "Logged in using an API key - fixture-redacted", "api"],
  ] as const) {
    const loginType = parseAgentLoginType(agent, output);
    assert.equal(loginType, expected);
    assert.equal(
      costLabel(loginType),
      expected === "subscription"
        ? "API-equivalent value (subscription, not billed)"
        : "estimated API cost",
    );
    assert.doesNotMatch(
      formatCostParts([{ loginType, valueUsd: 1 }]),
      /private|fixture-redacted/,
    );
  }
  for (const [agent, output] of [
    ["claude", "malformed"],
    ["claude", "null"],
    ["claude", "{}"],
    ["claude", '{"authMethod":"claude.ai","loggedIn":false}'],
    ["claude", '{"authMethod":"other"}'],
    ["gemini", "Logged in using ChatGPT"],
    ["codex", "Not logged in"],
    ["codex", "ChatGPT"],
    ["codex", "Logged in using ChatGPT\nLogged in using an API key"],
    ["codex", "x".repeat(16_385)],
  ])
    assert.equal(parseAgentLoginType(agent, output), "unknown");
});

test("auth detection uses fixed noninteractive commands and fake runners", async () => {
  const calls: unknown[] = [];
  const runner: AuthStatusRunner = async (file, args, timeout) => {
    calls.push({ file, args, timeout });
    return {
      code: 0,
      stdout: args[0] === "auth" ? '{"authMethod":"claude.ai"}' : "",
      stderr: args[0] === "login" ? "Logged in using ChatGPT" : "",
    };
  };
  assert.equal(
    await detectAgentLoginType("claude", "fake", runner),
    "subscription",
  );
  assert.equal(
    await detectAgentLoginType("codex", "fake", runner),
    "subscription",
  );
  assert.deepEqual(calls, [
    { file: "fake", args: ["auth", "status", "--json"], timeout: 3000 },
    { file: "fake", args: ["login", "status"], timeout: 3000 },
  ]);
  assert.equal(
    await detectAgentLoginType("unsupported", "fake", runner),
    "unknown",
  );
  assert.equal(calls.length, 2);
  assert.equal(
    await detectAgentLoginType("codex", "fake", async () => {
      throw new Error("private");
    }),
    "unknown",
  );
  assert.equal(
    await detectAgentLoginType("codex", "fake", async () => ({
      code: 1,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    })),
    "unknown",
  );
  assert.equal(
    await detectAgentLoginType("codex", "fake", async () => ({
      code: 0,
      timedOut: true,
      stdout: "Logged in using ChatGPT",
      stderr: "",
    })),
    "unknown",
  );
  assert.equal(
    await detectAgentLoginType("codex", "fake", () => new Promise(() => {}), 5),
    "unknown",
  );
});

test("mixed aggregation preserves provenance, legacy values once, and API cap arithmetic", () => {
  const legacy: TeamUsage = {
    ...emptyUsage(),
    calls: 1,
    costUsd: 2,
    cliCostUsd: 3,
  };
  const cli: TeamUsage = {
    ...emptyUsage(),
    calls: 1,
    loginType: "subscription",
    cliCostUsd: 4,
    costParts: [{ loginType: "subscription", valueUsd: 4 }],
  };
  const api: TeamUsage = {
    ...emptyUsage(),
    calls: 1,
    loginType: "api",
    costUsd: 1,
    costParts: [{ loginType: "api", valueUsd: 1 }],
  };
  const combined = totalUsage(legacy, [{ usage: cli }, { usage: api }])!;
  assert.equal(runCostUsd(legacy, [{ usage: cli }, { usage: api }]), 3);
  assert.equal(combined.cliCostUsd, 7);
  assert.deepEqual(combined.costParts, [
    { loginType: "unknown", valueUsd: 5 },
    { loginType: "subscription", valueUsd: 4 },
    { loginType: "api", valueUsd: 1 },
  ]);
  const again = addUsage(emptyUsage(), combined);
  addUsage(again, cli);
  assert.equal(
    again.costParts?.find((p) => p.loginType === "subscription")?.valueUsd,
    8,
  );
  assert.equal(legacy.loginType, undefined);
  assert.equal(cli.loginType, "subscription");
  assert.equal(formatCostParts([]), "unknown");
  assert.equal(
    formatCostParts([{ loginType: "unknown", valueUsd: 0 }]),
    "$0.00 estimated API cost (login type unknown)",
  );
});

test("CLI collection snapshots login provenance and only reported monetary values", () => {
  const output = '{"usage":{"input_tokens":1},"total_cost_usd":0.25}';
  const original = cliUsage(claudeSpec, output, "subscription");
  const later = cliUsage(claudeSpec, output, "api");
  assert.equal(original.loginType, "subscription");
  assert.deepEqual(original.costParts, [
    { loginType: "subscription", valueUsd: 0.25 },
  ]);
  assert.equal(original.costUsd, 0);
  assert.equal(later.loginType, "api");
  assert.deepEqual(
    cliUsage(
      codexSpec,
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
      "subscription",
    ).costParts,
    [],
  );
});

test("per-agent view reads normalized detection without launching commands", () => {
  const limits = new UsageLimits(memorySettings(), Date.now);
  const service = Object.assign(Object.create(CobbleService.prototype), {
    limits,
    lastDetection: [
      { agent: "claude", installed: true, loginType: "subscription" },
    ],
  }) as CobbleService;
  const view = service.teamUsageLimits();
  assert.equal(
    view.agents.find((agent) => agent.agent === "claude")?.loginType,
    "subscription",
  );
  assert.equal(
    view.agents.find((agent) => agent.agent === "codex")?.loginType,
    "unknown",
  );
  assert.equal(
    view.agents.find((agent) => agent.agent === "claude-api")?.loginType,
    "api",
  );
  assert.doesNotMatch(JSON.stringify(view), /authMethod|private|token_value/);
});
