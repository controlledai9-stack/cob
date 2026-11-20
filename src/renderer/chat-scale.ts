import type { ChatParticipant } from "./components/ui/agent-chat";

/** Messages shown at once; "Show earlier" adds another page. */
export const CHAT_PAGE = 200;
/** People lists longer than this get a search box. */
export const PEOPLE_SEARCH_AT = 12;
/** A burst of team updates within this window causes one chat refresh. */
export const CHAT_REFRESH_MS = 150;

/** The latest `limit` messages, and how many older ones are hidden. */
export function pageMessages<T>(
  messages: readonly T[],
  limit: number,
): { visible: T[]; hidden: number } {
  const hidden = Math.max(0, messages.length - limit);
  return { visible: messages.slice(hidden), hidden };
}

const ROLE_ORDER = [
  "planner",
  "coder",
  "generator",
  "reviewer",
  "researcher",
  "debugger",
  "deployer",
];

/**
 * People first, in the order they joined the chat (you first), then Cobble,
 * then agents grouped by role and sorted by name (coder1 before coder2).
 */
export function sortParticipants(list: ChatParticipant[]): ChatParticipant[] {
  const rank = (p: ChatParticipant) =>
    p.id === "you"
      ? 0
      : p.id.startsWith("person:")
        ? 1
        : p.id === "cobble"
          ? 2
          : 3;
  const roleRank = (p: ChatParticipant) => {
    const i = ROLE_ORDER.indexOf(p.role ?? "");
    return i < 0 ? ROLE_ORDER.length : i;
  };
  return list
    .map((p, index) => ({ p, index }))
    .sort((a, b) => {
      const r = rank(a.p) - rank(b.p);
      if (r || rank(a.p) < 3) return r || a.index - b.index;
      return (
        roleRank(a.p) - roleRank(b.p) ||
        a.p.name.localeCompare(b.p.name, undefined, { numeric: true })
      );
    })
    .map(({ p }) => p);
}

/** Case-insensitive match on a person's or agent's name and description. */
export function filterParticipants(
  list: ChatParticipant[],
  query: string,
): ChatParticipant[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) =>
    `${p.name} ${p.detail ?? ""}`.toLowerCase().includes(q),
  );
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs `fn` once after a quiet `delayMs`, however many times `trigger` is
 * called before that, so a burst of agent posts re-renders the chat once.
 */
export function createCoalescer(
  fn: () => void,
  delayMs = CHAT_REFRESH_MS,
  timers: Timers = realTimers,
) {
  let handle: unknown;
  let pending = false;
  return {
    trigger() {
      if (pending) timers.clear(handle);
      pending = true;
      handle = timers.set(() => {
        pending = false;
        fn();
      }, delayMs);
    },
    cancel() {
      if (pending) timers.clear(handle);
      pending = false;
    },
  };
}
