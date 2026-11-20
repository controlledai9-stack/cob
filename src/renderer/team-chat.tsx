import { Send as SendIcon } from "lucide-react";
import {
  AgentChatShell,
  ChatMessageRow,
  ClampedMessage,
  type ChatParticipant,
} from "./components/ui/agent-chat";
import { TeamNeedsYou } from "./team-needs-you";
import { TeamHealthBanner } from "./team-health-banner";
import type { AppHubSnapshot, AppHubAction } from "../core/team/app-hub";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CHAT_PAGE,
  createCoalescer,
  pageMessages,
  sortParticipants,
} from "./chat-scale";
import type {
  DesktopApi,
  RunSnapshot,
  TeamAgentId,
  TeamChatMessage,
} from "../shared/types";

import {
  describeControlCommand, needsConfirmation,
  parseControlCommand,
} from "../core/team/control-commands";
import { parseStartCommand } from "../core/team/chat-command";
import { MicButton, useVoiceInput } from "./voice-input";

type ChatApi = Required<Pick<DesktopApi, "teamChat" | "sendTeamChat">> &
  Partial<
    Pick<
      DesktopApi,
      | "teamAppHub"
      | "teamAppHubAction"
      | "onTeam"
      | "onChange"
      | "teamProjectChat"
      | "teamControlConfirm"
      | "teamProposalAdd"
      | "teamProposalStartItem"
      | "transcribe"
    >
  >;

export function mergeChatMessages(
  project: TeamChatMessage[],
  run: TeamChatMessage[],
) {
  return [...project, ...run].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
}

export async function loadChatMessages(api: ChatApi, runId?: string) {
  const [project, run] = await Promise.all([
    api.teamProjectChat?.() ?? Promise.resolve([]),
    runId ? api.teamChat(runId) : Promise.resolve([]),
  ]);
  return mergeChatMessages(project, run);
}

export async function sendChatMessage(
  api: ChatApi,
  runId: string | null,
  text: string,
  start: (goal: string) => Promise<void>,
) {
  const goal = !runId ? parseStartCommand(text) : null;
  if (goal) await start(goal);
  else await api.sendTeamChat(runId, text);
}
type GateCommand = (
  command: "done" | "skip" | "approve" | "deny",
  taskId?: string,
  note?: string,
) => void;

const agentNames: Record<TeamAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "Free model",
  teammate: "Teammate",
};

function describeError(error: unknown) {
  return String(error instanceof Error ? error.message : error).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    "",
  );
}

/**
 * The planner's replies to you (not its hand-offs) are Cobble's voice: you
 * talk to one assistant, whichever model answered.
 */
export function isCobbleVoice(message: TeamChatMessage): boolean {
  return (
    message.author === "cobble" ||
    (message.author === "agent" &&
      message.role === "planner" &&
      !message.taskId &&
      (message.kind === "message" || message.kind === "proposal"))
  );
}

export function author(message: TeamChatMessage) {
  if (message.author === "user") return message.memberName ?? "You";
  if (isCobbleVoice(message)) return "Cobble";
  const name =
    message.agentLabel ?? (message.agent ? agentNames[message.agent] : "Agent");
  // A planner hand-off stores the member it hands work to, not the speaker.
  if (message.role === "planner")
    return `${name} · planner${message.member && message.taskId ? ` → ${message.member}` : ""}`;
  return `${message.member ? `${message.member} (${name})` : name} · ${message.role ?? "agent"}${message.taskId ? ` · ${message.taskId}` : ""}`;
}

export function tone(message: TeamChatMessage) {
  if (message.author === "user") return "user";
  if (message.author === "agent") return "agent";
  if (message.kind === "drift") return "warn";
  if (message.kind === "gate") return "gate";
  if (message.kind === "check" && /failed$/.test(message.text)) return "warn";
  return "cobble";
}

const ENDED = ["done", "failed", "stopped"];

/** **bold** and `code` inside one line, as React nodes (never raw HTML). */
function inline(text: string) {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
        <code key={i}>{part.slice(1, -1)}</code>
      ) : (
        part
      ),
    );
}

