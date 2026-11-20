import type { AgentAdapter } from "./adapters";
import type { SessionBrief, TeamRole } from "./types";
import { sessionBriefText } from "./session-brief";
import { normaliseRoadmapItem, roadmapWhat } from "./roadmap";
import { NOTIFY_LIMITS } from "./notify";
import type { HelperRunner } from "./helpers";
import { wordNextUp } from "./helper-presentations";

export const PILOT_MAX_CYCLES = 20;
export const PILOT_MAX_ITEMS = 4;
export interface PilotItem {
  item: string;
  role: TeamRole;
  minutes: number;
  label: string;
  existing: boolean;
}
export interface PilotReply {
  done: boolean;
  items: PilotItem[];
  rejected: { line: string; reason: string }[];
}
export function pilotEndTime(brief: SessionBrief | null): number | undefined {
  if (!brief) return undefined;
  if (brief.endDate) {
    const [y, m, d] = brief.endDate.split("-").map(Number);
    const end = new Date(y, m - 1, d + 1).getTime();
    return Number.isFinite(end) ? end : undefined;
  }
  if (brief.days !== undefined) {
    const end = Date.parse(brief.updatedAt) + brief.days * 86_400_000;
    return Number.isFinite(end) ? end : undefined;
  }
  return undefined;
}
export function pilotPrompt(input: {
  planText: string;
  briefText: string;
  finished: string[];
  flagged: string[];
  open: string[];
  digest: string;
  questions: string[];
  minutesLeft: number;
  spendLeftUsd?: number;
  roles: TeamRole[];
}): string {
  const clip = (s: string) => s.slice(0, 6000);
  return `Choose the next work in ONE read-only turn. No tools, edits or network.
Choose 1-4 items in dependency order from plan and session brief priority.
Copy existing open item text exactly when choosing it. Skip work that does not fit the time left.
Give each item a role from ${input.roles.join(", ")}, rough integer minutes and a 2-6 word label like "UI: settings page".
New item format: "- [ ] <what> — done when: test ... in a file named test/<name>.test.ts".
Return done:true when nothing useful is left.
Minutes left: ${input.minutesLeft}; spend left USD: ${input.spendLeftUsd ?? "unspecified"}.
Plan:\n${clip(input.planText)}
Session brief:\n${clip(input.briefText)}
Finished:\n${clip(input.finished.join("\n"))}
Flagged:\n${clip(input.flagged.join("\n"))}
Open:\n${clip(input.open.join("\n"))}
Digest:\n${clip(input.digest)}
Open questions:\n${clip(input.questions.join("\n"))}
End your reply with a \`\`\`cobble-pilot block containing JSON:
{"done":false,"items":[{"item":"...","role":"coder","minutes":60,"label":"UI: settings page"}]}
\`\`\``;
}
export function pilotLabel(
  label: unknown,
  role: TeamRole,
  item: string,
): string {
  const clean = (s: string) =>
    s
      .replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, "")
      .replace(/[\x00-\x1f\x7f-\x9f\u2022*]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  let words = clean(typeof label === "string" ? label : "")
    .split(" ")
    .filter(Boolean);
  const prefix = role[0].toUpperCase() + role.slice(1) + ":";
  if (!words.length)
    words = [prefix, ...clean(roadmapWhat(item)).split(" ").filter(Boolean)];
  if (!words.length || (words.length === 1 && words[0] === prefix))
    words = [prefix, "work"];
  else if (words.length < 2) words.unshift(prefix);
  // Bound individual words too, so truncation never removes the second word.
  return words
    .slice(0, 6)
    .map((w) => w.slice(0, 25))
    .join(" ")
    .slice(0, 60)
    .trim();
}
export function nextUpMessage(items: Pick<PilotItem, "label">[]): string {
  return (
    "Next up:" +
    items
      .slice(0, 5)
      .map((i) => `\n• ${i.label}`)
      .join("")
  ).slice(0, NOTIFY_LIMITS.body);
}
export function parsePilotReply(
  text: string,
  opts: {
    open: string[];
    closed: string[];
    minutesLeft: number;
    roles: TeamRole[];
  },
): PilotReply {
  const reply: PilotReply = { done: false, items: [], rejected: [] };
  const opener = "```cobble-pilot";
  let data: { done?: unknown; items?: unknown };
  try {
    const at = text.lastIndexOf(opener);
    if (at < 0) throw new Error();
    data = JSON.parse(text.slice(at + opener.length).split("```")[0]);
    if (!data || typeof data !== "object") throw new Error();
  } catch {
    reply.rejected.push({ line: text.slice(0, 300), reason: "invalid JSON" });
    return reply;
  }
  reply.done = data.done === true;
  const seen = new Set<string>();
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    if (reply.items.length >= PILOT_MAX_ITEMS) break;
    const value = raw && typeof raw === "object" ? raw : {};
    const line = typeof value.item === "string" ? value.item : "";
    const reject = (reason: string) =>
      reply.rejected.push({ line: line.slice(0, 300), reason });
    if (!opts.roles.includes(value.role)) {
      reject("unknown role");
      continue;
    }
    if (
      !Number.isInteger(value.minutes) ||
      value.minutes < 1 ||
      value.minutes > 10080
    ) {
      reject("invalid time estimate");
      continue;
    }
    if (value.minutes > opts.minutesLeft) {
      reject("does not fit the time left");
      continue;
    }
    const key = roadmapWhat(line);
    const open = opts.open.find((item) => roadmapWhat(item) === key);
    let item: string;
    if (open !== undefined) item = open;
    else {
      if (opts.closed.some((item) => roadmapWhat(item) === key)) {
        reject("already in the backlog");
        continue;
      }
      const result = normaliseRoadmapItem(line);
      if (!result || "reason" in result) {
        reject(result?.reason ?? 'missing "done when"');
        continue;
      }
      item = result.item.replace(/^- \[ \] /, "");
    }
    if (seen.has(key)) continue;
    seen.add(key);
    reply.items.push({
      item,
      role: value.role,
      minutes: value.minutes,
      label: pilotLabel(value.label, value.role, item),
      existing: open !== undefined,
    });
  }
  return reply;
}
export function backlogSummary(content: string): {
  open: string[];
  finished: string[];
  flagged: string[];
} {
  const result = {
    open: [] as string[],
    finished: [] as string[],
    flagged: [] as string[],
  };
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*] \[([ xX!])\] (.+)$/);
    if (match)
      result[
        match[1] === " " ? "open" : match[1] === "!" ? "flagged" : "finished"
      ].push(match[2].trim());
  }
  return result;
}
export type PilotStopReason =
  | "end_time"
  | "spend_limit"
  | "nothing_left"
  | "stopped"
  | "needs_human"
  | "flagged"
  | "max_cycles"
  | "error";
