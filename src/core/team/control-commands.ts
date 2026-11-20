import { formatCostParts, type AgentCostPart } from "../../shared/cost-label";

export type ControlCommand =
  | { kind: "status"; details?: boolean }
  | { kind: "limits" }
  | { kind: "add"; idea: string }
  | { kind: "retry"; target: string }
  | { kind: "review-later"; runId: string }
  | { kind: "needs-you" }
  | { kind: "logs"; runId: string }
  | { kind: "queue" }
  | { kind: "help" }
  | { kind: "stop" }
  | { kind: "continue" }
  | { kind: "autopilot"; parallel: number }
  | { kind: "pilot"; until: string }
  | { kind: "promote" }
  | { kind: "invalid"; command: string; reason: string };

export function parseControlCommand(text: string): ControlCommand | null {
  const raw = text.trim();
  const argument = /^(add|retry|review[ -]later|logs)(?:\s+([\s\S]*))?$/i.exec(
    raw,
  );
  if (argument) {
    const verb = argument[1].toLowerCase().replace(" ", "-");
    const value = (argument[2] ?? "").trim();
    if (verb === "logs" && !value) return { kind: "logs", runId: "" };
    if (!value || (verb !== "add" && !/^[\w./:-]+$/.test(value)))
      return {
        kind: "invalid",
        command: raw,
        reason: `Use ${verb} with ${verb === "add" ? "a feature idea" : "one run or task identifier"}.`,
      };
    if (verb === "add") return { kind: "add", idea: value };
    if (verb === "retry") return { kind: "retry", target: value };
    if (verb === "logs") return { kind: "logs", runId: value };
    return { kind: "review-later", runId: value };
  }
  if (
    /^(what needs me|what needs me\?|needs-you|needs me|what's waiting|what is waiting)$/i.test(
      raw,
    )
  )
    return { kind: "needs-you" };
  if (text.length > 80) return null;
  let command = text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .trim();
  if (command === "?") return { kind: "help" };
  const strip = (s: string) =>
    s.replace(/^[\s.,!?;:"'()]+|[\s.,!?;:"'()]+$/g, "").trim();
  command = strip(command).replace(/\s+/g, " ");
  // Remove only surrounding courtesy phrases; never discard unknown words.
  let previous: string;
  do {
    previous = command;
    command = strip(
      command.replace(/^(?:please\b|hey cobble\b|cobble\b)[,\s]*/, ""),
    ).replace(/\s+(?:please|now)$/, "");
  } while (command !== previous);
  const status =
    /^(?:(full|detailed) )?(status|state|progress|what's the status|how are we doing)(?: (details|in detail|full))?$/.exec(
      command,
    );
  if (status) return { kind: "status", details: !!(status[1] || status[3]) };
  if (/^details$/.test(command)) return { kind: "status", details: true };
  // "Which agents are at their limit?", "usage", "limits": answered from
  // Cobble's usage data at once.
  const aboutLimits = command
    .replace(/^(?:hey|hi|hello|ok|okay)\b[,!]?\s*/, "")
    .replace(/^@?planner\b[,:]?\s*/, "");
  if (
    /^(?:limits?|usage|usage limits?|ai usage|show (?:usage|limits))$/.test(aboutLimits) ||
    (/\b(?:limits?|usage|quota)\b/.test(aboutLimits) &&
      /^(?:which|who|what|how|are|is|show|check|tell me|any)\b/.test(aboutLimits))
  )
    return { kind: "limits" };
  // "What is Codex working on?", "@planner what are the agents doing",
  // "planner codex is working on what": answered from stored data at once,
  // so a status question never waits for a busy or rate-limited planner.
  const asked = command
    .replace(/^(?:hey|hi|hello|ok|okay)\b[,!]?\s*/, "")
    .replace(/^@?planner\b[,:]?\s*/, "")
    .replace(/^(?:can you |could you )?(?:tell|show) me\s*/, "");
  if (
    /^(?:what(?:'s| is| are)? )?(?:(?:the )?(?:codex|claude|gemini|planner|agents?|team|coders?|you|they|everyone)\b ?)*(?:is |are )?(?:doing|working on)(?: what| right now| right| now)?$/.test(
      asked,
    ) ||
    /^what(?:'s| is) (?:happening|going on)(?: right now| now)?$/.test(asked) ||
    /^who(?:'s| is) working(?: right now| now)?$/.test(asked)
  )
    return { kind: "status", details: false };
  if (/^(queue|backlog|what's next|show queue)$/.test(command))
    return { kind: "queue" };
  if (/^(help|commands)$/.test(command)) return { kind: "help" };
  if (/^(stop|pause|halt)( (all|everything|autopilot|pilot))?$/.test(command))
    return { kind: "stop" };
  if (/^(continue|resume|unpause|carry on)$/.test(command))
    return { kind: "continue" };
  if (/^(promote|self-check|merge)$/.test(command)) return { kind: "promote" };
  const autopilot =
    /^(?:start autopilot|run autopilot|autopilot start)(?: (?:([-+]?\d+(?:\.\d+)?) at a time|x([-+]?\d+(?:\.\d+)?)|with ([-+]?\d+(?:\.\d+)?)|([-+]?\d+(?:\.\d+)?)))?$/.exec(
      command,
    );
  if (autopilot) {
    const parallel = Number(
      autopilot[1] ?? autopilot[2] ?? autopilot[3] ?? autopilot[4] ?? 1,
    );
    return Number.isInteger(parallel) && parallel >= 1 && parallel <= 4
      ? { kind: "autopilot", parallel }
      : {
          kind: "invalid",
          command,
          reason: "Autopilot accepts 1 to 4 items at a time.",
        };
  }
  const pilot = /^(?:start )?pilot (?:until|till) (\d{4}-\d{2}-\d{2})$/.exec(
    command,
  );
  if (pilot) {
    const until = pilot[1];
    const date = new Date(`${until}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === until
      ? { kind: "pilot", until }
      : {
          kind: "invalid",
          command,
          reason: "Use a valid pilot date in YYYY-MM-DD format.",
        };
  }
  return null;
}

export function needsConfirmation(command: ControlCommand): boolean {
  return ["stop", "continue", "autopilot", "pilot", "promote"].includes(
    command.kind,
  );
}

export function describeControlCommand(command: ControlCommand): string {
  switch (command.kind) {
    case "add":
      return `Plan: ${command.idea}`;
    case "retry":
      return `Retry ${command.target}`;
    case "review-later":
      return `Review later: ${command.runId}`;
    case "logs":
      return `Recent events: ${command.runId}`;
    case "needs-you":
      return "What needs you";
    case "status":
      return "Show status";
    case "limits":
      return "Show usage limits";
    case "queue":
      return "Show backlog";
    case "help":
      return "Show commands";
    case "stop":
      return "Stop Autopilot and Pilot and pause running runs?";
    case "continue":
      return "Continue the stopped session?";
    case "autopilot":
      return `Start Autopilot, ${command.parallel} items at a time?`;
    case "pilot":
      return `Start Pilot until ${command.until}? This resets the session spend window.`;
    case "promote":
      return "Run the self-check promotion?";
    case "invalid":
      return command.reason;
  }
}

export const CONTROL_HELP = `Commands:
status \u2014 what is happening, in a few plain lines
status details \u2014 every run, task, merge and token count
limits \u2014 which AI agents are near or at their usage limit
queue \u2014 show the open backlog
stop \u2014 stop Autopilot/Pilot and pause runs (confirmation required)
continue \u2014 restore the stopped session (confirmation required)
start autopilot [N|N at a time|xN|with N] \u2014 N is 1-4 (confirmation required)
pilot until YYYY-MM-DD \u2014 reset the session spend window (confirmation required)
promote / self-check / merge \u2014 run promotion (confirmation required)
add <idea> / retry <target> / review later <run> / logs [run] / what needs me
help \u2014 show commands
Gate approvals, deployment and sign-in cannot be authorised through chat commands.`;

export interface ControlStatusInput {
  runs: {
    id: string;
    state: string;
    goal: string;
    gate?: { message: string } | null;
    pausedReason?: string;
    /** Set while the run waits for a usage limit; it resumes on its own. */
    retryAt?: string;
    tasks: {
      id: string;
      title: string;
      state: string;
      agent?: string;
      gate?: { message: string } | null;
    }[];
  }[];
  autopilot: {
    active: boolean;
    pilot?: boolean;
    parallel?: number;
    stoppedReason?: string;
    currentItem?: string;
  };
  daemon: { running: boolean; pid: number | null };
  queue: string[];
  lastMerges: string[];
  usage?: {
    tokens?: number;
    costUsd?: number;
    costParts?: AgentCostPart[];
  } | null;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
/** A backlog item or run goal as a short label: its name (text before the first ":" or " — ") capped at 90 characters. */
export const shortLabel = (text: string, max = 90): string => {
  const flat = oneLine(text).replace(/^Backlog item:\s*/i, "");
  const cut = flat.search(/:\s| — /);
  const name = cut > 0 && cut <= max ? flat.slice(0, cut) : flat;
  return name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name;
};

const LIMIT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "Free model",
  teammate: "Teammate",
};

/**
 * A plain answer to "which agents are at their limit?": one line per agent
 * the team uses (or that has usage), stopped ones first.
 */
export function controlLimitsText(
  view: {
    stopAt: number;
    agents: {
      agent: string;
      percent: number | null;
      source: "reported" | "estimated";
      windowHours: number | null;
      resetsAt: string | null;
      stopped: boolean;
    }[];
  },
  usedAgents: string[],
  now: number = Date.now(),
): string {
  const time = (iso: string | null) => {
    const at = iso ? new Date(iso) : null;
    return at && Number.isFinite(at.getTime()) && at.getTime() > now
      ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
  };
  const rows = view.agents
    .filter((a) => usedAgents.includes(a.agent) || (a.percent ?? 0) > 0)
    .sort((a, b) => Number(b.stopped) - Number(a.stopped));
  if (!rows.length) return "No usage recorded for your agents yet.";
  const lines = rows.map((a) => {
    const name = LIMIT_NAMES[a.agent] ?? a.agent;
    const window = a.windowHours ? ` of its ${a.windowHours}-hour limit` : "";
    const pct =
      a.percent === null
        ? "no limit data yet"
        : `${Math.round(a.percent)}%${window}${a.source === "estimated" ? " (estimated)" : ""}`;
    const until = time(a.resetsAt);
    return a.stopped
      ? `${name}: at its limit, ${pct}. New work waits${until ? ` until ${until}` : " for the reset"}.`
      : `${name}: ${pct}${until && (a.percent ?? 0) > 0 ? `, resets at ${until}` : ""}.`;
  });
  const stopped = rows.filter((a) => a.stopped).length;
  return [
    stopped
      ? `${stopped === 1 ? "1 agent is" : `${stopped} agents are`} at the limit (Cobble stops new work at ${view.stopAt}%).`
      : `No agent is at its limit (Cobble stops new work at ${view.stopAt}%).`,
    ...lines,
  ].join("\n");
}

export function controlQueueText(items: string[]): string {
  return items.length
    ? items
        .slice(0, 15)
        .map((item, index) => `${index + 1}. ${shortLabel(item)}`)
        .join("\n")
    : "The backlog has no open items.";
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "the free model",
  teammate: "a teammate's agent",
};
const ENDED_RUN = ["done", "failed", "stopped"];
const short = (text: string, max = 70) => {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}\u2026` : flat;
};

/**
 * `status` for people: at most five short lines in plain English (what is
 * being worked on, what waits for you, automation, what is next, problems).
 * No ids or token counts; `status details` keeps the full report.
 */
export function controlStatusPlain(input: ControlStatusInput): string {
  const live = input.runs.filter((run) => !ENDED_RUN.includes(run.state));
  const working = live.flatMap((run) =>
    run.tasks
      .filter((task) => task.state === "running")
      .map(
        (task) =>
          `${AGENT_NAMES[task.agent ?? ""] ?? "An agent"} is working on \u201c${short(task.title, 60)}\u201d`,
      ),
  );
  const lines: string[] = [];
  lines.push(
    working.length
      ? `Working: ${working.slice(0, 2).join("; ")}${working.length > 2 ? ` and ${working.length - 2} more` : ""}.`
      : live.some((run) => run.state === "running")
        ? "Working: the planner is deciding the next step."
        : "Working: nothing right now.",
  );
  const waits = [
    ...live.filter((run) => run.gate?.message).map((run) => run.gate!.message),
    ...live.flatMap((run) =>
      run.tasks
        .filter((task) => task.state === "needs_human" && task.gate?.message)
        .map((task) => task.gate!.message),
    ),
  ];
  lines.push(
    waits.length
      ? `Waiting for you: ${short(waits[0]!, 90)}${waits.length > 1 ? ` (and ${waits.length - 1} more)` : ""}`
      : "Waiting for you: nothing.",
  );
  const a = input.autopilot;
  lines.push(
    a.pilot
      ? "Automation: Pilot is on and picks its own next work."
      : a.active
        ? `Automation: Autopilot is on, ${a.parallel ?? 1} ${(a.parallel ?? 1) === 1 ? "item" : "items"} at a time.`
        : "Automation: off. Say \u201cstart autopilot\u201d to work through the backlog.",
  );
  lines.push(
    input.queue.length
      ? `Next: ${shortLabel(input.queue[0]!, 70)}${input.queue.length > 1 ? ` (${input.queue.length} items waiting)` : ""}.`
      : "Next: the backlog is empty.",
  );
  const problems: string[] = [];
  const paused = live.filter((run) => run.state === "paused" && !run.retryAt);
  if (paused.length)
    problems.push(
      `${paused.length === 1 ? "1 run is" : `${paused.length} runs are`} paused (say \u201ccontinue\u201d)`,
    );
  const waiting = live.filter((run) => run.state === "paused" && run.retryAt);
  if (waiting.length) {
    const next = waiting
      .map((run) => new Date(run.retryAt!))
      .filter((at) => Number.isFinite(at.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    problems.push(
      `${waiting.length === 1 ? "1 run waits" : `${waiting.length} runs wait`} for a usage limit${next ? ` until ${next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""} and ${waiting.length === 1 ? "resumes on its own" : "resume on their own"}`,
    );
  }
  if (live.some((run) => run.state === "running") && !input.daemon.running && !a.active)
    problems.push("nothing is driving the running work (say \u201ccontinue\u201d)");
  const failed = input.runs.filter((run) => run.state === "failed").length;
  if (failed && !live.length)
    problems.push(`the last run failed (say \u201cstatus details\u201d)`);
  lines.push(problems.length ? `Problems: ${problems.join("; ")}.` : "Problems: none.");
  return lines.join("\n");
}

export function controlStatusText(input: ControlStatusInput): string {
  const a = input.autopilot;
  const lines = [
    `Autopilot: ${a.active ? "active" : "inactive"}; Pilot: ${a.pilot ? "active" : "inactive"}; parallel: ${a.parallel ?? 1}${a.stoppedReason ? `; ${oneLine(a.stoppedReason)}` : ""}${a.currentItem ? `; item: ${shortLabel(a.currentItem)}` : ""}`,
    `Daemon: ${input.daemon.running ? "running" : "stopped"}; pid: ${input.daemon.pid ?? "unknown"}`,
    `Backlog: ${input.queue.length} open items${
      input.queue.length
        ? `; next: ${input.queue
            .slice(0, 3)
            .map((item) => shortLabel(item))
            .join("; ")}`
        : ""
    }`,
    `Last merges: ${input.lastMerges.length ? input.lastMerges.slice(0, 3).map(oneLine).join("; ") : "none"}`,
    `Usage: tokens ${input.usage?.tokens ?? "unknown"}; ${formatCostParts(input.usage?.costParts ?? (input.usage?.costUsd === undefined ? [] : [{ loginType: "unknown", valueUsd: input.usage.costUsd }]))}`,
  ];
  if (!input.runs.length) lines.push("Runs: none");
  for (const run of input.runs) {
    if (lines.length >= 15) break;
    lines.push(
      `Run ${oneLine(run.id)}: ${oneLine(run.state)} \u2014 ${shortLabel(run.goal)}`,
    );
    for (const task of run.tasks) {
      if (lines.length >= 15) break;
      lines.push(
        `  ${oneLine(task.id)}: ${oneLine(task.state)} \u2014 ${oneLine(task.title)}`,
      );
    }
  }
  return lines.join("\n");
}
