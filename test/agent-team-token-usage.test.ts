import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claudeSpec,
  codexSpec,
  geminiSpec,
  cliUsage,
} from "../src/core/team/adapters";
import { emptyUsage, unknownTurn } from "../src/core/team/usage";
import { buildDigest, type DigestInput } from "../src/core/team/digest";
import {
  DEFAULT_BUDGET,
  DEFAULT_POLICY,
  type TeamRun,
  type TeamTask,
} from "../src/core/team/types";

// Recorded stdout shapes; no provider CLIs or network calls are used.
const claude = `{"type":"result","subtype":"success","is_error":false,"result":"Updated the tests.","session_id":"claude-session","total_cost_usd":0.123456,"usage":{"input_tokens":120,"output_tokens":45,"cache_read_input_tokens":800,"cache_creation_input_tokens":200}}`;
const codex = `{"type":"thread.started","thread_id":"codex-session"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Updated the tests."}}
{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":600,"output_tokens":90}}`;
const gemini = `{"session_id":"gemini-session","response":"Updated the tests.","stats":{"models":{"gemini-2.5-pro":{"api":{"totalRequests":1},"tokens":{"prompt":1000,"cached":700,"candidates":80,"thoughts":20,"total":1100}},"gemini-2.5-flash":{"tokens":{"prompt":200,"cached":50,"candidates":30,"thoughts":5}}}}}`;

describe("CLI token usage samples", () => {
  it("parses Claude tokens and CLI-reported cost", () => {
    assert.deepEqual(claudeSpec.parseUsage!(claude), {
      ...emptyUsage(),
      calls: 1,
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 800,
      cacheWriteTokens: 200,
      cliCostUsd: 0.123456,
    });
  });

  it("parses Codex turn.completed and sums multiple turns", () => {
    assert.deepEqual(codexSpec.parseUsage!(codex), {
      ...emptyUsage(),
      calls: 1,
      inputTokens: 400,
      cacheReadTokens: 600,
      outputTokens: 90,
    });
    assert.deepEqual(
      codexSpec.parseUsage!(
        codex +
          "\n" +
          '{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":100,"output_tokens":40}}',
      ),
      {
        ...emptyUsage(),
        calls: 1,
        inputTokens: 800,
        cacheReadTokens: 700,
        outputTokens: 130,
      },
    );
  });

  it("skips legacy null info and sums last usage rather than session totals", () => {
    const legacy = `{"type":"event_msg","msg":{"type":"token_count","info":null}}
{"type":"event_msg","msg":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9000,"output_tokens":900},"last_token_usage":{"input_tokens":400,"cached_input_tokens":100,"output_tokens":30,"reasoning_output_tokens":20}}}}
{"type":"token_count","info":{"total_token_usage":{"input_tokens":9600,"output_tokens":950},"last_token_usage":{"input_tokens":600,"cached_input_tokens":200,"output_tokens":50,"reasoning_output_tokens":40}}}`;
    assert.deepEqual(codexSpec.parseUsage!(legacy), {
      ...emptyUsage(),
      calls: 1,
      inputTokens: 700,
      cacheReadTokens: 300,
      outputTokens: 80,
    });
    assert.deepEqual(
      codexSpec.parseUsage!(legacy + "\n" + codex),
      codexSpec.parseUsage!(codex),
    );
  });

  it("sums Gemini model stats including thoughts", () => {
    assert.deepEqual(geminiSpec.parseUsage!(gemini), {
      ...emptyUsage(),
      calls: 1,
      inputTokens: 450,
      cacheReadTokens: 750,
      outputTokens: 135,
    });
    assert.equal(geminiSpec.parseUsage!('{"response":"ok"}'), undefined);
    assert.equal(
      geminiSpec.parseUsage!('{"response":"ok","stats":{}}'),
      undefined,
    );
  });

  it("keeps missing or invalid tokens unknown and accepts reported zero", () => {
    for (const spec of [claudeSpec, codexSpec, geminiSpec]) {
      for (const stdout of ["", "partial {", "null", "[]", "{}", "42"]) {
        assert.equal(spec.parseUsage!(stdout), undefined);
        assert.deepEqual(cliUsage(spec, stdout), unknownTurn());
      }
    }
    assert.equal(
      claudeSpec.parseUsage!(
        '{"usage":{"input_tokens":-1,"output_tokens":"20","cache_read_input_tokens":1e999}}',
      ),
      undefined,
    );
    assert.deepEqual(
      claudeSpec.parseUsage!(
        '{"usage":{"input_tokens":0},"total_cost_usd":-1}',
      ),
      { ...emptyUsage(), calls: 1 },
    );
    assert.deepEqual(
      codexSpec.parseUsage!(
        '{"type":"turn.completed","usage":{"input_tokens":2,"cached_input_tokens":5,"output_tokens":-1}}',
      ),
      {
        ...emptyUsage(),
        calls: 1,
        cacheReadTokens: 5,
      },
    );
    const { parseUsage: _parseUsage, ...withoutParser } = claudeSpec;
    assert.deepEqual(cliUsage(withoutParser, claude), unknownTurn());
  });

  it("ignores unusable Codex and Gemini fields within reported usage", () => {
    assert.equal(
      codexSpec.parseUsage!(
        '{"type":"turn.completed","usage":{"input_tokens":"100","cached_input_tokens":-1,"output_tokens":1e999}}',
      ),
      undefined,
    );
    assert.equal(
      geminiSpec.parseUsage!(
        '{"stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":null,"cached":-1,"candidates":"80","thoughts":1e999}}}}}',
      ),
      undefined,
    );
    assert.deepEqual(
      geminiSpec.parseUsage!(
        '{"stats":{"models":{"gemini-2.5-pro":{"tokens":{"prompt":2,"cached":5,"candidates":-1,"thoughts":3}},"missing":null}}}',
      ),
      { ...emptyUsage(), calls: 1, cacheReadTokens: 5, outputTokens: 3 },
    );
  });
});

