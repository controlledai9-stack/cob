import { promptSizeMessage } from "./prompt-size";
import { assess } from "../engine";
import { runCheck } from "./checks";
import { decideReview, type ReviewDecision } from "./review-policy";
import { apply } from "./planner-turn";
import { condenseAgentText } from "./helper-presentations";
import { reportFromReply, parseTaskReport } from "./actions";
import type { AdapterResult } from "./adapters";
import { addUsage, emptyUsage, unknownTurn } from "./usage";
import { workerPrompt } from "./prompts";
import {
  WRITING_ROLES,
  type TeamAgentId,
  type TeamRole,
  type TeamRun,
  type TeamTask,
} from "./types";
import {
  TASK_QUESTION_LIMIT,
  type OrchestratorContext,
} from "./orchestrator-context";

export async function runTask(
  ctx: OrchestratorContext,
  runId: string,
  taskId: string,
) {
  const key = `${runId}:${taskId}`;
  const controller = new AbortController();
  ctx.state.running.set(key, controller);
  const run = ctx.require(runId);
  let task = ctx.store.tasks(runId).find((t) => t.id === taskId)!;
  const team = ctx.options.team(run.teamId);
  const finish = (patch: Partial<TeamTask>) => {
    const current = ctx.store.tasks(runId).find((t) => t.id === taskId)!;
    if (current.state !== "running") return; // stopped meanwhile
    Object.assign(current, patch, {
      finishedAt: new Date(ctx.now()).toISOString(),
    });
    ctx.store.saveTask(current);
    task = current;
  };
  try {
    if (!team)
      return finish({
        state: "failed",
        error: "The team is no longer available",
      });
    const resuming = !!task.resumeNote;
    const writing = WRITING_ROLES.has(task.role);
    const wt = ctx.worktrees(run);
    let cwd = wt.runPath(run.id);
    let base: string | undefined;
    if (writing) {
      const prepared = await wt.prepareTask(run.id, task.id);
      if (run.shareDependencies) await wt.linkDependencies(prepared.path);
      cwd = prepared.path;
      task.worktree = prepared.path;
      task.branch = prepared.branch;
      // Keep the first base: a resumed or retried task diffs from where it began.
      base = task.base ?? prepared.base;
      task.base = base;
    }
    const latest = ctx.store.tasks(runId).find((t) => t.id === taskId);
    if (latest?.state !== "running") return; // stopped while preparing
    if (ctx.capReached(ctx.require(runId))) {
      latest.state = "queued";
      latest.startedAt = undefined;
      ctx.store.saveTask(latest);
      ctx.pauseForCap(runId);
      return;
    }
    task.attempt = latest.attempt;
    task.resumeNote = latest.resumeNote;
    if (!resuming) task.attempt++;
    // A report from an earlier invocation must never decide this one.
    if (writing) await wt.clearReport(cwd);
    const note = task.resumeNote;
    task.resumeNote = undefined;
    ctx.store.saveTask(task);
    ctx.log(
      run,
      "task",
      `${task.id} started on ${task.agent}${resuming ? " (resumed)" : ""}`,
      task.id,
    );
    const reviewTarget = task.reviews
      ? ctx.store.tasks(runId).find((t) => t.id === task.reviews)
      : undefined;
    // Re-read the run so workers always get the latest architecture brief.
    const current = ctx.require(runId);
    let result: AdapterResult;
    try {
      const diff =
        task.role === "reviewer" && reviewTarget
          ? await wt.diffText(
              wt.runPath(run.id),
              reviewTarget.base ?? run.baseBranch,
              reviewTarget.branch ?? run.runBranch,
            )
          : undefined;
      const prompt = workerPrompt(
        team,
        current,
        task,
        note,
        reviewTarget ? { task: reviewTarget, diff } : undefined,
        ctx.store.decisionsFromUser(run.teamId),
      );
      ctx.log(
        run,
        "prompt",
        promptSizeMessage(`${task.id} ${task.role}`, prompt),
        task.id,
      );
      result = await ctx.adapters[task.agent].run({
        model: task.member
          ? ctx.store
              .members(run.teamId)
              .find((m) => m.name === task.member && m.agent === task.agent)
              ?.model
          : undefined,
        cwd,
        prompt,
        resumeSessionId: resuming ? task.sessionId : undefined,
        readOnly: !writing,
        network: task.role === "deployer",
        fullAccess:
          writing &&
          (task.member && run.fullAccessMembers
            ? run.fullAccessMembers.includes(task.member)
            : (run.fullAccessRoles ?? []).includes(task.role)),
        timeoutMs: run.budget.taskTimeoutMs,
        signal: controller.signal,
        task: {
          teamId: run.teamId,
          runId: run.id,
          taskId: task.id,
          role: task.role,
        },
      });
    } catch (error) {
      return finish({
        state: "failed",
        error: `Could not start ${task.agent}: ${error instanceof Error ? error.message : error}`,
      });
    }
    await recordUsageTurn(
      ctx,
      ctx.require(runId),
      task.agent,
      result,
      task.role,
      task.member,
    );
    if (controller.signal.aborted) return;
    // Report file (writers) or a ```cobble-report block in the reply (anyone).
    const report =
      (writing ? parseTaskReport((await wt.readReport(cwd)) ?? "") : null) ??
      parseTaskReport(reportFromReply(result.finalText) ?? "");
    const patch: Partial<TeamTask> = {
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.usage
        ? {
            usage: addUsage({ ...(task.usage ?? emptyUsage()) }, result.usage),
          }
        : {}),
      ...(report
        ? { report }
        : !result.finalText
          ? {}
          : {
              report: {
                status: result.exitCode === 0 ? "done" : "failed",
                summary: result.finalText.slice(-2_000),
                files: [],
              },
            }),
    };
    if (writing && base) {
      const refreshEvidence = async () => {
        const { changes, blocked } = await wt.capture(
          cwd,
          base,
          `${task.id}: ${task.title}`.slice(0, 200),
          task.branch,
        );
        const assessment = assess(team, changes);
        patch.drift = {
          ...(blocked.length > 0 ? { blocked: blocked.slice(0, 50) } : {}),
          classification: assessment.classification,
          alert: assessment.alert || blocked.length > 0,
          explanation: blocked.length
            ? `Cobble refused to commit secret-looking files (${blocked.slice(0, 5).join(", ")}); they stay uncommitted in the task worktree. ${assessment.explanation}`
            : assessment.explanation,
          paths: changes.map((c) => c.path).slice(0, 200),
        };
        if (blocked.length)
          ctx.log(
            run,
            "drift",
            `${task.id}: not committed (secret-looking): ${blocked.slice(0, 5).join(", ")}`,
            task.id,
          );
        if (assessment.alert) {
          ctx.log(
            run,
            "drift",
            `${task.id}: ${assessment.explanation}`,
            task.id,
          );
          ctx.say(run, {
            author: "cobble",
            taskId: task.id,
            member: task.member,
            kind: "drift",
            text: `Plan guard: ${task.id} may be off plan. ${assessment.explanation}`,
          });
        }
        patch.diffStat = await wt.diffStat(cwd, base);
        return changes;
      };
      const changes = await refreshEvidence();
      if (run.checkCommand && changes.length && !controller.signal.aborted) {
        ctx.log(
          run,
          "check",
          `${task.id}: running \`${run.checkCommand}\``,
          task.id,
        );
        let check = await runCheck(
          run.checkCommand,
          cwd,
          undefined,
          controller.signal,
        );
        if (!check.passed)
          ctx.log(
            run,
            "check",
            `${task.id}: initial check failed\n${check.output}`,
            task.id,
          );
        const debuggerMember = ctx.store
          .members(run.teamId)
          .find(
            (m) =>
              m.role === "debugger" &&
              m.agent === "free" &&
              !m.fullAccess &&
              !m.backup,
          );
        if (!check.passed && debuggerMember && task.role !== "debugger") {
          let repaired = false;
          for (let turn = 1; turn <= 2; turn++) {
            if (controller.signal.aborted || ctx.capReached(ctx.require(runId)))
              break;
            await refreshEvidence();
            if (controller.signal.aborted) break;
            const diff = await wt.diffText(cwd, base, "HEAD");
            if (controller.signal.aborted) break;
            ctx.log(
              run,
              "check",
              `${task.id}: debugger ${debuggerMember.name} repair ${turn}/2`,
              task.id,
            );
            let repair: AdapterResult;
            try {
              repair = await ctx.adapters.free.run({
                cwd,
                prompt: [
                  `Repair the failing check for task ${task.id}: ${task.title.slice(0, 500)}.`,
                  "Make only the minimal fix in this worktree using file tools. Do not change task reports or weaken checks. Cobble will rerun the check.",
                  `Check: ${run.checkCommand.slice(0, 2000)}`,
                  `Failing output:\n${check.output.slice(0, 2000)}\n${check.output.slice(-4000)}`,
                  `Current task diff:\n${diff}`,
                ].join("\n\n"),
                readOnly: false,
                fullAccess: false,
                network: false,
                timeoutMs: run.budget.taskTimeoutMs,
                signal: controller.signal,
                task: { teamId: run.teamId, runId, taskId, role: "debugger" },
              });
            } catch (error) {
              ctx.log(
                run,
                "check",
                `${task.id}: debugger unavailable: ${String(error).slice(0, 500)}`,
                task.id,
              );
              if (!controller.signal.aborted) await refreshEvidence();
              break;
            }
            await recordUsageTurn(
              ctx,
              ctx.require(runId),
              "free",
              repair,
              "debugger",
              debuggerMember.name,
            );
            if (repair.usage) {
              patch.usage = addUsage(
                patch.usage ??
                  addUsage({ ...(task.usage ?? emptyUsage()) }, unknownTurn()),
                repair.usage,
              );
              const entries = (
                patch.debuggerUsage ??
                task.debuggerUsage ??
                []
              ).map((entry) => ({
                member: entry.member,
                usage: { ...entry.usage },
              }));
              const entry = entries.find(
                (entry) => entry.member === debuggerMember.name,
              );
              if (entry) addUsage(entry.usage, repair.usage);
              else
                entries.push({
                  member: debuggerMember.name,
                  usage: addUsage(emptyUsage(), repair.usage),
                });
              patch.debuggerUsage = entries;
            }
            repaired = true;
            if (controller.signal.aborted) break;
            await refreshEvidence();
            if (controller.signal.aborted) break;
            check = await runCheck(
              run.checkCommand,
              cwd,
              undefined,
              controller.signal,
            );
            ctx.log(
              run,
              "check",
              `${task.id}: debugger repair ${turn}/2 check ${check.passed ? "passed" : "failed"}\n${check.output.slice(-4000)}`,
              task.id,
            );
            if (
              check.passed ||
              repair.exitCode !== 0 ||
              repair.timedOut ||
              repair.authRequired ||
              repair.rateLimited
            )
              break;
          }
          if (repaired && !controller.signal.aborted) await refreshEvidence();
        }
        patch.check = { command: run.checkCommand, ...check };
        // A long failing output is condensed by the optional local helper
        // before the planner reads it; the full output stays in the log.
        const helper = ctx.options.helper?.(run.teamId);
        if (helper && !check.passed && check.output.length > 6_000) {
          const condensed = await condenseAgentText(helper, check.output, "");
          if (condensed && condensed !== check.output)
            patch.check.condensed = condensed;
        }
        ctx.log(
          run,
          "check",
          `${task.id}: check ${check.passed ? "passed" : "failed"}`,
          task.id,
        );
        ctx.say(run, {
          author: "cobble",
          taskId: task.id,
          member: task.member,
          kind: "check",
          text: `${task.id}: \`${run.checkCommand}\` ${check.passed ? "passed" : "failed"}`,
        });
      }
    }
    if (controller.signal.aborted) {
      const stopped = ctx.store
        .tasks(runId)
        .find((entry) => entry.id === taskId);
      if (stopped && patch.usage) {
        stopped.usage = patch.usage;
        stopped.debuggerUsage = patch.debuggerUsage ?? task.debuggerUsage;
        ctx.store.saveTask(stopped);
      }
      return;
    }
    const needs =
      result.authRequired ??
      (report?.status === "needs_human"
        ? (report.needsHuman ?? { service: task.agent, hint: report.summary })
        : undefined);
    if (needs) {
      const message = `${task.agent} needs you (${needs.service}): ${needs.hint}`;
      finish({
        ...patch,
        state: "needs_human",
        gate: { kind: "login", message },
      });
      ctx.store.event(runId, "gate", message, taskId);
      ctx.emit("attention", {
        runId,
        taskId,
        kind: "needs_you",
        message,
        worktree: cwd,
        gate: { kind: "login", taskId },
      });
      return;
    }
    if (report?.status === "needs_decision" && report.question) {
      const questions = (task.questions ?? 0) + 1;
      if (questions > TASK_QUESTION_LIMIT)
        return finish({
          ...patch,
          questions,
          state: "failed",
          error: `Asked more than ${TASK_QUESTION_LIMIT} questions; the task needs clearer instructions.`,
        });
      finish({
        ...patch,
        questions,
        state: "needs_decision",
        question: {
          text: report.question,
          options: report.options ?? [],
          delivered: false,
        },
      });
      ctx.log(
        run,
        "question",
        `${task.id} asks the planner: ${report.question.slice(0, 200)}`,
        task.id,
      );
      ctx.say(run, {
        author: "agent",
        agent: task.agent,
        role: task.role,
        taskId: task.id,
        member: task.member,
        kind: "question",
        text: [
          `@planner ${report.question}`,
          ...(report.options?.length
            ? [`Options: ${report.options.join(" / ")}`]
            : []),
        ].join("\n"),
      });
      return;
    }
    if (result.rateLimited) {
      // A backup agent for this role takes over once (no ping-pong).
      const backup = task.switchedFrom
        ? null
        : await usableBackup(
            ctx,
            run.teamId,
            task.role,
            task.agent,
            task.member,
          );
      if (backup) {
        ctx.log(
          run,
          "task",
          `${task.id}: ${task.agent} hit a usage limit; backup ${backup} takes over`,
          task.id,
        );
        return finish({
          ...patch,
          state: "queued",
          agent: backup,
          switchedFrom: task.agent,
          sessionId: undefined,
          resumeNote: `The ${task.agent} agent that started this task hit its usage limit and you are taking over. Earlier work in this worktree is already committed; check it, then complete the task.`,
        });
      }
      return finish({
        ...patch,
        state: "failed",
        error: `${task.agent} hit a usage limit. Reassign the role, set a backup agent, or try later.`,
      });
    }
    const failed =
      result.timedOut ||
      report?.status === "failed" ||
      (result.exitCode !== 0 && report?.status !== "done");
    if (failed) {
      const error = result.timedOut
        ? "Timed out"
        : report?.summary || `Exited with code ${result.exitCode}`;
      if (
        task.attempt < run.budget.maxAttempts &&
        !result.timedOut &&
        report?.status !== "failed"
      ) {
        finish({ ...patch, state: "queued", error });
        ctx.log(
          run,
          "task",
          `${task.id} failed, retrying (attempt ${task.attempt}/${run.budget.maxAttempts})`,
          task.id,
        );
        return;
      }
      ctx.say(run, {
        author: "agent",
        agent: task.agent,
        role: task.role,
        taskId: task.id,
        member: task.member,
        kind: "report",
        text: `${task.id} failed: ${error}`,
      });
      return finish({ ...patch, state: "failed", error });
    }
    // The team's review policy: small, safe, checked changes skip the LLM
    // review; others get a reviewer task Cobble queues itself.
    let review: ReviewDecision | undefined;
    if (writing && base && patch.drift?.paths.length) {
      const changedLines = await wt.changedLines(cwd, base);
      review = ctx.store.tasks(runId).some((t) => t.reviews === task.id)
        ? undefined
        : decideReview({
            policy: ctx.store.reviewPolicy(run.teamId),
            checkPassed: patch.check?.passed,
            changedLines,
            paths: patch.drift.paths,
            driftAlert: patch.drift.alert,
            blocked: patch.drift.blocked?.length,
          });
      if (review && !review.review) patch.reviewSkipped = review.reason;
    }
    finish({ ...patch, state: "done", error: undefined });
    if (review && task.state === "done") {
      if (review.review) queueReview(ctx, runId, task, review.reason);
      else {
        const text = `${task.id} accepted without an LLM review (${review.reason})`;
        ctx.log(run, "review", text, task.id);
        ctx.say(run, {
          author: "cobble",
          kind: "check",
          taskId: task.id,
          member: task.member,
          text,
        });
      }
    }
    ctx.log(run, "task", `${task.id} done`, task.id);
    ctx.say(run, {
      author: "agent",
      agent: task.agent,
      role: task.role,
      taskId: task.id,
      member: task.member,
      kind: "report",
      text: `Done with ${task.id}: ${patch.report?.summary || task.title}`,
    });
  } catch (error) {
    finish({
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    ctx.state.running.delete(key);
    ctx.schedule(runId);
  }
}

/**
 * Queues a reviewer task for a finished task, as a planner hand-off would
 * (same budget and member checks). With no reviewer on the team the planner
 * is told instead, so the run never waits on a review that cannot happen.
 */
export function queueReview(
  ctx: OrchestratorContext,
  runId: string,
  task: TeamTask,
  reason: string,
) {
  const run = ctx.require(runId);
  const tasks = ctx.store.tasks(runId);
  const stem = task.id.slice(0, 25);
  let id = `${stem}-review`;
  for (let n = 2; tasks.some((t) => t.id === id); n++) {
    const ending = `-review-${n}`;
    id = `${stem.slice(0, 32 - ending.length)}${ending}`;
  }
  const tell = (text: string) => {
    const current = ctx.require(runId);
    current.pendingNotes.push(text);
    current.wakeRequested = true;
    ctx.store.saveRun(current);
  };
  if (!ctx.store.members(run.teamId).some((m) => m.role === "reviewer")) {
    tell(
      `${task.id} should be reviewed (${reason}) but the team has no reviewer. Look at its diff yourself before accepting it.`,
    );
    return;
  }
  void apply(ctx, run, {
    type: "delegate",
    id,
    role: "reviewer",
    reviews: task.id,
    dependsOn: [],
    title: `Review ${task.id}`,
    instructions: `Review the changes of ${task.id} for correctness and fit to the brief. Cobble asks for this review because: ${reason}. Give the verdict approve or changes.`,
    acceptance: ["verdict given"],
  })
    .then(() => {
      const queued = ctx.store.tasks(runId).find((t) => t.id === id);
      if (!queued) return;
      const current = ctx.store.tasks(runId).find((t) => t.id === task.id);
      if (current) {
        current.autoReview = id;
        ctx.store.saveTask(current);
      }
      ctx.log(run, "review", `${task.id}: review queued as ${id} (${reason})`, task.id);
    })
    .catch((error: unknown) =>
      tell(
        `${task.id} should be reviewed (${reason}) but no reviewer task could be created: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}

export async function mergeDependencies(
  ctx: OrchestratorContext,
  run: TeamRun,
  task: TeamTask,
  tasks: TeamTask[],
): Promise<string | null> {
  for (const depId of task.dependsOn) {
    const dep = tasks.find((t) => t.id === depId);
    if (!dep || dep.merged || !WRITING_ROLES.has(dep.role)) continue;
    const result = await ctx.worktrees(run).merge(run.id, dep.id);
    if (!result.ok)
      return `could not merge dependency ${dep.id} into the run branch (conflict)`;
    dep.merged = true;
    ctx.store.saveTask(dep);
    ctx.log(
      run,
      "merge",
      `${dep.id} merged automatically for ${task.id}`,
      dep.id,
    );
  }
  return null;
}

export function acceptRefusal(
  ctx: OrchestratorContext,
  task: TeamTask,
): string | null {
  if (task.state !== "failed") return "it is not a failed task";
  if (!WRITING_ROLES.has(task.role)) return "it made no file changes";
  if (!task.check) return "Cobble ran no check on its changes";
  if (!task.check.passed) return "Cobble's check failed on its changes";
  if (task.drift?.alert) return "its changes raised a plan-drift alert";
  return null;
}

export function acceptTask(
  ctx: OrchestratorContext,
  run: TeamRun,
  task: TeamTask,
  why: string,
) {
  const reported = task.error;
  task.state = "done";
  task.accepted = true;
  task.error = undefined;
  ctx.store.saveTask(task);
  ctx.store.addDecision(run.id, {
    question: `${task.id}: the worker reported failure${reported ? ` (${reported.slice(0, 300)})` : ""}, but Cobble's check passed. Accept it?`,
    choice: "Accept",
    why: why.slice(0, 1_000),
  });
  ctx.log(run, "task", `${task.id} accepted: Cobble's check passed`, task.id);
}

export async function usableBackup(
  ctx: OrchestratorContext,
  teamId: string,
  role: TeamRole,
  current: TeamAgentId,
  member?: string,
): Promise<TeamAgentId | null> {
  if (role === "debugger") return null;
  const backup =
    (member ? ctx.store.member(teamId, member)?.backup : undefined) ??
    ctx.store.backupAgents(teamId)[role];
  if (!backup || backup === current) return null;
  try {
    return (await ctx.adapters[backup].detect()).installed ? backup : null;
  } catch {
    return null;
  }
}

export async function recordUsageTurn(
  ctx: OrchestratorContext,
  run: TeamRun,
  agent: TeamAgentId,
  result: AdapterResult,
  role: TeamRole,
  member?: string,
) {
  const status = ctx.limits.recordTurn(agent, {
    ...result,
    retryAfterMinutes: run.retryAfterMinutes,
  });
  if (!status.stopped || !ctx.limits.claimStopNotice(agent)) return;
  const backup = await usableBackup(ctx, run.teamId, role, agent, member);
  const ending =
    backup && !ctx.limits.status(backup).stopped
      ? `new work goes to backup ${backup}`
      : `new turns wait until ${status.resetsAt ?? "the limit resets"}`;
  const message = `${agent} reached ${status.percent}% of its ${(status.windowMinutes ?? 300) / 60}h limit (${status.source}); ${ending}`;
  ctx.log(run, "limits", message);
  ctx.emit("attention", { runId: run.id, kind: "info", message });
}
