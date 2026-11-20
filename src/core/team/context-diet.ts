import { USER_NOTE, TEAMMATE_NOTE } from "./orchestrator-context";
import type { TeamTask } from "./types";

export const CONTEXT_LIMITS = Object.freeze({
  noteEach: 1_500,
  chatMessages: 12,
  chatMessageChars: 600,
  chatChars: 5_000,
  stateRows: 40,
  goalLine: 200,
});

const clip = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, Math.max(0, limit - 1))}…`.slice(0, limit);

export function compactStateTable(tasks: readonly TeamTask[]): string {
  const terminal = new Set(["done", "failed", "cancelled"]);
  const rows =
    tasks.length <= CONTEXT_LIMITS.stateRows
      ? [...tasks]
      : tasks
          .map((task, index) => ({ task, index }))
          .sort(
            (a, b) =>
              Number(terminal.has(a.task.state)) -
                Number(terminal.has(b.task.state)) ||
              b.task.createdAt.localeCompare(a.task.createdAt) ||
              b.index - a.index,
          )
          .slice(0, CONTEXT_LIMITS.stateRows)
          .map(({ task }) => task);
  const lines = rows.map((t) => {
    const flags = [
      t.merged ? "merged" : "",
      t.drift?.alert ? "⚠ plan drift" : "",
      t.check ? (t.check.passed ? "check passed" : "✗ check failed") : "",
      t.report?.verdict ? `verdict: ${t.report.verdict}` : "",
    ].filter(Boolean);
    return `- ${t.id} [${t.state}] ${t.role}/${t.agent}: ${clip(t.title, 60)}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  if (tasks.length > rows.length)
    lines.push(`(+${tasks.length - rows.length} older tasks omitted)`);
  return lines.join("\n") || "(none yet)";
}

export function capHistory(
  items: readonly string[],
  opts: { maxItems: number; maxChars: number; eachChars: number },
): string {
  if (!items.length) return "";
  const kept = (opts.maxItems > 0 ? items.slice(-opts.maxItems) : []).map(
    (item) => clip(item, opts.eachChars),
  );
  const render = () => {
    const dropped = items.length - kept.length;
    return [
      ...(dropped ? [`(${dropped} earlier items omitted)`] : []),
      ...kept,
    ].join("\n");
  };
  while (
    kept.length &&
    (kept.length > opts.maxItems || render().length > opts.maxChars)
  )
    kept.shift();
  return render();
}

export function wakeNotes(notes: readonly string[]): string {
  const whole = [
    USER_NOTE,
    TEAMMATE_NOTE,
    "The user answered",
    "The user skipped",
    "The user wrote to",
  ];
  return notes
    .map((note) =>
      whole.some((prefix) => note.startsWith(prefix))
        ? note
        : clip(note, CONTEXT_LIMITS.noteEach),
    )
    .join("\n");
}
