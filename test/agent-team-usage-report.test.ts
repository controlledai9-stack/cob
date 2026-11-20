import test from "node:test";
import assert from "node:assert/strict";
import {
  usageBreakdown,
  mergeBreakdowns,
  breakdownLines,
} from "../src/core/team/usage-report";
import { emptyUsage, formatTokens } from "../src/core/team/usage";
import { buildDigest } from "../src/core/team/digest";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
} from "../src/core/team/types";

const known = {
  ...emptyUsage(),
  calls: 1,
  inputTokens: 1234,
  outputTokens: 56,
  cliCostUsd: 0.12,
};

test("planner fallback, unknown turns, switched agents and ordering", () => {
  const b = usageBreakdown({
    run: { plannerTurns: 2, plannerSwitchedFrom: "claude" },
    plannerAgent: "codex",
    plannerMember: "lead",
    tasks: [
      { role: "reviewer", member: "zeta", agent: "gemini", startedAt: "now" },
      {
        role: "coder",
        member: "alpha",
        agent: "codex",
        switchedFrom: "claude",
        usage: known,
      },
      { role: "generator", agent: "codex" },
    ],
  });
  assert.deepEqual(
    b.byRole.map((r) => r.key),
    ["planner", "coder", "reviewer"],
  );
  assert.deepEqual(
    b.byMember.map((r) => r.key),
    ["alpha", "lead", "zeta"],
  );
  assert.deepEqual(b.byRole[0].agents, ["claude", "codex"]);
  assert.equal(b.byRole[0].usage.calls, 2);
  assert.equal(b.byRole[0].usage.unknownCalls, 2);
  assert.equal(b.byRole[0].tokens, "unknown");
  assert.equal(b.byRole[2].usage.unknownCalls, 1);
  assert.deepEqual(b.byRole[1].agents, ["claude", "codex"]);
  assert.ok(
    breakdownLines(b).includes(
      "- coder (claude, codex): 1,234 in / 56 out / 0 cached; $0.12 estimated API cost (login type unknown)",
    ),
  );
  const explicit = usageBreakdown({
    run: { plannerTurns: 1, plannerAgent: "gemini", plannerUsage: known },
    tasks: [],
    plannerAgent: "codex",
  });
  assert.deepEqual(explicit.byRole[0].agents, ["gemini"]);
  assert.equal(explicit.byMember[0].key, "planner");
});

test("planner turns missing from partial usage count as unknown without mutating usage", () => {
  const usage = { ...known, calls: 2, unknownCalls: 1 };
  const b = usageBreakdown({
    run: { plannerTurns: 4, plannerUsage: usage },
    tasks: [],
  });
  for (const row of [b.byRole[0], b.byMember[0]]) {
    assert.equal(row.usage.calls, 4);
    assert.equal(row.usage.unknownCalls, 3);
    assert.equal(row.tokens, "1,234 in / 56 out / 0 cached (+3 turns unknown)");
    assert.equal(row.usage.cliCostUsd, 0.12);
  }
  assert.deepEqual(usage, { ...known, calls: 2, unknownCalls: 1 });
});

test("merge sums usage without mutating inputs and retains partial unknowns", () => {
  const a = usageBreakdown({
    run: { plannerTurns: 0 },
    tasks: [{ role: "coder", agent: "codex", usage: known }],
  });
  const b = usageBreakdown({
    run: { plannerTurns: 0 },
    tasks: [{ role: "coder", agent: "claude", startedAt: "now" }],
  });
  const merged = mergeBreakdowns([a, b, b]);
  assert.equal(
    merged.byRole[0].tokens,
    "1,234 in / 56 out / 0 cached (+2 turns unknown)",
  );
  assert.deepEqual(merged.byRole[0].agents, ["claude", "codex"]);
  assert.equal(a.byRole[0].usage.calls, 1);
  const doubled = mergeBreakdowns([a, a]);
  assert.deepEqual(doubled.byRole[0].agents, ["codex"]);
  assert.equal(doubled.byRole[0].usage.cliCostUsd, 0.24);
  assert.ok(breakdownLines(doubled)[1].endsWith("$0.24 estimated API cost (login type unknown)"));
  assert.equal(
    formatTokens(mergeBreakdowns([a, b]).byRole[0].usage),
    "1,234 in / 56 out / 0 cached (+1 turn unknown)",
  );
  assert.equal(formatTokens(undefined), "unknown");
  assert.equal(formatTokens(emptyUsage()), "unknown");
});

test("empty breakdown has no agent turns", () => {
  const b = usageBreakdown({ run: { plannerTurns: 0 }, tasks: [] });
  assert.deepEqual(b, { byRole: [], byMember: [] });
  assert.deepEqual(breakdownLines(mergeBreakdowns([b])), [
    "- No agent turns yet.",
  ]);
});

test("digest includes Tokens after cost and before retry, including supplied breakdowns", () => {
  const run: TeamRun = {
    id: "run",
    teamId: "team",
    state: "done",
    goal: "goal",
    plannerTurns: 1,
    planVersion: 0,
    budget: { ...DEFAULT_BUDGET },
    policy: { ...DEFAULT_POLICY },
    baseBranch: "main",
    runBranch: "run",
    approvals: [],
    invalidPlannerReplies: 0,
    pendingNotes: [],
    wakeRequested: false,
    workspace: "",
    briefVersion: 0,
    createdAt: "2026-11-14T00:00:00Z",
    updatedAt: "2026-11-14T00:00:00Z",
  };
  const input = {
    teamName: "Team",
    now: Date.parse(run.updatedAt),
    sinceHours: 24,
    runs: [run],
    tasks: {},
    events: {},
  };
  const text = buildDigest(input);
  assert.ok(text.indexOf("## Tokens") > text.indexOf("## Cost and time"));
  assert.ok(text.indexOf("## Tokens") < text.indexOf("## Next auto-retry"));
  assert.ok(text.includes("- planner: unknown"));
  const b = usageBreakdown({
    run: { ...run, plannerUsage: known },
    tasks: [],
    plannerMember: "lead",
    plannerAgent: "codex",
  });
  assert.ok(
    buildDigest({ ...input, breakdowns: { run: b } }).includes(
      "- lead (codex): 1,234 in",
    ),
  );
});

test("status snapshot and digest collection include the configured planner fallback", async () => {
  const { TeamStore } = await import("../src/core/team/team-store");
  const { collectDigestInput } = await import("../src/core/team/digest");
  const run = { id: "run", teamId: "team", plannerTurns: 1 } as TeamRun;
  const store = {
    run: () => run,
    runs: () => [run],
    tasks: () => [],
    decisions: () => [],
    events: () => [],
    planner: () => ({ name: "lead", agent: "codex" as const }),
  } as unknown as InstanceType<typeof TeamStore>;
  const snapshot = TeamStore.prototype.snapshot.call(store, "run");
  assert.equal(snapshot?.usageBreakdown?.byMember[0].key, "lead");
  assert.deepEqual(snapshot?.usageBreakdown?.byRole[0].agents, ["codex"]);
  const collected = collectDigestInput(
    store,
    { id: "team", name: "Team" },
    Date.now(),
    24,
  );
  assert.deepEqual(collected.breakdowns?.run, snapshot?.usageBreakdown);
});
