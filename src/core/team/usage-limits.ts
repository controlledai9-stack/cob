import type { TeamAgentId, TeamUsage } from "./types";
export type UsageSource = "reported" | "estimated";
export interface ReportedRateLimit {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
}
export interface AgentLimitConfig {
  budgetTokens: number;
  windowHours: number;
}
export interface UsageLimitSettings {
  stopAt: number;
  agents: Partial<Record<TeamAgentId, AgentLimitConfig>>;
}
export interface AgentUsageState {
  agent: TeamAgentId;
  source: UsageSource;
  percent: number;
  windowMinutes?: number;
  resetsAt?: string;
  updatedAt: string;
  learnedBudgetTokens?: number;
  learnedFrom?: string;
  stoppedAt?: string;
  notifiedKey?: string;
}
export interface AgentUsageStatus extends AgentUsageState {
  stopped: boolean;
  budgetTokens?: number;
  tokensInWindow?: number;
}
export interface SettingsIo {
  setting<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}
export function memorySettings(): SettingsIo {
  const values = new Map<string, unknown>();
  return {
    setting: <T>(k: string, f: T) => structuredClone((values.get(k) ?? f) as T),
    set: (k, v) => {
      values.set(k, structuredClone(v));
    },
  };
}
export const DEFAULT_STOP_AT = 95;
function valid(n: number, min: number, max: number, integer = true) {
  if (
    !Number.isFinite(n) ||
    (integer && !Number.isInteger(n)) ||
    n < min ||
    n > max
  )
    throw new Error(
      `Expected ${integer ? "an integer" : "a number"} from ${min} to ${max}`,
    );
  return n;
}
export const validStopAt = (n: number) => valid(n, 50, 100);
export const validBudget = (n: number) =>
  valid(n, 1000, Number.MAX_SAFE_INTEGER);
export const validWindowHours = (n: number) => valid(n, 1, 168, false);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
function reset(v: unknown): string | undefined {
  const t =
    typeof v === "number"
      ? v * 1000
      : typeof v === "string"
        ? Date.parse(v)
        : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
function sample(
  v: unknown,
  now: number,
  generic = false,
): ReportedRateLimit | undefined {
  const r = obj(v);
  const p =
    r.used_percent ??
    (generic && typeof r.utilization === "number"
      ? r.utilization * 100
      : undefined);
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0) return;
  return {
    usedPercent: p,
    ...(typeof r.window_minutes === "number" && r.window_minutes > 0
      ? { windowMinutes: r.window_minutes }
      : {}),
    resetsAt:
      reset(r.resetsAt ?? r.resets_at) ??
      (typeof r.resets_in_seconds === "number"
        ? new Date(now + r.resets_in_seconds * 1000).toISOString()
        : undefined),
  };
}
function parse(stdout: string, now: number, generic: boolean) {
  let last: ReportedRateLimit | undefined;
  let lines = stdout.split(/\r?\n/);
  try {
    lines = [JSON.stringify(JSON.parse(stdout))];
  } catch {
    /* JSONL */
  }
  for (const line of lines) {
    try {
      const e = obj(JSON.parse(line));
      const m = obj(e.msg);
      const payload = obj(e.payload);
      const containers = [
        e,
        m,
        obj(e.info),
        obj(m.info),
        payload,
        obj(payload.info),
      ];
      for (const c of containers) {
        const r = c.rate_limits ?? (generic ? c.rate_limit_info : undefined);
        if (!r) continue;
        const o = obj(r);
        const candidates = [
          sample(o.primary, now, generic),
          sample(o.secondary, now, generic),
          ...(generic ? [sample(o, now, true)] : []),
        ].filter((s): s is ReportedRateLimit => !!s);
        candidates.sort(
          (a, b) =>
            b.usedPercent - a.usedPercent ||
            (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity),
        );
        if (candidates[0]) last = candidates[0];
      }
    } catch {
      /* partial output */
    }
  }
  return last;
}
export const parseCodexRateLimits = (stdout: string, now: number) =>
  parse(stdout, now, false);
export const parseGenericRateLimit = (stdout: string, now: number) =>
  parse(stdout, now, true);
