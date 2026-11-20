import { formatCostParts, type AgentCostPart } from "../../shared/cost-label";
import type { TeamUsage } from "./types";
import { TEAM_ROLES } from "./types";
import type {
  TeamAgentId,
  TeamRun,
  TeamTask,
  UsageRow,
  UsageBreakdown,
} from "./types";
import { formatTokens, addUsage, emptyUsage } from "./usage";

function rows(list: UsageRow[], byRole = false): UsageRow[] {
  const merged = new Map<string, UsageRow>();
  for (const row of list) {
    const target = merged.get(row.key) ?? {
      key: row.key,
      agents: [],
      usage: emptyUsage(),
      tokens: "",
    };
    addUsage(target.usage, row.usage);
    target.agents = [...new Set([...target.agents, ...row.agents])].sort();
    target.tokens = formatTokens(target.usage);
    merged.set(row.key, target);
  }
  return [...merged.values()].sort((a, b) =>
    byRole
      ? TEAM_ROLES.indexOf(a.key as (typeof TEAM_ROLES)[number]) -
        TEAM_ROLES.indexOf(b.key as (typeof TEAM_ROLES)[number])
      : a.key.localeCompare(b.key),
  );
}

export function usageBreakdown(input: {
  run: Pick<
    TeamRun,
    "plannerUsage" | "plannerAgent" | "plannerSwitchedFrom" | "plannerTurns"
  >;
  tasks: Pick<
    TeamTask,
    | "role"
    | "member"
    | "agent"
    | "switchedFrom"
    | "usage"
    | "startedAt"
    | "debuggerUsage"
  >[];
  plannerAgent?: TeamAgentId;
  plannerMember?: string;
}): UsageBreakdown {
  const byRole: UsageRow[] = [];
  const byMember: UsageRow[] = [];
  const add = (
    role: string,
    member: string,
    agents: (TeamAgentId | undefined)[],
    usage: UsageRow["usage"] | undefined,
  ) => {
    if (!usage) return;
    const row = {
      agents: agents.filter((a): a is TeamAgentId => a !== undefined),
      usage,
      tokens: formatTokens(usage),
    };
    byRole.push({ ...row, key: role });
    byMember.push({ ...row, key: member });
  };
  const { run } = input;
  const plannerUsage = run.plannerUsage ? { ...run.plannerUsage } : undefined;
  if (plannerUsage && run.plannerTurns > plannerUsage.calls) {
    const missingTurns = run.plannerTurns - plannerUsage.calls;
    addUsage(plannerUsage, {
      ...emptyUsage(),
      calls: missingTurns,
      unknownCalls: missingTurns,
    });
  }
  add(
    "planner",
    input.plannerMember ?? "planner",
    [run.plannerAgent ?? input.plannerAgent, run.plannerSwitchedFrom],
    plannerUsage ??
      (run.plannerTurns > 0
        ? {
            ...emptyUsage(),
            calls: run.plannerTurns,
            unknownCalls: run.plannerTurns,
          }
        : undefined),
  );
  for (const task of input.tasks) {
    const builderUsage = task.usage ? { ...task.usage } : undefined;
    for (const repair of task.debuggerUsage ?? []) {
      add("debugger", repair.member, ["free"], repair.usage);
      if (builderUsage) {
        for (const key of [
          "calls",
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheWriteTokens",
          "costUsd",
        ] as const)
          builderUsage[key] = Math.max(
            0,
            builderUsage[key] - repair.usage[key],
          );
        for (const key of ["unknownCalls", "cliCostUsd"] as const) {
          if (builderUsage[key] !== undefined)
            builderUsage[key] = Math.max(
              0,
              builderUsage[key]! - (repair.usage[key] ?? 0),
            );
        }
        if (builderUsage.costParts) {
          builderUsage.costParts = builderUsage.costParts.map((part) => ({
            ...part,
            valueUsd: Math.max(
              0,
              part.valueUsd -
                (repair.usage.costParts ?? [])
                  .filter((extra) => extra.loginType === part.loginType)
                  .reduce((sum, extra) => sum + extra.valueUsd, 0),
            ),
          }));
        }
      }
    }
    add(
      task.role,
      task.member ?? task.role,
      [task.agent, task.switchedFrom],
      builderUsage ??
        (task.startedAt
          ? { ...emptyUsage(), calls: 1, unknownCalls: 1 }
          : undefined),
    );
  }
  return { byRole: rows(byRole, true), byMember: rows(byMember) };
}

export function mergeBreakdowns(list: UsageBreakdown[]): UsageBreakdown {
  return {
    byRole: rows(
      list.flatMap((b) => b.byRole),
      true,
    ),
    byMember: rows(list.flatMap((b) => b.byMember)),
  };
}

export function breakdownLines(b: UsageBreakdown): string[] {
  if (!b.byRole.length && !b.byMember.length) return ["- No agent turns yet."];
  const lines = (list: UsageRow[]) =>
    list.map(
      (row) =>
        `- ${row.key}${row.agents.length ? ` (${row.agents.join(", ")})` : ""}: ${row.tokens}${rowCost(row.usage)}`,
    );
  return [
    "**By role**",
    ...lines(b.byRole),
    "**By member**",
    ...lines(b.byMember),
  ];
}

/** Display metadata never participates in spend-cap accounting. */
export function usageCostParts(usage: TeamUsage | undefined): AgentCostPart[] {
  if (!usage) return [];
  if (usage.costParts !== undefined) return usage.costParts;
  const parts: AgentCostPart[] = [];
  if (usage.costUsd !== 0 || usage.cliCostUsd === undefined) {
    parts.push({ loginType: "unknown", valueUsd: usage.costUsd });
  }
  if (usage.cliCostUsd !== undefined) {
    parts.push({
      loginType: usage.loginType ?? "unknown",
      valueUsd: usage.cliCostUsd,
    });
  }
  return parts;
}

/** "; $0.12 estimated API cost …" for a report row, or nothing when it cost nothing. */
function rowCost(usage: TeamUsage | undefined): string {
  const parts = usageCostParts(usage).filter((part) => part.valueUsd > 0);
  return parts.length ? `; ${formatCostParts(parts)}` : "";
}

export function usageCostText(usage: TeamUsage | undefined): string {
  return formatCostParts(usageCostParts(usage));
}
