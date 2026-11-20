/** Token and cost totals for API-model workers and CLI agents. */
import type { TeamUsage } from "./types";

export function emptyUsage(): TeamUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}

/** Adds `add` into `into` (mutates and returns `into`). */
export function addUsage(into: TeamUsage, add: TeamUsage | undefined) {
  if (!add) return into;
  const hasMetadata =
    into.costParts !== undefined ||
    add.costParts !== undefined ||
    into.loginType !== undefined ||
    add.loginType !== undefined;
  const parts = hasMetadata
    ? [...usageCostParts(into), ...usageCostParts(add)]
    : [];
  const grouped = new Map<NonNullable<TeamUsage["loginType"]>, number>();
  for (const part of parts)
    grouped.set(
      part.loginType,
      Math.round(((grouped.get(part.loginType) ?? 0) + part.valueUsd) * 1e6) /
        1e6,
    );
  if (hasMetadata)
    into.costParts = [...grouped].map(([loginType, valueUsd]) => ({
      loginType,
      valueUsd,
    }));
  const types = new Set(parts.map((part) => part.loginType));
  if (hasMetadata && !types.size) {
    if (into.calls) types.add(into.loginType ?? "unknown");
    if (add.calls) types.add(add.loginType ?? "unknown");
  }
  if (types.size === 1) into.loginType = [...types][0];
  else if (types.size > 1) into.loginType = "unknown";
  into.calls += add.calls;
  into.inputTokens += add.inputTokens;
  into.outputTokens += add.outputTokens;
  into.cacheReadTokens += add.cacheReadTokens;
  into.cacheWriteTokens += add.cacheWriteTokens;
  into.costUsd = Math.round((into.costUsd + add.costUsd) * 1e6) / 1e6;
  if (add.unpriced) into.unpriced = true;
  const unknownCalls = (into.unknownCalls ?? 0) + (add.unknownCalls ?? 0);
  if (unknownCalls > 0) into.unknownCalls = unknownCalls;
  else delete into.unknownCalls;
  if (into.cliCostUsd !== undefined || add.cliCostUsd !== undefined) {
    into.cliCostUsd =
      Math.round(((into.cliCostUsd ?? 0) + (add.cliCostUsd ?? 0)) * 1e6) / 1e6;
  }
  return into;
}

/** One CLI turn that reported no token numbers. */
export function unknownTurn(): TeamUsage {
  return { ...emptyUsage(), calls: 1, unknownCalls: 1 };
}

/** Planner plus every task; undefined when no usage was recorded. */
export function totalUsage(
  planner: TeamUsage | undefined,
  tasks: { usage?: TeamUsage }[],
): TeamUsage | undefined {
  if (!planner && !tasks.some((t) => t.usage)) return undefined;
  const total = addUsage(emptyUsage(), planner);
  for (const task of tasks) addUsage(total, task.usage);
  return total;
}

export function runCostUsd(
  planner: TeamUsage | undefined,
  tasks: { usage?: TeamUsage }[],
): number {
  return totalUsage(planner, tasks)?.costUsd ?? 0;
}

export function formatUsd(value: number): string {
  return "$" + value.toFixed(2);
}

export function formatTokens(u: TeamUsage | undefined): string {
  if (!u || u.calls === 0 || (u.unknownCalls ?? 0) >= u.calls) return "unknown";
  const n = (value: number) => value.toLocaleString("en-US");
  const tokens = `${n(u.inputTokens)} in / ${n(u.outputTokens)} out / ${n(u.cacheReadTokens + u.cacheWriteTokens)} cached`;
  const unknown = u.unknownCalls ?? 0;
  return unknown > 0
    ? `${tokens} (+${unknown} turn${unknown === 1 ? "" : "s"} unknown)`
    : tokens;
}

/** Legacy records contribute their monetary fields exactly once. */
export function usageCostParts(
  usage: TeamUsage,
): NonNullable<TeamUsage["costParts"]> {
  if (usage.costParts !== undefined) return usage.costParts;
  if (!usage.calls && !usage.costUsd && usage.cliCostUsd === undefined)
    return [];
  if (
    (usage.unknownCalls ?? 0) >= usage.calls &&
    !usage.costUsd &&
    usage.cliCostUsd === undefined
  )
    return [];
  return [
    {
      loginType: usage.loginType ?? "unknown",
      valueUsd: usage.costUsd + (usage.cliCostUsd ?? 0),
    },
  ];
}
