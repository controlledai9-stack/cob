import type { UsageLimitsView } from "../../src/shared/usage-view";

export const usageFixture: UsageLimitsView = {
  stopAt: 95,
  agents: [
    {
      agent: "codex",
      percent: 42,
      source: "reported",
      windowHours: 5,
      resetsAt: "2026-11-16T12:00:00Z",
      stopped: false,
      budgetTokens: null,
    },
    {
      agent: "claude",
      percent: 97,
      source: "estimated",
      windowHours: 5,
      resetsAt: "2026-11-16T13:00:00Z",
      stopped: true,
      budgetTokens: 100000,
    },
    {
      agent: "gemini",
      percent: null,
      source: "estimated",
      windowHours: null,
      resetsAt: null,
      stopped: false,
      budgetTokens: null,
    },
  ],
};
