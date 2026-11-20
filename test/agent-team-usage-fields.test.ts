import assert from "node:assert/strict";
import test from "node:test";
import {
  addUsage,
  emptyUsage,
  formatTokens,
  runCostUsd,
  unknownTurn,
} from "../src/core/team/usage";

test("addUsage sums optional CLI fields and keeps API cost separate", () => {
  const total = {
    ...emptyUsage(),
    calls: 1,
    costUsd: 0.1,
    cliCostUsd: 0.123456,
  };
  assert.equal(
    addUsage(total, {
      ...unknownTurn(),
      costUsd: 0.2,
      cliCostUsd: 0.0000007,
    }),
    total,
  );
  addUsage(total, unknownTurn());
  assert.equal(total.calls, 3);
  assert.equal(total.costUsd, 0.3);
  assert.equal(total.cliCostUsd, 0.123457);
  assert.equal(total.unknownCalls, 2);
  assert.equal(runCostUsd(total, []), 0.3);
});

test("addUsage omits absent optional fields and preserves explicit CLI zero", () => {
  const total = emptyUsage();
  assert.equal(addUsage(total, undefined), total);
  addUsage(total, emptyUsage());
  assert.equal(Object.hasOwn(total, "unknownCalls"), false);
  assert.equal(Object.hasOwn(total, "cliCostUsd"), false);
  addUsage(total, { ...emptyUsage(), unknownCalls: 0, cliCostUsd: 0 });
  assert.equal(Object.hasOwn(total, "unknownCalls"), false);
  assert.equal(total.cliCostUsd, 0);
});

test("unknownTurn returns a fresh single turn with unknown tokens", () => {
  assert.deepEqual(unknownTurn(), {
    ...emptyUsage(),
    calls: 1,
    unknownCalls: 1,
  });
  assert.notEqual(unknownTurn(), unknownTurn());
});

test("formatTokens labels missing and all-unknown usage", () => {
  assert.equal(formatTokens(undefined), "unknown");
  assert.equal(formatTokens(emptyUsage()), "unknown");
  assert.equal(formatTokens(unknownTurn()), "unknown");
  assert.equal(formatTokens({ ...unknownTurn(), unknownCalls: 2 }), "unknown");
});

test("formatTokens formats known tokens and mixed unknown turns", () => {
  const usage = {
    ...emptyUsage(),
    calls: 1,
    inputTokens: 1234,
    outputTokens: 56,
    cacheReadTokens: 1000,
    cacheWriteTokens: 234,
  };
  const tokens = "1,234 in / 56 out / 1,234 cached";
  assert.equal(formatTokens(usage), tokens);
  assert.equal(
    formatTokens(addUsage(usage, unknownTurn())),
    `${tokens} (+1 turn unknown)`,
  );
  assert.equal(
    formatTokens(addUsage(usage, unknownTurn())),
    `${tokens} (+2 turns unknown)`,
  );
  assert.equal(
    formatTokens({ ...emptyUsage(), calls: 1 }),
    "0 in / 0 out / 0 cached",
  );
});