type StoredState = AgentUsageState & {
  stopped?: boolean;
  stops?: AgentUsageStatus[];
};
type Ledger = { agent: TeamAgentId; at: number; tokens: number }[];
export class UsageLimits {
  constructor(
    private io: SettingsIo,
    private now: () => number,
  ) {}
  settings(): UsageLimitSettings {
    return this.io.setting("agentUsageLimits", {
      stopAt: DEFAULT_STOP_AT,
      agents: {},
    });
  }
  setStopAt(percent: number) {
    const s = this.settings();
    s.stopAt = validStopAt(percent);
    this.io.set("agentUsageLimits", s);
    return s;
  }
  setBudget(agent: TeamAgentId, cfg: AgentLimitConfig | null) {
    const s = this.settings();
    if (cfg)
      s.agents[agent] = {
        budgetTokens: validBudget(cfg.budgetTokens),
        windowHours: validWindowHours(cfg.windowHours),
      };
    else delete s.agents[agent];
    this.io.set("agentUsageLimits", s);
    return s;
  }
  private states() {
    const states = this.io.setting<Partial<Record<TeamAgentId, StoredState>>>(
      "agentUsageState",
      {},
    );
    let changed = false;
    for (const state of Object.values(states)) {
      if (!state?.stops) continue;
      const stops = state.stops
        .filter(
          (s) => Date.parse(s.stoppedAt ?? "") > this.now() - 168 * 3600e3,
        )
        .slice(-5000);
      if (stops.length !== state.stops.length) {
        state.stops = stops;
        changed = true;
      }
    }
    if (changed) this.io.set("agentUsageState", states);
    return states;
  }
  private ledger() {
    const stored = this.io.setting<Ledger>("agentUsageLedger", []);
    const l = stored
      .filter((e) => e.at > this.now() - 168 * 3600e3)
      .slice(-5000);
    if (l.length !== stored.length) this.io.set("agentUsageLedger", l);
    return l;
  }
  recordTurn(
    agent: TeamAgentId,
    r: {
      usage?: TeamUsage;
      rateLimit?: ReportedRateLimit;
      rateLimited?: boolean;
      retryAfterMinutes?: number;
    },
  ): AgentUsageStatus {
    this.status(agent); // Close an expired episode before recording a new sample.
    const now = this.now();
    const ledger = this.ledger();
    if (r.usage) {
      const tokens =
        r.usage.inputTokens + r.usage.outputTokens + r.usage.cacheWriteTokens;
      if (tokens > 0) ledger.push({ agent, at: now, tokens });
      this.io.set("agentUsageLedger", ledger.slice(-5000));
    }
    const states = this.states();
    let s = states[agent] ?? {
      agent,
      source: "estimated" as const,
      percent: 0,
      updatedAt: new Date(now).toISOString(),
    };
    if (r.rateLimit) {
      const previous = s;
      s = {
        ...s,
        source: "reported",
        percent: Math.round(r.rateLimit.usedPercent * 10) / 10,
        windowMinutes: r.rateLimit.windowMinutes,
        resetsAt:
          r.rateLimit.resetsAt ??
          new Date(
            now + (r.rateLimit.windowMinutes ?? 300) * 60000,
          ).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      if (
        previous.stopped &&
        previous.resetsAt &&
        now < Date.parse(previous.resetsAt) &&
        s.percent >= this.settings().stopAt &&
        Date.parse(s.resetsAt!) <= Date.parse(previous.resetsAt) + 5 * 60000
      )
        s.resetsAt = previous.resetsAt;
    }
    if (r.rateLimited) {
      const window = (this.settings().agents[agent]?.windowHours ?? 5) * 3600e3;
      const tokens = ledger
        .filter((e) => e.agent === agent && e.at > now - window)
        .reduce((sum, e) => sum + e.tokens, 0);
      if (tokens > 0) {
        s.learnedBudgetTokens = Math.min(
          s.learnedBudgetTokens ?? Infinity,
          tokens,
        );
        s.learnedFrom =
          r.rateLimit?.resetsAt ??
          new Date(now + (r.retryAfterMinutes ?? 60) * 60000).toISOString();
      }
    }
    states[agent] = s;
    this.io.set("agentUsageState", states);
    return this.status(agent);
  }
  status(agent: TeamAgentId): AgentUsageStatus {
    const now = this.now(),
      states = this.states(),
      old = states[agent];
    const cfg = this.settings().agents[agent];
    const windowMinutes = (cfg?.windowHours ?? 5) * 60;
    // A learned budget applies only to ledger windows after the observed reset.
    const windowStart = now - windowMinutes * 60000;
    const learnedActive =
      !!old?.learnedFrom && now > Date.parse(old.learnedFrom);
    const entries = this.ledger().filter(
      (e) =>
        e.agent === agent &&
        e.at > windowStart &&
        (!learnedActive || e.at >= Date.parse(old!.learnedFrom!)),
    );
    const tokensInWindow = entries.reduce((sum, e) => sum + e.tokens, 0);
    const learned =
      old?.learnedFrom && now > Date.parse(old.learnedFrom)
        ? old.learnedBudgetTokens
        : undefined;
    const budgetTokens =
      cfg?.budgetTokens === undefined
        ? learned
        : Math.min(cfg.budgetTokens, learned ?? Infinity);
    const fresh =
      old?.source === "reported" &&
      now <
        Date.parse(
          old.resetsAt ??
            new Date(
              Date.parse(old.updatedAt) + (old.windowMinutes ?? 300) * 60000,
            ).toISOString(),
        );
    const s: AgentUsageStatus = fresh
      ? { ...old, stopped: false, budgetTokens, tokensInWindow }
      : {
          ...old,
          agent,
          source: "estimated",
          percent: budgetTokens
            ? Math.round((tokensInWindow / budgetTokens) * 1000) / 10
            : 0,
          windowMinutes,
          resetsAt: entries.length
            ? new Date(
                Math.min(...entries.map((e) => e.at)) + windowMinutes * 60000,
              ).toISOString()
            : undefined,
          updatedAt: new Date(now).toISOString(),
          budgetTokens,
          tokensInWindow,
          stopped: false,
        };
    if (
      old?.stopped &&
      old.resetsAt &&
      now < Date.parse(old.resetsAt) &&
      s.percent >= this.settings().stopAt &&
      (!s.resetsAt ||
        Date.parse(s.resetsAt) <= Date.parse(old.resetsAt) + 5 * 60000)
    )
      s.resetsAt = old.resetsAt;
    s.stopped =
      s.percent >= this.settings().stopAt &&
      (!s.resetsAt || now < Date.parse(s.resetsAt));
    if (s.stopped && !old?.stopped) s.stoppedAt = new Date(now).toISOString();
    else if (!s.stopped) {
      s.stoppedAt = undefined;
      s.notifiedKey = undefined;
    }
    const stops = old?.stops ?? [];
    if (s.stopped && !old?.stopped) {
      const { stops: _history, ...snapshot } = s as AgentUsageStatus & {
        stops?: AgentUsageStatus[];
      };
      stops.push(snapshot);
    }
    states[agent] = {
      ...s,
      stops: stops.slice(-5000),
    };
    // Reading an unchanged estimate must not refresh its timestamp or persist it.
    const candidate = states[agent]!;
    if (
      old &&
      JSON.stringify({ ...old, updatedAt: undefined }) ===
        JSON.stringify({ ...candidate, updatedAt: undefined })
    ) {
      candidate.updatedAt = old.updatedAt;
    }
    if (JSON.stringify(old) !== JSON.stringify(candidate))
      this.io.set("agentUsageState", states);
    const { stops: _history, ...status } = states[agent]!;
    return status as AgentUsageStatus;
  }
  all(agents: TeamAgentId[]) {
    return agents.map((a) => this.status(a));
  }
  claimStopNotice(agent: TeamAgentId) {
    const s = this.status(agent);
    if (!s.stopped) return false;
    const key = `${agent}@${s.stoppedAt}`;
    if (s.notifiedKey === key) return false;
    s.notifiedKey = key;
    const states = this.states();
    states[agent] = { ...states[agent], ...s };
    this.io.set("agentUsageState", states);
    return true;
  }
  stopsSince(sinceMs: number): AgentUsageStatus[] {
    return Object.values(this.states())
      .flatMap((s) => s?.stops ?? [])
      .filter((s) => Date.parse(s.stoppedAt ?? "") >= sinceMs);
  }
}
