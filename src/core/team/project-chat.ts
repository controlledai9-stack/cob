import {
  researchRoute,
  researchChat,
  type ResearchChatOptions,
} from "./research-chat";
import { capHistory, CONTEXT_LIMITS } from "./context-diet";
import { parseRoadmapReply } from "./roadmap";
import type { UsageLimits } from "./usage-limits";
import type { Team } from "../../shared/types";
import type { TeamStore } from "./team-store";
import type { AgentAdapter } from "./adapters";
import type {
  TeamAgentId,
  TeamChatMessage,
  TeamRun,
  UserAnswer,
  SessionBrief,
} from "./types";
import { planText, userDecisionsText } from "./prompts";
import { sessionBriefText } from "./session-brief";
import { collectDigestInput, shortDigest } from "./digest";
import { openBacklogItems } from "./autopilot";

export const PROJECT_CHAT_LIMITS = {
  history: 20,
  runs: 5,
  backlogItems: 15,
  prompt: 30_000,
  goal: 4_000,
};
export interface ProjectChatState {
  team: Team;
  answers: UserAnswer[];
  sessionBrief: SessionBrief | null;
  runs: TeamRun[];
  digest: string;
  backlog: string[];
  history: TeamChatMessage[];
  /** Plain status and usage limits right now. */
  live?: string;
}
export function projectChatPrompt(
  state: ProjectChatState,
  message: string,
): string {
  const instruction = [
    "You are Cobble, the user's assistant for this software project. You speak for the whole AI team (planner and workers) in one friendly voice.",
    "Reply like a natural chat: short, warm and direct. Greet back when greeted and offer something useful (for example the current status). Answer questions from the project state below; say plainly when you do not know.",
    "ONE read-only turn: no tools, no edits, never start a run.",
    'Only if the user asks for new work, end with a ```cobble-roadmap block of at most 5 "- [ ] X — done when: Y" lines.',
    "Only if the user asks the running team to change or do something now, end with a ```cobble-forward block containing one short instruction for the planner.",
  ].join(" ");
  const context = [
    instruction,
    "Team plan",
    planText(state.team),
    "Project decisions",
    userDecisionsText(state.answers),
    "Session brief",
    sessionBriefText(state.sessionBrief),
    "Right now",
    state.live ?? "",
    "Recent runs",
    ...state.runs
      .slice(0, 5)
      .map((r) => `${r.state}: ${r.goal.split(/\r?\n/)[0]} (${r.updatedAt})`),
    "Digest",
    state.digest,
    "Open backlog items",
    ...state.backlog.slice(0, 15),
    "Recent conversation",
    capHistory(
      state.history.map((m) => `${m.author}: ${m.text}`),
      {
        maxItems: CONTEXT_LIMITS.chatMessages,
        eachChars: CONTEXT_LIMITS.chatMessageChars,
        maxChars: CONTEXT_LIMITS.chatChars,
      },
    ),
  ].join("\n\n");
  const last = `\n\nUser message:\n${message}`;
  return (
    context.slice(0, Math.max(0, PROJECT_CHAT_LIMITS.prompt - last.length)) +
    last.slice(0, PROJECT_CHAT_LIMITS.prompt)
  );
}
export function parseProjectChatReply(text: string): {
  prose: string;
  proposal?: { goal: string; items?: string[] };
  forward?: string;
} {
  const forwardMatch = /```cobble-forward\s*\n([\s\S]*?)```/i.exec(text);
  const forward = forwardMatch?.[1]?.trim().slice(0, 2000) || undefined;
  let proposal: { goal: string; items?: string[] } | undefined;
  const items = text.includes("```cobble-roadmap")
    ? parseRoadmapReply(text, 5).items
    : [];
  if (items.length) proposal = { goal: items.join("\n"), items };
  const prose = text
    .replace(
      /```cobble-(proposal|actions|roadmap|forward)\s*\n([\s\S]*?)```/gi,
      (_, kind: string, body: string) => {
        if (kind.toLowerCase() === "proposal" && !proposal) {
          try {
            const value = JSON.parse(body);
            const goal =
              typeof value?.goal === "string" ? value.goal.trim() : "";
            if (goal && goal.length <= 4000) proposal = { goal };
          } catch {
            /* Ignore malformed proposals. */
          }
        }
        return "";
      },
    )
    .trim()
    .slice(0, 4000);
  return {
    prose,
    ...(proposal ? { proposal } : {}),
    ...(forward ? { forward } : {}),
  };
}
export interface ProjectChatDeps {
  research?: ResearchChatOptions;
  teamStore: TeamStore;
  team(teamId: string): Team | null;
  plannerAdapter(
    teamId: string,
  ): { agent: TeamAgentId; adapter: AgentAdapter } | undefined;
  /**
   * Other models that may answer when the planner's model is at its usage
   * limit or fails, best first. The chat always tries to give a real reply.
   */
  chatFallbacks?(teamId: string): { agent: TeamAgentId; adapter: AgentAdapter }[];
  /** Plain status and limits for the assistant's context. */
  liveStatus?(teamId: string): Promise<string>;
  /** Passes an instruction from the chat to a running team's planner. */
  forward?(teamId: string, instruction: string, message: string): void;
  backlog(teamId: string): Promise<string>;
  promotions?(teamId: string): import("./digest").DigestInput["promotions"];
  limits?: UsageLimits;
  now?: () => number;
  onChange?(teamId: string): void;
}
export class ProjectChat {
  private readonly pending = new Set<string>();
  constructor(private readonly deps: ProjectChatDeps) {}
  messages(teamId: string): TeamChatMessage[] {
    return this.deps.teamStore.projectChatMessages(teamId);
  }
  busy(teamId: string): boolean {
    return this.pending.has(teamId);
  }
  async ask(
    teamId: string,
    text: string,
  ): Promise<{
    reply: TeamChatMessage;
    proposal?: TeamChatMessage;
    forwarded?: string;
  }> {
    if (this.busy(teamId)) throw new Error("Cobble is still answering");
    const team = this.deps.team(teamId);
    if (!team?.workspace) throw new Error("Choose a workspace folder first");
    const route = researchRoute(text, this.deps.teamStore.members(teamId));
    const planner = route ? undefined : this.deps.plannerAdapter(teamId);
    if (!route && !planner)
      throw new Error("Assign an agent to the planner role first");
    text = text.trim();
    if (!text) throw new Error("Type a message first");
    this.pending.add(teamId);
    const store = this.deps.teamStore;
    const save = (
      message: Omit<TeamChatMessage, "id" | "runId" | "createdAt">,
    ) => {
      const saved = store.projectChat(teamId, message);
      this.deps.onChange?.(teamId);
      return saved;
    };
    try {
      const history = this.messages(teamId);
      save({ author: "user", kind: "message", text });
      if (route)
        return {
          reply: save(
            await researchChat(
              store,
              teamId,
              team.workspace,
              text,
              planText(team),
              this.deps.research,
            ),
          ),
        };
      const prompt = projectChatPrompt(
        {
          team,
          history,
          answers: store.decisionsFromUser(teamId),
          sessionBrief: store.sessionBrief(teamId),
          runs: store.runs(teamId, 5),
          digest: shortDigest(
            collectDigestInput(
              store,
              team,
              (this.deps.now ?? Date.now)(),
              24,
              this.deps.promotions?.(teamId),
              this.deps.limits,
            ),
          ),
          backlog: openBacklogItems(await this.deps.backlog(teamId))
            .slice(0, 15)
            .map((i) => i.text),
          live: await this.deps.liveStatus?.(teamId).catch(() => ""),
        },
        text,
      );
      // The planner's model first; when it is at its usage limit or fails,
      // the next available model answers, so the chat never goes quiet.
      const candidates = [
        planner!,
        ...(this.deps.chatFallbacks?.(teamId) ?? []).filter(
          (c) => c.agent !== planner!.agent,
        ),
      ].filter(
        (c, i) => i === 0 || !this.deps.limits?.status(c.agent).stopped,
      );
      if (this.deps.limits?.status(planner!.agent).stopped && candidates.length > 1)
        candidates.shift();
      let result!: Awaited<ReturnType<AgentAdapter["run"]>>;
      let answeredBy = candidates[0]!;
      for (const candidate of candidates) {
        answeredBy = candidate;
        result = await candidate.adapter
          .run({
            cwd: team.workspace,
            prompt,
            readOnly: true,
            network: false,
            timeoutMs: 300_000,
          })
          .catch((error: unknown) => ({
            exitCode: 1,
            durationMs: 0,
            finalText: error instanceof Error ? error.message : String(error),
          }));
        if (!result.rateLimited && result.exitCode === 0 && !result.authRequired)
          break;
      }
      if (result.authRequired) {
        save({
          author: "cobble",
          kind: "message",
          text: `Planner sign-in needed: ${result.authRequired.hint}`,
        });
        throw new Error(
          `Planner authentication required: ${result.authRequired.hint}`,
        );
      }
      if (result.exitCode !== 0) {
        const error = `The planner could not answer: ${result.finalText.slice(0, 300)}`;
        save({ author: "cobble", kind: "message", text: error });
        throw new Error(error);
      }
      const parsed = parseProjectChatReply(result.finalText);
      if (!parsed.prose && !parsed.proposal)
        return {
          reply: save({
            author: "cobble",
            kind: "message",
            text: "The planner sent no answer.",
          }),
        };
      const author = {
        author: "agent" as const,
        role: "planner" as const,
        agent: answeredBy.agent,
      };
      if (parsed.forward) this.deps.forward?.(teamId, parsed.forward, text);
      const reply = save({
        ...author,
        kind: "message",
        text: parsed.prose || "Here is a proposed run:",
      });
      const proposal = parsed.proposal
        ? save({
            ...author,
            kind: "proposal",
            text: parsed.proposal.goal,
            proposal: { ...parsed.proposal, status: "open" },
          })
        : undefined;
      return {
        reply,
        proposal,
        ...(parsed.forward ? { forwarded: parsed.forward } : {}),
      };
    } finally {
      this.pending.delete(teamId);
    }
  }
  async startProposal(
    teamId: string,
    messageId: string,
    goal: string | undefined,
    start: (goal: string) => Promise<TeamRun>,
  ): Promise<TeamRun> {
    const message = this.messages(teamId).find((m) => m.id === messageId);
    if (message?.kind !== "proposal" || !message.proposal)
      throw new Error("Unknown proposal");
    if (message.proposal.status === "started")
      throw new Error("This proposal already started a run");
    const selected = (goal ?? message.proposal.goal).trim();
    if (!selected || selected.length > 4000)
      throw new Error("Describe the goal in 1-4,000 characters");
    const run = await start(selected);
    this.deps.teamStore.updateProjectChatProposal(teamId, messageId, {
      goal: selected,
      status: "started",
      runId: run.id,
    });
    this.deps.onChange?.(teamId);
    return run;
  }
}