describe("CLI token usage end-to-end digest", () => {
  it("reports parsed CLI tokens by role and member, preserving unknown turns", () => {
    const timestamp = "2026-11-16T12:00:00Z";
    const run: TeamRun = {
      id: "cli-usage-run",
      teamId: "team",
      goal: "Measure CLI token usage",
      state: "running",
      plannerAgent: "gemini",
      plannerTurns: 1,
      plannerUsage: cliUsage(geminiSpec, gemini),
      planVersion: 1,
      budget: { ...DEFAULT_BUDGET },
      policy: { ...DEFAULT_POLICY },
      baseBranch: "main",
      runBranch: "team/cli-usage",
      approvals: [],
      invalidPlannerReplies: 0,
      pendingNotes: [],
      wakeRequested: false,
      workspace: "",
      briefVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const task = (
      member: string,
      role: TeamTask["role"],
      agent: TeamTask["agent"],
      usage?: TeamTask["usage"],
    ): TeamTask => ({
      id: member,
      runId: run.id,
      member,
      role,
      agent,
      title: member,
      instructions: "Use recorded stdout only",
      acceptance: [],
      dependsOn: [],
      state: "running",
      attempt: 1,
      createdAt: timestamp,
      startedAt: timestamp,
      usage,
    });
    const input: DigestInput = {
      teamName: "CLI usage team",
      now: Date.parse(timestamp),
      sinceHours: 24,
      runs: [run],
      tasks: {
        [run.id]: [
          task("coder1", "coder", "codex", cliUsage(codexSpec, codex)),
          task("coder2", "coder", "codex", cliUsage(codexSpec, codex)),
          task("generator1", "generator", "codex", cliUsage(codexSpec, codex)),
          task("reviewer1", "reviewer", "claude", cliUsage(claudeSpec, claude)),
          task("researcher1", "researcher", "gemini"),
        ],
      },
      events: {},
    };

    const digest = buildDigest(input);
    const tokens = digest.split("## Tokens\n\n")[1]?.split("\n\n## ")[0];
    assert.ok(tokens, "digest contains a Tokens section");
    const [byRole, byMember] = tokens.split("**By member**\n");
    assert.ok(byRole.startsWith("**By role**\n"));
    assert.ok(byMember, "Tokens section contains member breakdown");
    assert.deepEqual(byRole.trim().split("\n").slice(1), [
      "- planner (gemini): 450 in / 135 out / 750 cached",
      "- coder (codex): 800 in / 180 out / 1,200 cached",
      "- generator (codex): 400 in / 90 out / 600 cached",
      "- researcher (gemini): unknown",
      "- reviewer (claude): 120 in / 45 out / 1,000 cached; $0.12 estimated API cost (login type unknown)",
    ]);
    assert.deepEqual(byMember.trim().split("\n"), [
      "- coder1 (codex): 400 in / 90 out / 600 cached",
      "- coder2 (codex): 400 in / 90 out / 600 cached",
      "- generator1 (codex): 400 in / 90 out / 600 cached",
      "- planner (gemini): 450 in / 135 out / 750 cached",
      "- researcher1 (gemini): unknown",
      "- reviewer1 (claude): 120 in / 45 out / 1,000 cached; $0.12 estimated API cost (login type unknown)",
    ]);
  });
});
