import { shortLabel } from "./control-commands";

/** One backlog line as people read it in the app's Build plan. */
export interface BuildPlanItem {
  label: string;
  note?: string;
}
export interface BuildPlanView {
  running: BuildPlanItem[];
  next: BuildPlanItem[];
  attention: BuildPlanItem[];
  done: BuildPlanItem[];
  claude: BuildPlanItem[];
  /** Where the list came from, e.g. "cobble/autopilot" or "docs/BACKLOG.md". */
  source: string;
}

const LINE = /^\s*- \[([ xX!mMrR])\]\s+(.*)$/;

/** "(merged by Claude) Debug specialist: …" → name "Debug specialist", note "merged by Claude". */
function split(text: string): BuildPlanItem {
  const note = /^\(([^)]{1,120})\)\s*/.exec(text);
  const rest = note ? text.slice(note[0].length) : text;
  const reason = / — needs attention: (.*)$/.exec(rest);
  const body = reason ? rest.slice(0, reason.index) : rest;
  const label = shortLabel(body, 80);
  const why = reason?.[1] ?? note?.[1];
  return why ? { label, note: shortLabel(why, 120) } : { label };
}

/**
 * Groups the backlog for the app: what runs now, what is next, what needs
 * attention, what is done, and what Claude is doing by hand.
 */
export function buildPlanFromBacklog(
  content: string,
  activeGoals: string[],
  source: string,
): BuildPlanView {
  const view: BuildPlanView = {
    running: [],
    next: [],
    attention: [],
    done: [],
    claude: [],
    source,
  };
  const active = activeGoals.map((goal) =>
    shortLabel(goal, 80).toLowerCase(),
  );
  for (const line of content.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match) continue;
    const mark = match[1]!.toLowerCase();
    const item = split(match[2]!.trim());
    if (mark === "x") view.done.push(item);
    else if (mark === "!") view.attention.push(item);
    else if (mark === "m" || mark === "r") view.claude.push(item);
    else if (active.includes(item.label.toLowerCase())) view.running.push(item);
    else view.next.push(item);
  }
  return view;
}
