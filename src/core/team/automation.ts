import type { AutopilotOptions } from "../../shared/types";
import type { TeamRun } from "./types";
import { DAEMON_STALE_MS } from "./daemon";

export interface AutomationRecord {
  teamId: string;
  options: AutopilotOptions;
  startedAt: string;
  ownerPid: number;
  ownerId: string;
  heartbeatAt: number;
  runs: { runId: string; item?: string }[];
  restoreSince?: number;
}
export const automationKey = (teamId: string) => `teamAutomation:${teamId}`;
export function automationStale(
  r: AutomationRecord,
  now: number,
  staleMs: number,
  pidAlive?: (pid: number) => boolean,
): boolean {
  return now - r.heartbeatAt > staleMs || !!(pidAlive && !pidAlive(r.ownerPid));
}
export interface RestoreDeps {
  ownerId: string;
  records(): AutomationRecord[];
  claim(teamId: string, expectedOwnerId: string, newOwnerId: string): boolean;
  stopped(teamId: string): unknown;
  autopilotActive(teamId: string): boolean;
  runs(teamId: string): TeamRun[];
  waitForRun(
    teamId: string,
    runId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TeamRun | undefined>;
  completeAutopilotRun(
    teamId: string,
    runId: string,
    opts: { item: string; backlogPath?: string },
  ): Promise<unknown>;
  startAutopilot(teamId: string, options: AutopilotOptions): Promise<unknown>;
  clear(teamId: string): void;
  note(teamId: string, text: string): void;
  now(): number;
  pidAlive?(pid: number): boolean;
}
export class AutomationRestorer {
  private readonly inFlight = new Set<string>();
  private sleptAt = -Infinity;
  private readonly shutdown = new AbortController();
  close(): void {
    this.shutdown.abort();
  }
  constructor(
    private readonly deps: RestoreDeps,
    private readonly o: {
      staleMs?: number;
      waitMs?: number;
      giveUpMs?: number;
    } = {},
  ) {}
  noteSleep(now: number): void {
    this.sleptAt = now;
  }
  tick(): void {
    const d = this.deps,
      now = d.now(),
      staleMs = this.o.staleMs ?? DAEMON_STALE_MS;
    if (this.shutdown.signal.aborted || now - this.sleptAt < staleMs) return;
    for (const r of d.records()) {
      if (
        this.inFlight.has(r.teamId) ||
        d.stopped(r.teamId) ||
        d.autopilotActive(r.teamId) ||
        !automationStale(r, now, staleMs, d.pidAlive) ||
        (d.pidAlive?.(r.ownerPid) && now - r.heartbeatAt < 2 * staleMs)
      )
        continue;
      if (
        r.restoreSince !== undefined &&
        now - r.restoreSince >= (this.o.giveUpMs ?? 86400000)
      ) {
        if (!d.claim(r.teamId, r.ownerId, d.ownerId)) continue;
        d.note(r.teamId, "Autopilot recovery gave up after waiting too long.");
        d.clear(r.teamId);
        continue;
      }
      if (
        d
          .runs(r.teamId)
          .some(
            (run) =>
              run.state === "paused" ||
              run.state === "needs_human" ||
              (run.state === "running" &&
                !r.runs.some((saved) => saved.runId === run.id)),
          )
      )
        continue;
      if (!d.claim(r.teamId, r.ownerId, d.ownerId)) continue;
      this.inFlight.add(r.teamId);
      void this.restore(r).finally(() => this.inFlight.delete(r.teamId));
    }
  }
  private owns(r: AutomationRecord): boolean {
    return (
      !this.shutdown.signal.aborted &&
      !this.deps.stopped(r.teamId) &&
      this.deps
        .records()
        .some(
          (record) =>
            record.teamId === r.teamId && record.ownerId === this.deps.ownerId,
        )
    );
  }
  private async restore(r: AutomationRecord): Promise<void> {
    const d = this.deps;
    try {
      for (const saved of r.runs) {
        const run = await d.waitForRun(
          r.teamId,
          saved.runId,
          this.o.waitMs ?? 60000,
          this.shutdown.signal,
        );
        if (!this.owns(r)) return;
        if (
          !run ||
          run.state === "running" ||
          run.state === "paused" ||
          run.state === "needs_human"
        )
          return;
        if (run.state !== "done")
          throw new Error(`Run ${saved.runId} ended ${run.state}.`);
        if (saved.item)
          await d.completeAutopilotRun(r.teamId, saved.runId, {
            item: saved.item,
            backlogPath: r.options.backlogPath,
          });
      }
      if (!this.owns(r)) return;
      await d.startAutopilot(r.teamId, { ...r.options, detach: true });
      if (this.shutdown.signal.aborted) return;
      d.note(
        r.teamId,
        `${r.options.pilot ? "Pilot" : "Autopilot"} restarted after Cobble stopped unexpectedly`,
      );
    } catch (error) {
      if (this.shutdown.signal.aborted) return;
      const current = d.records().find((record) => record.teamId === r.teamId);
      if (d.stopped(r.teamId) || (current && current.ownerId !== d.ownerId))
        return;
      d.note(r.teamId, `Autopilot was not restarted: ${String(error)}`);
      d.clear(r.teamId);
    }
  }
}