/**
 * Agents write a little Markdown: paragraphs, "- " bullet lists, **bold**
 * and `code`. Rendered as plain elements; anything else stays text.
 */
export function ChatText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length)
      blocks.push(
        <p key={blocks.length} className="agent-team-text">
          {lines.map((line, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {inline(line)}
            </span>
          ))}
        </p>,
      );
    if (bullets.length)
      blocks.push(
        <ul key={blocks.length} className="agent-team-chat-bullets">
          {bullets.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>,
      );
    lines = [];
    bullets = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const bullet = raw.match(/^\s*[-*] (.*)$/);
    if (bullet) {
      if (lines.length) {
        const keep = bullets;
        bullets = [];
        flush();
        bullets = keep;
      }
      bullets.push(bullet[1]!);
    } else if (!raw.trim()) flush();
    else {
      if (bullets.length) flush();
      lines.push(raw);
    }
  }
  flush();
  return <div className="agent-team-chat-body">{blocks}</div>;
}

/**
 * Team Chat: project conversation and the latest run in one thread. You write to the planner (or
 * "@codex ..." to an agent's task), and the planner, the workers and Cobble's
 * checks post here. Production approvals and sign-ins appear as cards that
 * only you can answer.
 */
export function TeamChat({
  api,
  snapshot,
  pending,
  canStart,
  canChat,
  chatHint,
  startProposal,
  startHint,
  start,
  command,
  onChanged,
  initialMessages = [],
  headerActions,
  initialView = "you",
}: {
  api: ChatApi;
  snapshot: RunSnapshot | null | undefined;
  pending: boolean;
  /** A new run may start (roles, workspace and agents are ready). */
  canStart: boolean;
  canChat: boolean;
  chatHint: string;
  startProposal: (messageId: string, goal: string) => Promise<void>;
  startHint: string;
  /** Starts a new run with this goal (uses the "Start a run" settings). */
  start: (goal: string) => Promise<void>;
  command: GateCommand;
  onChanged: () => void;
  /** Messages to show before the first load (tests, previews). */
  initialMessages?: TeamChatMessage[];
  /** Buttons at the top right of the chat (e.g. the Data panel toggle). */
  headerActions?: React.ReactNode;
  /** Which tab opens first (tests, previews). */
  initialView?: ChatView;
}) {
  const [view, setView] = useState<ChatView>(initialView);
  const run = snapshot?.run;
  const live = !!run && !ENDED.includes(run.state);
  const [messages, setMessages] = useState<TeamChatMessage[]>(initialMessages);
  const [hub, setHub] = useState<AppHubSnapshot>({ needsYou: [], health: [] });
  const [hubBusy, setHubBusy] = useState<string>();
  const [draft, setDraft] = useState("");
  // Spoken words land in the box so you can read them before sending.
  const voice = useVoiceInput(api.transcribe, (text) =>
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text)),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const request = useRef(0);

  // The snapshot changes on every team update; a burst of updates (many
  // agents posting at once) loads the chat once, after a short quiet gap.
  const runId = run?.id;
  const loader = useRef<ReturnType<typeof createCoalescer> | null>(null);
  const load = useRef<() => void>(() => {});
  load.current = () => {
    const id = ++request.current;
    loadChatMessages(api, runId)
      .then((next) => {
        if (id === request.current) setMessages(next);
      })
      .catch((cause) => {
        if (id === request.current) setError(describeError(cause));
      });
  };
  if (!loader.current) loader.current = createCoalescer(() => load.current());
  useEffect(() => {
    loader.current!.trigger();
  }, [api, run, snapshot]);
  useEffect(() => {
    // A different run starts on the newest page, at once.
    setLimit(CHAT_PAGE);
    load.current();
  }, [api, runId]);
  useEffect(
    () => () => {
      loader.current?.cancel();
      ++request.current;
    },
    [],
  );

  useEffect(() => {
    let active = true;
    let version = 0;
    const refresh = () => {
      const current = ++version;
      void api
        .teamAppHub?.()
        .then((next) => {
          if (active && current === version) setHub(next);
        })
        .catch((cause) => {
          if (active) setError(describeError(cause));
        });
    };
    refresh();
    const teamOff = api.onTeam?.(refresh);
    const changeOff = api.onChange?.(refresh);
    return () => {
      active = false;
      teamOff?.();
      changeOff?.();
    };
  }, [api, snapshot]);

  async function hubAction(action: AppHubAction, answer?: string) {
    setHubBusy(action.id);
    try {
      await api.teamAppHubAction?.(action, answer);
    } finally {
      setHubBusy(undefined);
      const [next, chat] = await Promise.all([
        api.teamAppHub?.(),
        loadChatMessages(api, run?.id),
      ]);
      if (next) setHub(next);
      setMessages(chat);
      onChanged();
    }
  }

  const [limit, setLimit] = useState(CHAT_PAGE);
  const restore = useRef<number | null>(null);
  useEffect(() => {
    const el = list.current;
    if (el && restore.current === null) el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  // After "Show earlier", keep the message you were reading where it was.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && restore.current !== null) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
    }
  }, [limit]);

  async function refreshAfterAction(actionRequest: number) {
    if (actionRequest !== request.current) return;
    const id = ++request.current;
    try {
      const next = await loadChatMessages(api, run?.id);
      if (id === request.current) setMessages(next);
    } catch {
      // The action succeeded; a later team update can refresh the thread.
    }
  }

  const explicitStart = !live && parseStartCommand(draft) !== null;
  const blocked =
    !live &&
    !parseControlCommand(draft) &&
    (explicitStart ? !canStart : !canChat);
  const hint = explicitStart ? startHint : chatHint;
  async function send() {
    const text = draft.trim();
    if (!text || pending || sending || blocked) return;
    setSending(true);
    setError("");
    const actionRequest = request.current;
    try {
      await sendChatMessage(api, live ? run!.id : null, text, start);
      await refreshAfterAction(actionRequest);
      setDraft("");
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSending(false);
    }
  }

  async function act(action: () => Promise<unknown>) {
    setSending(true);
    setError("");
    const actionRequest = request.current;
    try {
      await action();
      await refreshAfterAction(actionRequest);
      onChanged();
    } catch (cause) {
      setError(describeError(cause));
      throw cause;
    } finally {
      setSending(false);
    }
  }

  const gate = run?.state === "needs_human" ? run.gate : undefined;
  // Every waiting task gets its card here: pressing Done after signing in,
  // or Approve / Deny, in the app is the human path.
  const taskGates =
    snapshot?.tasks.filter((t) => t.state === "needs_human" && t.gate) ?? [];
  const busy = pending || sending;

  const runningTasks =
    live && snapshot
      ? snapshot.tasks.filter((t) => t.state === "running")
      : [];
  const inView = messages.filter((m) => chatView(m) === view);
  const people = chatParticipants(inView, runningTasks);
  const filtered = selected
    ? inView.filter((m) => participantId(m) === selected)
    : inView;
  const { visible: shown, hidden: earlier } = pageMessages(filtered, limit);
  const needsNow = hub.needsYou.filter((item) => !item.id.startsWith("review:"));
  const awaiting = live && run?.state === "running" ? awaitingPlanner(messages) : false;
  const statusLine = sending ? (
    <span className="ui-working">
      <i className="ui-typing" aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
      {live ? "Sending to the team…" : "The planner is thinking…"}
    </span>
  ) : awaiting ? (
    <span className="ui-working">
      <i className="ui-typing" aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
      The planner has your message and is writing a reply…
    </span>
  ) : runningTasks.length ? (
    <span className="ui-working">
      <i className="ui-typing" aria-hidden="true">
        <b />
        <b />
        <b />
      </i>
      Working:{" "}
      {runningTasks
        .slice(0, 2)
        .map(
          (t) =>
            `${agentNames[t.agent]} on ${t.id}${t.title ? ` (${t.title})` : ""}`,
        )
        .join(", ")}
      {runningTasks.length > 2 && ` and ${runningTasks.length - 2} more`}
    </span>
  ) : run?.state === "paused" ? (
    <span>
      {run.retryAt
        ? `Waiting for a usage limit to reset. It resumes on its own at ${localTime(run.retryAt)}; nothing to do.`
        : `${run.pausedReason ? `Paused: ${readableTimes(run.pausedReason).replace(/\.$/, "")}. ` : "Paused. "}Type continue to resume the run.`}
    </span>
  ) : run?.state === "needs_human" ? (
    <span>Waiting for you (see the card below).</span>
  ) : live ? (
    <span>The planner is deciding the next step…</span>
  ) : (
    <span>Nothing is running. Ask Cobble anything.</span>
  );

  return (
    <AgentChatShell
      className="agent-team-chat"
      headingId="agent-team-chat-heading"
      title="Team Chat"
      subtitle={
        run ? (
          <span title={run.goal}>
            {live ? "Current run" : "Last run"}: {shortGoal(run.goal)}
          </span>
        ) : (
          "You, the planner and the agents"
        )
      }
      actions={headerActions}
      tabs={
        <div className="ui-chat-tabs" role="tablist" aria-label="Chat">
          {(
            [
              ["you", "Your chat"],
              ["team", "Team chat"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              className={view === key ? "ui-tab is-active" : "ui-tab"}
              onClick={() => {
                setView(key);
                setSelected(null);
                setLimit(CHAT_PAGE);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      }
      participants={people}
      selected={selected}
      onSelect={setSelected}
      status={statusLine}
      banner={
        view === "team" ? undefined :
        // Only what needs the user now; "review later" items stay in the
        // `what needs me` answer, and an all-clear needs no box.
        needsNow.length || hub.health.length ? (
          <>
            {needsNow.length > 0 && (
              <TeamNeedsYou
                items={needsNow}
                onAction={hubAction}
                busyActionId={hubBusy}
              />
            )}
            {hub.health.length > 0 && (
              <TeamHealthBanner
                items={hub.health}
                onAction={hubAction}
                busyActionId={hubBusy}
              />
            )}
          </>
        ) : undefined
      }
      footer={
        view === "team" ? (
          <p className="small ui-chat-team-note">
            The agents' own conversation: who hands what to whom, their
            reports and questions. Switch to <strong>Your chat</strong> to
            talk to them.
          </p>
        ) : (
        <>
          <form
            className="agent-team-chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              aria-label="Message Cobble or the team"
              placeholder={
                voice.recording
                  ? "Listening\u2026 press the mic again to stop (up to 60 seconds)"
                  : voice.transcribing
                    ? "Turning your recording into text on this computer\u2026"
                    : live
                      ? "Message Cobble, or @coder1 / @T2 for one agent"
                      : "Message Cobble, or @planner start: <goal>"
              }
              rows={1}
              maxLength={4000}
              value={draft}
              disabled={!live && !canChat}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <MicButton voice={voice} />
            <button
              type="submit"
              className="ui-send"
              aria-label={explicitStart ? "Start run" : "Send"}
              disabled={
                busy || blocked || !draft.trim() || voice.recording || voice.transcribing
              }
            >
              <SendIcon size={18} aria-hidden="true" />
              <span>{explicitStart ? "Start run" : "Send"}</span>
            </button>
          </form>
          {voice.error && (
            <p role="alert" className="error">
              {voice.error}
            </p>
          )}
          {blocked && hint && <p className="small">{hint}</p>}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </>
        )
      }
    >
      <ol className="agent-team-chat-list" ref={list} aria-live="polite">
        {!inView.length && view === "team" && (
          <li className="agent-team-chat-empty">
            Nothing here yet. When a run starts, the planner hands out tasks
            and the agents report back in this tab.
          </li>
        )}
        {!inView.length && view === "you" && (
          <li className="agent-team-chat-empty">
            Ask Cobble about the project or discuss what to build next, by
            typing or with the mic. To
            start a run, write <code>@planner start: your goal</code>. Write{" "}
            <code>@codex …</code> or <code>@T2 …</code> to talk to one agent.
          </li>
        )}
        {earlier > 0 && (
          <li className="ui-chat-earlier">
            <button
              type="button"
              className="ui-link-button"
              onClick={() => {
                const el = list.current;
                restore.current = el ? el.scrollHeight - el.scrollTop : null;
                setLimit((value) => value + CHAT_PAGE);
              }}
            >
              Show earlier ({earlier} more)
            </button>
          </li>
        )}
        {shown.map((message) => (
          <li
            key={message.id}
            className={`agent-team-chat-message is-${tone(message)}`}
          >
            <ChatMessageRow
              name={author(message)}
              tone={tone(message)}
              role={isCobbleVoice(message) ? "cobble" : message.role}
              member={message.role === "planner" ? undefined : message.member}
              to={
                message.to && message.to !== "planner" ? message.to : undefined
              }
              time={new Date(message.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            >
              {message.control ? (
                <ControlCard
                  message={message}
                  busy={busy}
                  confirm={
                    api.teamControlConfirm
                      ? (yes) =>
                          act(() => api.teamControlConfirm!(message.id, yes))
                      : undefined
                  }
                />
              ) : message.kind === "proposal" && message.proposal ? (
                <ProposalCard
                  message={message}
                  busy={busy}
                  add={
                    api.teamProposalAdd
                      ? () => act(() => api.teamProposalAdd!(message.id))
                      : undefined
                  }
                  startItem={
                    api.teamProposalStartItem
                      ? (item) =>
                          act(() =>
                            api.teamProposalStartItem!(message.id, item),
                          )
                      : undefined
                  }
                  canStart={canStart}
                  startHint={startHint}
                  start={async (goal) => {
                    setSending(true);
                    setError("");
                    const actionRequest = request.current;
                    try {
                      await startProposal(message.id, goal);
                      await refreshAfterAction(actionRequest);
                      onChanged();
                    } catch (cause) {
                      setError(describeError(cause));
                    } finally {
                      setSending(false);
                    }
                  }}
                />
              ) : message.author === "agent" ? (
                <ClampedMessage
                  text={message.text}
                  render={(text) => <ChatText text={text} />}
                />
              ) : (
                <ChatText text={message.text} />
              )}
            </ChatMessageRow>
          </li>
        ))}
        {view === "you" && gate && gate.kind !== "questions" && (
          <li className="agent-team-chat-message is-gate">
            <div
              className="agent-team-chat-card"
              role="group"
              aria-label="Run needs you"
            >
              <p className="agent-team-text">
                <strong>Needs you:</strong> {gate.message}
              </p>
              <input
                aria-label="Note for the planner"
                placeholder="Note (optional)"
                value={note}
                maxLength={1000}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="agent-team-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    command(
                      gate.kind === "approval" ? "approve" : "done",
                      undefined,
                      note,
                    )
                  }
                >
                  {gate.kind === "approval" ? "Approve" : "Done"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    command(
                      gate.kind === "approval" ? "deny" : "skip",
                      undefined,
                      note,
                    )
                  }
                >
                  {gate.kind === "approval" ? "Deny" : "Skip"}
                </button>
              </div>
            </div>
          </li>
        )}
        {view === "you" && gate?.kind === "questions" && (
          <li className="agent-team-chat-message is-gate">
            <p className="agent-team-chat-card">
              The planner asked you some questions. Answer them in the{" "}
              <strong>Run needs you</strong> form in the Data panel, or press
              Skip to let the planner decide.
            </p>
          </li>
        )}
        {view === "you" && taskGates.map((task) => (
          <li key={task.id} className="agent-team-chat-message is-gate">
            <div
              className="agent-team-chat-card"
              role="group"
              aria-label={`${task.id} needs you`}
            >
              <p className="agent-team-text">
                <strong>
                  {task.id} ({agentNames[task.agent]}) needs you:
                </strong>{" "}
                {task.gate!.message}
              </p>
              <div className="agent-team-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    command(
                      task.gate!.kind === "approval" ? "approve" : "done",
                      task.id,
                    )
                  }
                >
                  {task.gate!.kind === "approval" ? "Approve" : "Done"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => command("skip", task.id)}
                >
                  {task.gate!.kind === "approval" ? "Deny" : "Skip"}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </AgentChatShell>
  );
}

/** Groups chat messages by who wrote them, for the people list. */
export function participantId(message: TeamChatMessage): string {
  if (message.author === "user")
    return message.memberName ? `person:${message.memberName}` : "you";
  if (isCobbleVoice(message)) return "cobble";
  if (message.role === "planner") return "agent:planner";
  return `agent:${message.member ?? message.role ?? message.agent ?? "agent"}`;
}

export function chatParticipants(
  messages: TeamChatMessage[],
  running: { agent: TeamAgentId; role?: string }[] = [],
): ChatParticipant[] {
  const people = new Map<string, ChatParticipant>();
  for (const message of messages) {
    const id = participantId(message);
    // Agents keep their first place in the list but show their latest role.
    if (people.has(id) && message.author !== "agent") continue;
    if (message.author === "user")
      people.set(id, {
        id,
        name: message.memberName ?? "You",
        detail: message.memberName ? "teammate" : "you",
      });
    else if (isCobbleVoice(message))
      people.set(id, {
        id,
        name: "Cobble",
        detail: "your assistant · speaks for the team",
        role: "cobble",
      });
    else {
      const agent =
        message.agentLabel ??
        (message.agent ? agentNames[message.agent] : "Agent");
      people.set(id, {
        id,
        name:
          message.role === "planner"
            ? "planner"
            : (message.member ?? message.role ?? agent),
        detail: `${message.role ?? "agent"} · ${agent}`,
        role: message.role ?? "agent",
        active: running.some(
          (task) =>
            task.agent === message.agent &&
            (!task.role || !message.role || task.role === message.role),
        ),
      });
    }
  }
  return sortParticipants([...people.values()]);
}

function shortGoal(goal: string) {
  const flat = goal.replace(/\s+/g, " ").replace(/^Backlog item:\s*/i, "");
  const cut = flat.search(/:\s| — /);
  const name = cut > 0 && cut <= 80 ? flat.slice(0, cut) : flat;
  return name.length > 80 ? `${name.slice(0, 79)}…` : name;
}

export function ProposalCard({
  message,
  busy,
  canStart,
  startHint,
  start,
  initialEditing = false,
  add,
  startItem,
}: {
  message: TeamChatMessage;
  busy: boolean;
  canStart: boolean;
  startHint: string;
  start: (goal: string) => Promise<void>;
  initialEditing?: boolean;
  add?: () => Promise<unknown>;
  startItem?: (item: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [goal, setGoal] = useState(message.proposal?.goal ?? message.text);
  if (message.proposal?.items?.length)
    return (
      <ProposalItems
        message={message}
        busy={busy}
        canStart={canStart}
        add={add}
        startItem={startItem}
      />
    );
  return (
    <div
      className="agent-team-chat-card"
      role="group"
      aria-label="Proposed run"
    >
      {editing && message.proposal?.status !== "started" ? (
        <textarea
          aria-label="Edit proposed goal"
          value={goal}
          maxLength={4000}
          disabled={busy}
          onChange={(event) => setGoal(event.target.value)}
        />
      ) : (
        <ChatText
          text={
            message.proposal?.status === "started"
              ? message.proposal.goal
              : goal
          }
        />
      )}
      {message.proposal?.status === "started" ? (
        <strong>Started</strong>
      ) : (
        <>
          <div className="agent-team-actions">
            <button
              type="button"
              disabled={busy || !canStart || !goal.trim()}
              onClick={() => void start(goal.trim())}
            >
              Start run
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (editing) setGoal(message.proposal?.goal ?? message.text);
                setEditing(!editing);
              }}
            >
              {editing ? "Cancel" : "Edit"}
            </button>
          </div>
          {!canStart && startHint && <p className="small">{startHint}</p>}
        </>
      )}
    </div>
  );
}

export function ControlCard({
  message,
  busy = false,
  confirm,
}: {
  message: TeamChatMessage;
  busy?: boolean;
  confirm?: (yes: boolean) => Promise<unknown>;
}) {
  const card = message.control;
  if (!card) return null;
  // Questions such as status, limits or queue need no confirmation: show the
  // answer as an ordinary message, keeping its lines.
  if (card.status === "done" && !needsConfirmation(card.command))
    return <ChatText text={card.result ?? message.text} />;
  return (
    <div
      className="agent-team-chat-card agent-team-control"
      role="group"
      aria-label="Chat command"
    >
      {card.status === "pending" ? (
        <>
          <span>{describeControlCommand(card.command)}</span>
          <button
            type="button"
            disabled={busy || !confirm}
            onClick={() => void confirm?.(true).catch(() => {})}
          >
            Confirm
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !confirm}
            onClick={() => void confirm?.(false).catch(() => {})}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <strong>
            {card.status[0]!.toUpperCase() + card.status.slice(1)}
          </strong>
          <span>{card.result ?? message.text}</span>
        </>
      )}
    </div>
  );
}

export function ProposalItems({
  message,
  busy = false,
  canStart = true,
  add,
  startItem,
}: {
  message: TeamChatMessage;
  busy?: boolean;
  canStart?: boolean;
  add?: () => Promise<unknown>;
  startItem?: (item: string) => Promise<unknown>;
}) {
  const [added, setAdded] = useState(false);
  const [started, setStarted] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const proposal = message.proposal;
  if (!proposal) return null;
  const disabled = busy || working;
  async function use(action: () => Promise<unknown>, done: () => void) {
    setWorking(true);
    try {
      await action();
      done();
    } catch {
      /* Parent displays the error. */
    } finally {
      setWorking(false);
    }
  }
  return (
    <div
      className="agent-team-chat-card"
      role="group"
      aria-label="Proposed backlog items"
    >
      <button
        type="button"
        disabled={disabled || !add || added || proposal.status === "added"}
        onClick={() => void use(add!, () => setAdded(true))}
      >
        Add to backlog
      </button>
      <ol className="agent-team-proposal-items">
        {proposal.items?.map((item, index) => (
          <li key={index}>
            <span>{item}</span>
            <button
              type="button"
              disabled={
                disabled || !canStart || !startItem || started.includes(item)
              }
              onClick={() =>
                void use(
                  () => startItem!(item),
                  () => setStarted([...started, item]),
                )
              }
            >
              {started.includes(item) ? "Started" : "Start now"}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * True while your latest message to the planner (not to one task) has no
 * planner reply after it yet, so the chat can show that it is being answered.
 */
export function awaitingPlanner(messages: TeamChatMessage[]): boolean {
  let lastUser: TeamChatMessage | undefined;
  for (const message of messages)
    if (message.author === "user") lastUser = message;
  if (!lastUser || (lastUser.to && lastUser.to !== "planner")) return false;
  const sent = Date.parse(lastUser.createdAt);
  return !messages.some(
    (m) =>
      m.author !== "user" &&
      (m.role === "planner" || m.author === "cobble") &&
      Date.parse(m.createdAt) >= sent &&
      m.id !== lastUser!.id,
  );
}


export type ChatView = "you" | "team";

/**
 * Which tab a message belongs to. Team chat is the agents talking among
 * themselves (hand-offs, reports, questions, anything about a task). Your
 * chat is you, the planner's replies to you, research reports and Cobble's
 * notes; Cobble never appears in Team chat.
 */
export function chatView(message: TeamChatMessage): ChatView {
  if (message.author !== "agent") return "you";
  if (message.role === "researcher") return "you";
  if (message.kind === "proposal") return "you";
  if (message.role === "planner" && message.kind === "message" && !message.taskId)
    return "you";
  return "team";
}


/** "2026-11-20T00:45:41.131Z" → your local "06:15". */
export function localTime(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : iso;
}

/** Replaces ISO timestamps inside a sentence with local times. */
export function readableTimes(text: string): string {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g, localTime);
}