export function pilotDigestKind(
  reason: PilotStopReason,
): "finished" | "paused" | "needs_you" {
  return reason === "stopped" || reason === "error"
    ? "paused"
    : reason === "needs_human" || reason === "flagged"
      ? "needs_you"
      : "finished";
}
export interface PilotDeps {
  now(): number;
  brief(): SessionBrief | null;
  planner(): AgentAdapter | null;
  cwd: string;
  roles: TeamRole[];
  context(): Promise<{ planText: string; digest: string; questions: string[] }>;
  readBacklog(): Promise<string>;
  addItems(goal: string, items: string[]): Promise<unknown>;
  runItems(
    texts: string[],
    shouldStop: () => boolean,
  ): Promise<{
    stoppedReason:
      "empty" | "max_runs" | "not_done" | "flagged_twice" | "stopped";
  }>;
  promote?(): Promise<void>;
  notify(message: string): Promise<void>;
  sendDigest(reason: PilotStopReason, startedAt: number): Promise<void>;
  spentUsd(): number;
  shouldStop(): boolean;
  onCycle?(e: { cycle: number; items: PilotItem[] }): void;
  /** Waits between retries (tests pass a fake). */
  sleep?(ms: number): Promise<void>;
  /** The optional small local helper model; wording only. */
  helper?: HelperRunner;
}

