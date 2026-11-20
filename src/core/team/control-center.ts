import { type AppHubSnapshot } from "./app-hub";
import type { AutopilotOptions, AutopilotStatus } from "../../shared/types";
import type { TeamStore } from "./team-store";
import type { ProjectChat } from "./project-chat";
import type { TeamChatMessage, TeamRun } from "./types";
import {
  parseControlCommand,
  needsConfirmation,
  describeControlCommand,
  CONTROL_HELP,
  controlQueueText,
  shortLabel,
  type ControlCommand,
} from "./control-commands";

export interface StoppedSession {
  autopilot?: AutopilotOptions;
  runs: { runId: string; item?: string }[];
}
export type ControlOutcome =
  | { type: "result" | "confirm"; message: TeamChatMessage }
  | { type: "planner"; reply: TeamChatMessage; proposal?: TeamChatMessage };
export interface ControlCenterDeps {
  teamStore: TeamStore;
  projectChat: Pick<ProjectChat, "ask">;
  runs(teamId: string): TeamRun[];
  /** Plain short status, or the full report when `details` is true. */
  status(teamId: string, details?: boolean): Promise<string>;
  queue(teamId: string): Promise<string[]>;
  /** The plain usage-limits answer. */
  limits?(teamId: string): string;
  autopilotStatus(teamId: string): AutopilotStatus;
  autopilotOptions(teamId: string): AutopilotOptions | undefined;
  stopped(teamId: string): StoppedSession | null;
  saveStopped(teamId: string, session: StoppedSession | null): void;
  stopAutopilot(teamId: string): unknown;
  runCommand(
    teamId: string,
    runId: string,
    command: "pause" | "resume",
  ): Promise<unknown>;
  waitForRun(teamId: string, runId: string): Promise<unknown>;
  completeAutopilotRun(teamId: string, runId: string): Promise<unknown>;
  startAutopilot(teamId: string, options: AutopilotOptions): Promise<unknown>;
  saveSessionBrief(teamId: string, input: { endDate: string }): unknown;
  promoteTeam?(teamId: string): Promise<unknown>;
  retry?(teamId: string, target: string): Promise<unknown>;
  reviewLater?(teamId: string, runId: string): Promise<unknown>;
  appHub?(teamId: string): Promise<AppHubSnapshot>;
  detachAvailable: boolean;
  now?: () => number;
  onChange?(teamId: string): void;
}
export class ControlCenter {
  private readonly inFlight = new Set<string>();
  private readonly promoting = new Set<string>();
  private readonly restoring = new Set<string>();
  private readonly stopVersions = new Map<string, number>();
  constructor(private readonly deps: ControlCenterDeps) {}
  private post(teamId: string, text: string) {
    const message = this.deps.teamStore.projectChat(teamId, {
      author: "cobble",
      kind: "message",
      text,
    });
    this.deps.onChange?.(teamId);
    return message;
  }
  /** The plain status and usage limits, for Cobble's chat replies. */
  async liveText(teamId: string): Promise<string> {
    const status = await this.deps.status(teamId, false).catch(() => "");
    const limits = this.deps.limits?.(teamId) ?? "";
    return [status, limits].filter(Boolean).join("\n");
  }
  async handle(teamId: string, text: string): Promise<ControlOutcome> {
    let command = parseControlCommand(text);
    if (!command || command.kind === "add") {
      const before = new Set(
        this.deps.teamStore.projectChatMessages(teamId).map((m) => m.id),
      );
      try {
        return {
          type: "planner",
          ...(await this.deps.projectChat.ask(teamId, text)),
        };
      } catch (error) {
        if (
          !this.deps.teamStore
            .projectChatMessages(teamId)
            .some((m) => !before.has(m.id) && m.author === "user")
        )
          this.deps.teamStore.projectChat(teamId, {
            author: "user",
            kind: "message",
            text,
          });
        return {
          type: "result",
          message: this.post(
            teamId,
            `Planner failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
    }
    if (
      command.kind === "pilot" &&
      command.until <
        new Date((this.deps.now ?? Date.now)()).toISOString().slice(0, 10)
    )
      command = {
        kind: "invalid",
        command: text,
        reason: "Pilot end date is in the past.",
      };
    this.deps.teamStore.projectChat(teamId, {
      author: "user",
      kind: "message",
      text,
    });
    const message = this.deps.teamStore.projectChat(teamId, {
      author: "cobble",
      kind: "control",
      text: describeControlCommand(command),
      control: { command, status: "pending" },
    });
    this.deps.onChange?.(teamId);
    if (
      needsConfirmation(command) &&
      ((command.kind === "promote" && this.promoting.has(teamId)) ||
        (command.kind === "continue" && this.restoring.has(teamId)))
    )
      return {
        type: "result",
        message: this.update(teamId, message, "failed", "Already in progress"),
      };
    if (needsConfirmation(command)) return { type: "confirm", message };
    return {
      type: "result",
      message: await this.confirm(teamId, message.id, true),
    };
  }
  private update(
    teamId: string,
    message: TeamChatMessage,
    status: "done" | "failed" | "cancelled",
    result: string,
  ) {
    const updated = this.deps.teamStore.updateProjectChatControl(
      teamId,
      message.id,
      { command: message.control!.command, status, result },
    )!;
    this.deps.onChange?.(teamId);
    return updated;
  }
  async confirm(
    teamId: string,
    messageId: string,
    yes: boolean,
  ): Promise<TeamChatMessage> {
    const message = this.deps.teamStore
      .projectChatMessages(teamId)
      .find((m) => m.id === messageId);
    if (!message?.control) throw new Error("Unknown control command");
    if (message.control.status !== "pending")
      throw new Error("This command was already handled");
    if (
      needsConfirmation(message.control.command) &&
      (this.inFlight.has(messageId) ||
        (message.control.command.kind === "promote" &&
          this.promoting.has(teamId)) ||
        (message.control.command.kind === "continue" &&
          this.restoring.has(teamId)))
    )
      throw new Error("Already in progress");
    if (!yes) return this.update(teamId, message, "cancelled", "Cancelled");
    if (!needsConfirmation(message.control.command)) {
      try {
        return this.update(
          teamId,
          message,
          "done",
          await this.execute(teamId, message.control.command),
        );
      } catch (error) {
        return this.update(
          teamId,
          message,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    this.inFlight.add(messageId);
    try {
      const command = message.control.command;
      if (command.kind === "promote" && this.deps.promoteTeam) {
        this.promoting.add(teamId);
        void Promise.resolve()
          .then(() => this.deps.promoteTeam!(teamId))
          .then(
            (result) => {
              this.post(
                teamId,
                typeof result === "string"
                  ? result
                  : result &&
                      typeof result === "object" &&
                      "message" in result &&
                      typeof result.message === "string"
                    ? result.message
                    : "Promotion finished.",
              );
            },
            (error) => {
              this.post(
                teamId,
                String(error instanceof Error ? error.message : error),
              );
            },
          )
          .finally(() => this.promoting.delete(teamId));
        return this.update(teamId, message, "done", "Promotion started");
      }
      const result = await this.execute(teamId, command);
      return this.update(teamId, message, "done", result);
    } catch (error) {
      return this.update(
        teamId,
        message,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.inFlight.delete(messageId);
    }
  }
  private async execute(
    teamId: string,
    command: ControlCommand,
  ): Promise<string> {
    const d = this.deps;
    switch (command.kind) {
      case "add":
        throw new Error("Add must use proposal planning");
      case "retry": {
        if (!d.retry) throw new Error("Retry service is unavailable");
        await d.retry(teamId, command.target);
        return `Retried ${command.target}.`;
      }
      case "review-later": {
        if (!d.reviewLater) throw new Error("Review service is unavailable");
        await d.reviewLater(teamId, command.runId);
        return `Marked ${command.runId} for review; branch kept.`;
      }
      case "logs": {
        // No id: the latest run. A short id prefix (from "status details") works too.
        const runs = d.runs(teamId);
        const run = command.runId
          ? (runs.find((r) => r.id === command.runId) ??
            (command.runId.length >= 4
              ? runs.find((r) => r.id.startsWith(command.runId))
              : undefined))
          : runs[0];
        if (!run) throw new Error("Unknown run");
        const time = (iso: string) =>
          new Date(iso).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
        const lines = d.teamStore
          .events(run.id, 200)
          .slice(-8)
          .map(
            (e) =>
              `${time(e.createdAt)}  ${e.message.replace(/\s+/g, " ").slice(0, 160)}`,
          );
        return lines.length
          ? `Latest activity in \u201c${shortLabel(run.goal, 60)}\u201d:\n${lines.join("\n")}`
          : "No activity yet.";
      }
      case "needs-you": {
        if (!d.appHub) throw new Error("App hub service is unavailable");
        const snapshot = await d.appHub(teamId);
        return (
          snapshot.needsYou
            .map((i) => `${i.title}${i.detail ? `: ${i.detail}` : ""}`)
            .join("\n") || "Nothing needs you."
        );
      }
      case "help":
        return CONTROL_HELP;
      case "invalid":
        return `${command.reason} Say help for commands.`;
      case "status":
        if (command.details && d.appHub)
          return (
            (await d.status(teamId, true)) +
            "\nPipeline health: " +
            (await d.appHub(teamId)).health
              .map((i) => `${i.severity}: ${i.title}`)
              .join("; ")
          );
        return d.status(teamId, command.details === true);
      case "queue":
        return controlQueueText(await d.queue(teamId));
      case "limits":
        return d.limits?.(teamId) ?? "Usage limits are not available here.";
      case "promote":
        return "Promotion is not available yet.";
      case "autopilot":
        await d.startAutopilot(teamId, {
          parallel: command.parallel,
          detach: d.detachAvailable,
        });
        return "Autopilot started.";
      case "pilot":
        d.saveSessionBrief(teamId, { endDate: command.until });
        await d.startAutopilot(teamId, {
          pilot: true,
          detach: d.detachAvailable,
        });
        return "Pilot started.";
      case "stop": {
        this.stopVersions.set(teamId, (this.stopVersions.get(teamId) ?? 0) + 1);
        this.restoring.delete(teamId);
        const previous = d.stopped(teamId);
        const automation = d.teamStore.automation(teamId);
        const savedOptions = automation?.options ?? previous?.autopilot;
        const status = structuredClone(d.autopilotStatus(teamId));
        // Runs waiting to auto-resume after a usage limit count as running:
        // stop must cancel their retry too, and continue resumes them.
        const runs = d
          .runs(teamId)
          .filter(
            (r) => r.state === "running" || (r.state === "paused" && !!r.retryAt),
          );
        const saved: StoppedSession = {
          ...(status.active
            ? {
                autopilot: structuredClone({
                  ...d.autopilotOptions(teamId),
                  pilot: status.pilot ?? d.autopilotOptions(teamId)?.pilot,
                }),
              }
            : savedOptions
              ? { autopilot: structuredClone(savedOptions) }
              : {}),
          runs: runs.map((r) => ({
            runId: r.id,
            item:
              status.currentRuns?.find((i) => i.runId === r.id)?.item ??
              (status.runId === r.id ? status.currentItem : undefined),
          })),
        };
        saved.runs = [
          ...new Map(
            [...(previous?.runs ?? []), ...saved.runs].map((run) => [
              run.runId,
              run,
            ]),
          ).values(),
        ];
        d.stopAutopilot(teamId);
        // Save before pausing so a partial failure cannot lose the restoration record.
        if (status.active || automation || runs.length)
          d.saveStopped(teamId, saved);
        for (const run of runs) await d.runCommand(teamId, run.id, "pause");
        return status.active || automation || runs.length
          ? "Stopped automation and paused running runs."
          : "Nothing was running.";
      }
      case "continue": {
        const saved = d.stopped(teamId);
        if (!saved) {
          // Nothing was stopped with "stop": resume runs paused another way.
          // Runs waiting for a usage limit come back on their own.
          const paused = d.runs(teamId).filter((r) => r.state === "paused");
          const waiting = paused.filter((r) => r.retryAt);
          const resumable = paused.filter((r) => !r.retryAt);
          for (const run of resumable)
            await d.runCommand(teamId, run.id, "resume");
          const parts: string[] = [];
          if (resumable.length)
            parts.push(
              `Resumed ${resumable.length === 1 ? "1 paused run" : `${resumable.length} paused runs`}.`,
            );
          if (waiting.length) {
            const next = waiting
              .map((r) => Date.parse(r.retryAt!))
              .filter(Number.isFinite)
              .sort((a, b) => a - b)[0];
            parts.push(
              `${waiting.length === 1 ? "1 run waits" : `${waiting.length} runs wait`} for a usage limit${next ? ` until ${new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""} and ${waiting.length === 1 ? "resumes" : "resume"} on its own.`,
            );
          }
          return parts.join(" ") || "Nothing is stopped or paused.";
        }
        if (d.autopilotStatus(teamId).active)
          return "Autopilot is still stopping: say continue again in a moment.";
        for (const run of saved.runs)
          await d.runCommand(teamId, run.runId, "resume");
        if (saved.autopilot) {
          this.restoring.add(teamId);
          const version = this.stopVersions.get(teamId);
          let waitingRun: string | undefined;
          void (async () => {
            for (const run of [...saved.runs]) {
              waitingRun = run.runId;
              const finished = (await d.waitForRun(teamId, run.runId)) as
                TeamRun | undefined;
              if (version !== this.stopVersions.get(teamId)) return;
              if (finished && finished.state !== "done")
                throw new Error(`Run ${run.runId} ended ${finished.state}.`);
              if (run.item) await d.completeAutopilotRun(teamId, run.runId);
              if (version !== this.stopVersions.get(teamId)) return;
              saved.runs = saved.runs.filter((r) => r.runId !== run.runId);
              d.saveStopped(teamId, saved);
            }
            waitingRun = undefined;
            await d.startAutopilot(teamId, saved.autopilot!);
            this.post(teamId, "Autopilot restored.");
          })()
            .catch((error) =>
              this.post(
                teamId,
                `Autopilot was not restarted${waitingRun ? ` after run ${waitingRun}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
            .finally(() => {
              if (version === this.stopVersions.get(teamId)) {
                d.saveStopped(teamId, null);
                this.restoring.delete(teamId);
              }
            });
        } else d.saveStopped(teamId, null);
        return "Saved runs resumed.";
      }
    }
  }
}
