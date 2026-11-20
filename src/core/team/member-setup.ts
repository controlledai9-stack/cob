import {
  TEAM_ROLES,
  type AgentDetection,
  type TeamAgentId,
  type TeamMemberInput,
} from "./types";

export function bestAvailableMembers(
  detected: readonly AgentDetection[],
): TeamMemberInput[] {
  const installed = new Set(
    detected.filter((d) => d.installed).map((d) => d.agent),
  );
  return TEAM_ROLES.flatMap((role) => {
    // The debugger is always a small local model (no network, no full
    // access), so it is only set up when the free/local agent exists.
    const preference: TeamAgentId[] =
      role === "debugger"
        ? ["free"]
        : role === "planner" || role === "researcher"
          ? ["claude", "codex", "gemini", "free"]
          : ["codex", "claude", "gemini", "free"];
    const agent = preference.find((id) => installed.has(id));
    return agent ? [{ name: role + "1", role, agent }] : [];
  });
}