/** A planner that hits a usage limit or fails is retried this often before Pilot gives up. */
export const PILOT_PLANNER_RETRIES = 12;
/** How long Pilot waits before asking the planner again. */
export const PILOT_RETRY_MS = 15 * 60_000;
/** How long Pilot waits after a planner reply with no usable work. */
export const PILOT_INVALID_RETRY_MS = 60_000;
/** Rounds in a row that end with flagged items before Pilot asks for help. */
export const PILOT_FLAGGED_ROUNDS = 3;
export async function runPilot(deps: PilotDeps): Promise<{
  cycles: number;
  stoppedReason: PilotStopReason;
  items: PilotItem[][];
}> {
  const startedAt = deps.now();
  let reason: PilotStopReason = "error";
  let cycles = 0;
  let plannerSpend = 0;
  let plannerFailures = 0;
  let flaggedRounds = 0;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const items: PilotItem[][] = [];
  try {
    const brief = deps.brief();
    const end = pilotEndTime(brief);
    if (!brief || end === undefined)
      throw new Error(
        "Save a session brief with the time available first (cobble team brief)",
      );
    const planner = deps.planner();
    if (!planner) throw new Error("Assign a planner first");
    for (;;) {
      if (deps.shouldStop()) {
        reason = "stopped";
        break;
      }
      if (deps.now() >= end) {
        reason = "end_time";
        break;
      }
      const spent = deps.spentUsd() + plannerSpend;
      if (
        brief.apiSpendLimitUsd !== undefined &&
        brief.apiSpendLimitUsd - spent < 0.01
      ) {
        reason = "spend_limit";
        break;
      }
      if (cycles >= PILOT_MAX_CYCLES) {
        reason = "max_cycles";
        break;
      }
      const summary = backlogSummary(await deps.readBacklog());
      const context = await deps.context();
      const result = await planner.run({
        cwd: deps.cwd,
        readOnly: true,
        network: false,
        timeoutMs: 600000,
        prompt: pilotPrompt({
          ...context,
          ...summary,
          briefText: sessionBriefText(brief),
          minutesLeft: Math.max(0, Math.floor((end - deps.now()) / 60000)),
          roles: deps.roles,
          spendLeftUsd:
            brief.apiSpendLimitUsd === undefined
              ? undefined
              : brief.apiSpendLimitUsd - spent,
        }),
      });
      plannerSpend += result.usage?.costUsd ?? 0;
      if (deps.shouldStop()) {
        reason = "stopped";
        break;
      }
      if (
        brief.apiSpendLimitUsd !== undefined &&
        brief.apiSpendLimitUsd - deps.spentUsd() - plannerSpend < 0.01
      ) {
        reason = "spend_limit";
        break;
      }
      if (result.authRequired)
        throw new Error(
          `Planner authentication required: ${result.authRequired.hint}`,
        );
      // A usage limit or a failed planner turn is waited out and retried, so
      // Pilot keeps working through the session instead of stopping.
      if (result.rateLimited || result.exitCode !== 0) {
        if (++plannerFailures > PILOT_PLANNER_RETRIES)
          throw new Error(`Planner failed: ${result.finalText.slice(0, 300)}`);
        await deps.notify(
          result.rateLimited
            ? "Planner hit its usage limit; Pilot waits and tries again."
            : "Planner turn failed; Pilot waits and tries again.",
        );
        await sleep(Math.max(0, Math.min(PILOT_RETRY_MS, end - deps.now())));
        continue;
      }
      const reply = parsePilotReply(result.finalText, {
        open: summary.open,
        closed: [...summary.finished, ...summary.flagged],
        minutesLeft: Math.max(0, Math.floor((end - deps.now()) / 60000)),
        roles: deps.roles,
      });
      // The session ends when the planner says it is done, or when all it can
      // still propose is finished work or work that does not fit the time
      // left. A reply with no usable work (an error text, a limit notice,
      // broken JSON, malformed items) is a failed turn: wait and ask again.
      const settled =
        reply.rejected.length > 0 &&
        reply.rejected.every(
          (r) =>
            r.reason === "already in the backlog" ||
            r.reason === "does not fit the time left",
        );
      if (reply.done || (!reply.items.length && settled)) {
        reason = "nothing_left";
        break;
      }
      if (!reply.items.length) {
        if (++plannerFailures > PILOT_PLANNER_RETRIES)
          throw new Error(
            `Planner gave no usable work: ${result.finalText.slice(0, 300)}`,
          );
        await deps.notify("Planner reply had no usable work; Pilot asks again.");
        await sleep(Math.max(0, Math.min(PILOT_INVALID_RETRY_MS, end - deps.now())));
        continue;
      }
      plannerFailures = 0;
      const fresh = reply.items.filter((item) => !item.existing);
      if (fresh.length)
        await deps.addItems(
          `pilot cycle ${cycles + 1}`,
          fresh.map((item) => `- [ ] ${item.item}`),
        );
      cycles++;
      items.push(reply.items);
      deps.onCycle?.({ cycle: cycles, items: reply.items });
      // The optional local helper may reword the phone labels; the work
      // items themselves never change.
      const labels = deps.helper
        ? await wordNextUp(
            deps.helper,
            reply.items.slice(0, 5).map((i) => i.label),
          )
        : reply.items.map((i) => i.label);
      await deps.notify(nextUpMessage(labels.map((label) => ({ label }))));
      const run = await deps.runItems(
        reply.items.map((item) => item.item),
        () => deps.shouldStop() || deps.now() >= end,
      );
      if (!deps.shouldStop()) {
        try {
          await deps.promote?.();
        } catch (error) {
          await deps.notify(
            `Promotion failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (run.stoppedReason === "not_done") {
        reason = "needs_human";
        break;
      }
      // Flagged items stay marked in the backlog; the planner sees them and
      // picks other work next round. Only repeated bad rounds need the user.
      if (run.stoppedReason === "flagged_twice") {
        if (++flaggedRounds >= PILOT_FLAGGED_ROUNDS) {
          reason = "flagged";
          break;
        }
      } else flaggedRounds = 0;
      if (run.stoppedReason === "stopped") {
        reason = "stopped";
        break;
      }
    }
    return { cycles, stoppedReason: reason, items };
  } catch (error) {
    reason = "error";
    throw error;
  } finally {
    await deps.sendDigest(reason, startedAt);
  }
}
