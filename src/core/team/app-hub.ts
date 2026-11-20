import type { TeamStore } from "./team-store";
import type { TeamRun, TeamTask } from "./types";
import type { AutomationRecord } from "./automation";
import { DAEMON_STALE_MS } from "./daemon";
import { LEASE_MS } from "./orchestrator-context";
import { shortLabel } from "./control-commands";

/** Resolve only within this project, and validate everything before writing. */
export async function retryAppHubTarget(
  store: TeamStore,
  teamId: string,
  target: string,
  leasedElsewhere: (runId: string) => boolean,
  resume: (runId: string) => Promise<unknown>,
): Promise<unknown> {
  const runs = store.runs(teamId);
  const direct = runs.find((run) => run.id === target);
  const matches = runs.flatMap((run) =>
    store
      .tasks(run.id)
      .filter((task) => task.id === target)
      .map((task) => ({ run, task })),
  );
  if (!direct && matches.length !== 1)
    throw new Error("Unknown or ambiguous task; use a unique task identifier");
  const run = direct ?? matches[0].run;
  if (leasedElsewhere(run.id)) throw new Error("Another process owns this run");
  if (!["paused", "failed"].includes(run.state))
    throw new Error("Run cannot be retried in its current state");
  if (run.gate) throw new Error("Use the existing human approval path");
  const tasks = direct
    ? store
        .tasks(run.id)
        .filter((task) => ["failed", "interrupted"].includes(task.state))
    : [matches[0].task];
  if (run.state === "failed" && !tasks.length)
    throw new Error("No failed tasks to retry");
  for (const task of tasks) {
    if (!["failed", "interrupted"].includes(task.state))
      throw new Error("Task cannot be retried in its current state");
    if (task.target === "production" || task.gate)
      throw new Error("Use the existing human approval path");
    if (task.attempt >= run.budget.maxAttempts)
      throw new Error("Task retry budget exhausted");
  }
  for (const task of tasks) {
    task.state = "queued";
    task.error = undefined;
    task.finishedAt = undefined;
    task.delivered = false;
    store.saveTask(task);
  }
  run.state = "paused";
  store.saveRun(run);
  return resume(run.id);
}

export interface AppHubSnapshot {
  needsYou: AppHubNeed[];
  health: AppHubHealth[];
}
export interface AppHubNeed {
  id: string;
  runId?: string;
  taskId?: string;
  title: string;
  detail?: string;
  actions: AppHubAction[];
}
export interface AppHubHealth {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  detail?: string;
  actions: AppHubAction[];
}
export interface AppHubAction {
  id: string;
  label: string;
  kind:
    | "answer"
    | "approve"
    | "deny"
    | "retry"
    | "skip"
    | "review-later"
    | "recover"
    | "retry-check"
    | "restart";
  runId?: string;
  taskId?: string;
  gateId?: string;
  humanOnly?: boolean;
}
export interface AppHubInput {
  now: number;
  runs: { run: TeamRun; tasks: TeamTask[] }[];
  daemon: ReturnType<TeamStore["daemonLock"]>;
  automation?: AutomationRecord | null;
  processAlive(pid: number): boolean;
  /** false means proven dead; undefined means unknown, never permission to recover. */
  ownerAlive(ownerId: string): boolean | undefined;
  checkout?: { stale: boolean; detail?: string };
  reviewItems?: {
    id: string;
    title: string;
    branch?: string;
    runId?: string;
  }[];
}
/**
 * One plain line about a failed check instead of its raw output: how many
 * tests failed and the first one's name, or the last meaningful line.
 */
export function checkSummary(output: string): string {
  const failed = [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*(?:✖|not ok \d+ -)\s+(.+?)(?:\s+\(\d[\d.]*ms\))?\s*$/)?.[1])
        .filter((name): name is string => !!name && name !== "failing tests:"),
    ),
  ];
  if (failed.length) {
    const first = failed[0]!.length > 90 ? `${failed[0]!.slice(0, 89)}…` : failed[0];
    return failed.length === 1
      ? `1 test failed: “${first}”.`
      : `${failed.length} tests failed, first: “${first}”.`;
  }
  if (/error TS\d+/.test(output))
    return `Type errors (${(output.match(/error TS\d+/g) ?? []).length}).`;
  const last = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s/.test(line))
    .pop();
  return last ? (last.length > 120 ? `${last.slice(0, 119)}…` : last) : "The check failed.";
}

