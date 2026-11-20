/** Normalized authentication provenance; never contains credential or identity data. */
export type AgentLoginType = "subscription" | "api" | "unknown";

export function parseAgentLoginType(
  agent: string,
  output: string,
): AgentLoginType {
  if (output.length > 16_384) return "unknown";
  if (agent === "claude") {
    try {
      const value = JSON.parse(output);
      if (!value || value.loggedIn === false) return "unknown";
      if (value.authMethod === "claude.ai") return "subscription";
      if (value.authMethod === "api_key" || value.authMethod === "api-key")
        return "api";
    } catch {
      /* Unsupported or malformed status. */
    }
  }
  if (agent === "codex") {
    const subscription = /^Logged in using ChatGPT$/i.test(output.trim());
    const api = /^Logged in using (?:an? )?API key(?:\s*[-:].*)?$/i.test(
      output.trim(),
    );
    if (subscription !== api) return subscription ? "subscription" : "api";
  }
  return "unknown";
}

export function costLabel(loginType?: AgentLoginType): string {
  return loginType === "subscription"
    ? "API-equivalent value (subscription, not billed)"
    : "estimated API cost";
}

export interface AgentCostPart {
  loginType: AgentLoginType;
  valueUsd: number;
}

export function formatCostParts(parts: readonly AgentCostPart[]): string {
  const grouped = new Map<AgentLoginType, number>();
  for (const part of parts) {
    if (!Number.isFinite(part.valueUsd) || part.valueUsd < 0) continue;
    grouped.set(
      part.loginType,
      (grouped.get(part.loginType) ?? 0) + part.valueUsd,
    );
  }
  return (
    [...grouped]
      .map(
        ([loginType, value]) =>
          `$${value.toFixed(2)} ${costLabel(loginType)}${loginType === "unknown" ? " (login type unknown)" : ""}`,
      )
      .join(" + ") || "unknown"
  );
}
