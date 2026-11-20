import type { AgentLoginType } from "./cost-label";
import type { TeamAgentId } from "../core/team/types";

export interface AgentUsageView {
  agent: TeamAgentId;
  loginType?: AgentLoginType;
  percent: number | null;
  source: "reported" | "estimated";
  windowHours: number | null;
  resetsAt: string | null;
  stopped: boolean;
  budgetTokens: number | null;
}

export interface UsageLimitsView {
  stopAt: number;
  agents: AgentUsageView[];
}