/** Only explicit timeout evidence qualifies; arbitrary failing output never does. */
export function timeoutOnlyCheck(check: TeamTask["check"]): boolean {
  return (
    !!check &&
    !check.passed &&
    (check.timedOut === true ||
      /^\s*(?:check )?(?:timed out|timeout)(?: after \d+\s*(?:ms|s|seconds|milliseconds))?[.!]?\s*$/i.test(
        check.output,
      ))
  );
}
export function buildAppHubSnapshot(input: AppHubInput): AppHubSnapshot {
  const needsYou: AppHubNeed[] = [];
  const health: AppHubHealth[] = [];
  const action = (
    kind: AppHubAction["kind"],
    label: string,
    runId?: string,
    taskId?: string,
    gateId?: string,
  ): AppHubAction => ({
    id: JSON.stringify([kind, runId ?? null, taskId ?? null, gateId ?? null]),
    kind,
    label,
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(gateId ? { gateId } : {}),
  });
  const restart = () => [action("restart", "Restart")];
  const lock = input.daemon;
  // A missing daemon only matters when unfinished work has nobody driving it
  // (Autopilot or the app can drive runs themselves).
  const undriven = input.runs.some(
    ({ run }) =>
      !["done", "failed", "stopped"].includes(run.state) &&
      (!run.ownerId || input.ownerAlive(run.ownerId) === false),
  );
  if (
    undriven &&
    (!lock ||
      input.now - lock.heartbeat >= DAEMON_STALE_MS ||
      !input.processAlive(lock.pid))
  )
    health.push({
      id: "daemon",
      severity: "error",
      title: "Daemon is not healthy",
      actions: restart(),
    });
  const automation = input.automation;
  if (
    automation &&
    (input.now - automation.heartbeatAt >= DAEMON_STALE_MS ||
      !input.processAlive(automation.ownerPid))
  )
    health.push({
      id: "automation",
      severity: "error",
      title: "Automation owner stopped responding",
      actions: restart(),
    });
  for (const { run, tasks } of input.runs) {
    const waitingForLimit = run.state === "paused" && !!run.retryAt;
    if (run.state === "running") {
      const fresh =
        !!run.ownerId && input.now - Date.parse(run.ownerSeen ?? "") < LEASE_MS;
      const orphan =
        !fresh && (!run.ownerId || input.ownerAlive(run.ownerId) === false);
      if (orphan)
        health.push({
          id: `orphan:${run.id}`,
          severity: "error",
          title: "Run has no live owner",
          detail: run.id,
          actions: [action("recover", "Recover", run.id)],
        });
    }
    const gate = (value: NonNullable<TeamRun["gate"]>, task?: TeamTask) => {
      const gateId = JSON.stringify([run.id, task?.id ?? null, value]);
      const humanOnly =
        (!["clarify", "questions"].includes(value.kind) &&
          !(
            value.kind === "approval" &&
            task &&
            task.target !== "production"
          )) ||
        task?.target === "production";
      needsYou.push({
        id: gateId,
        runId: run.id,
        ...(task ? { taskId: task.id } : {}),
        title: value.message,
        detail: humanOnly
          ? "Only you can do this: use the Approve, Deny or Done buttons on its card in the chat."
          : undefined,
        actions: humanOnly
          ? []
          : [
              ...(value.kind === "approval"
                ? [
                    action("approve", "Approve", run.id, task?.id, gateId),
                    action("deny", "Deny", run.id, task?.id, gateId),
                  ]
                : [
                    action("answer", "Answer", run.id, task?.id, gateId),
                    action("skip", "Skip", run.id, task?.id, gateId),
                  ]),
            ],
      });
    };
    if (run.state === "needs_human" && run.gate) gate(run.gate);
    for (const task of tasks) {
      if (task.state === "needs_decision" && task.question)
        needsYou.push({
          id: `question:${run.id}:${task.id}`,
          runId: run.id,
          taskId: task.id,
          title: task.question.text,
          actions:
            task.target === "production"
              ? []
              : [
                  action(
                    "answer",
                    "Answer",
                    run.id,
                    task.id,
                    JSON.stringify(task.question),
                  ),
                ],
        });
      if (task.state === "needs_human" && task.gate) gate(task.gate, task);
      // While a run is going, its agents fix their own failing checks; the
      // user only hears about a failed check once nobody is working on it.
      // A stopped or finished run was ended on purpose, so its old checks
      // need nothing from the user either.
      // A check that only timed out keeps its Retry button in any unfinished
      // run (that is not the agents' fault).
      if (
        task.check &&
        !task.check.passed &&
        (timeoutOnlyCheck(task.check)
          ? !["done", "stopped"].includes(run.state)
          : ["paused", "needs_human", "failed"].includes(run.state) &&
            !waitingForLimit)
      ) {
        const actions = timeoutOnlyCheck(task.check)
          ? [action("retry-check", "Retry check", run.id, task.id)]
          : [];
        needsYou.push({
          id: `check:${run.id}:${task.id}`,
          runId: run.id,
          taskId: task.id,
          title: `Check failed: ${task.title}`,
          detail: checkSummary(task.check.output),
          actions,
        });
        if (actions.length)
          health.push({
            id: `timeout:${run.id}:${task.id}`,
            severity: "warning",
            title: "Check timed out",
            actions,
          });
      }
    }
    if (run.unmerged?.length)
      needsYou.push({
        id: `kept:${run.id}`,
        runId: run.id,
        title: "Kept branch needs review",
        detail: run.runBranch,
        actions: [action("review-later", "Review later", run.id)],
      });
    // A run waiting out a usage limit resumes on its own: nothing to do.
    if (run.state === "failed" || (run.state === "paused" && !waitingForLimit))
      needsYou.push({
        id: `retry:${run.id}`,
        runId: run.id,
        title: `Run ${run.state}`,
        detail: shortLabel(run.goal, 80),
        actions: [action("retry", "Retry", run.id)],
      });
  }
  for (const item of input.reviewItems ?? [])
    needsYou.push({
      id: `review:${item.id}`,
      runId: item.runId,
      // "[r] (built on branch …) Token efficiency 4 — long text" → its name.
      title: `To review later: ${shortLabel(
        item.title.replace(/^-?\s*\[r\]\s*/i, "").replace(/^\([^)]*\)\s*/, ""),
        70,
      )}`,
      detail: item.branch,
      actions: [],
    });
  if (input.checkout?.stale)
    health.push({
      id: "checkout",
      severity: "warning",
      title: "Local checkout is behind the promoted branch",
      detail: input.checkout.detail,
      actions: [],
    });
  return { needsYou, health };
}
export interface AppHubDeps {
  teamStore: TeamStore;
  input(teamId: string): Promise<AppHubInput> | AppHubInput;
  /** Adapter must reuse existing gate/retry/recovery/check/lifecycle services. */
  execute(
    teamId: string,
    action: AppHubAction,
    answer?: string,
  ): Promise<unknown>;
  onChange?(teamId: string): void;
}
export class AppHub {
  private readonly busy = new Set<string>();
  constructor(private readonly deps: AppHubDeps) {}
  async snapshot(teamId: string): Promise<AppHubSnapshot> {
    return buildAppHubSnapshot(await this.deps.input(teamId));
  }
  async act(
    teamId: string,
    submitted: AppHubAction,
    answer?: string,
  ): Promise<void> {
    const post = (text: string) => {
      this.deps.teamStore.projectChat(teamId, {
        author: "cobble",
        kind: "message",
        text,
      });
      this.deps.onChange?.(teamId);
    };
    const key = `${teamId}:${submitted.id}`;
    let acquired = false;
    try {
      if (this.busy.has(key)) throw new Error("Action already in progress");
      this.busy.add(key);
      acquired = true;
      const snapshot = await this.snapshot(teamId);
      const action = [...snapshot.needsYou, ...snapshot.health]
        .flatMap((i) => i.actions)
        .find((a) => a.id === submitted.id);
      if (
        !action ||
        action.humanOnly ||
        ["kind", "runId", "taskId", "gateId"].some(
          (k) =>
            action[k as keyof AppHubAction] !==
            submitted[k as keyof AppHubAction],
        )
      )
        throw new Error(
          "Action is unavailable; human-only approvals require the existing human path",
        );
      if (action.kind === "answer" && !answer?.trim())
        throw new Error("Enter an answer first");
      post(
        `Action requested: ${action.kind} ${action.runId ?? ""} ${action.taskId ?? ""}`,
      );
      if (answer)
        this.deps.teamStore.projectChat(teamId, {
          author: "user",
          kind: "answer",
          text: answer.slice(0, 8000),
        });
      const result = await this.deps.execute(teamId, action, answer);
      post(
        `Action completed: ${action.kind} ${action.runId ?? ""} ${action.taskId ?? ""}${result === undefined ? "" : `: ${String(typeof result === "string" ? result : JSON.stringify(result)).slice(0, 4000)}`}`,
      );
    } catch (error) {
      post(
        `Action failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      if (acquired) this.busy.delete(key);
    }
  }
}

/** Resolve both refs locally; do not infer freshness from promotion timestamps. */
export async function appHubCheckout(
  target: string,
  git: (...args: string[]) => Promise<string>,
): Promise<AppHubInput["checkout"]> {
  try {
    const head = await git("rev-parse", "HEAD");
    const promoted = await git("rev-parse", `refs/heads/${target}`);
    if (head === promoted) return { stale: false };
    await git("merge-base", "--is-ancestor", head, promoted);
    return { stale: true, detail: `${target}: ${head} -> ${promoted}` };
  } catch {
    return undefined;
  }
}
