import React, { useState } from "react";
import { filterParticipants, PEOPLE_SEARCH_AT } from "../../chat-scale";
import { Users } from "lucide-react";
import { cn, initials } from "./utils";
import { AgentGlyph } from "./agent-glyph";

/**
 * A clean group chat layout (adapted from Ruixen's mono chat): header,
 * members on the left (click one to see only their messages), the messages,
 * and the input bar. Cobble's Team Chat fills it with the agents' messages.
 */
export interface ChatParticipant {
  id: string;
  name: string;
  /** e.g. "planner · Codex". */
  detail?: string;
  /** Working right now. */
  active?: boolean;
  /** Agent role: gives the avatar its colour (members get shapes). */
  role?: string;
}

function PersonAvatar({ person }: { person: ChatParticipant }) {
  return person.role ? (
    <span className="ui-avatar ui-avatar-glyph" aria-hidden="true">
      <AgentGlyph role={person.role} name={person.name} size={28} />
      <i className={cn("ui-dot", person.active && "is-on")} />
    </span>
  ) : (
    <span className="ui-avatar" aria-hidden="true">
      {initials(person.name)}
      <i className={cn("ui-dot", person.active && "is-on")} />
    </span>
  );
}

export function AgentChatShell({
  title,
  subtitle,
  actions,
  participants,
  selected,
  onSelect,
  status,
  banner,
  tabs,
  footer,
  children,
  className,
  headingId,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  participants: ChatParticipant[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** A live line under the header, e.g. who is working. */
  status?: React.ReactNode;
  /** Cards above the messages, e.g. what needs you and pipeline health. */
  banner?: React.ReactNode;
  /** A tab bar under the header (Your chat / Team chat). */
  tabs?: React.ReactNode;
  footer: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  headingId?: string;
}) {
  const [peopleQuery, setPeopleQuery] = useState("");
  return (
    <section
      className={cn("ui-chat", className)}
      aria-labelledby={headingId}
    >
      {tabs ? (
        // The tabs are the heading: no second "Team Chat" title above them.
        <header className="ui-chat-header has-tabs">
          <span aria-hidden="true" />
          <div className="ui-chat-title">
            <h3 id={headingId} className="cobble-sr-only">
              {title}
            </h3>
            {tabs}
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="ui-chat-actions">{actions}</div>
        </header>
      ) : (
        <header className="ui-chat-header">
          <Users size={22} aria-hidden="true" />
          <div className="ui-chat-title">
            <h3 id={headingId}>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="ui-chat-actions">{actions}</div>}
        </header>
      )}
      {status && <div className="ui-chat-status">{status}</div>}
      {banner && <div className="ui-chat-banner">{banner}</div>}
      <div className="ui-chat-main">
        {participants.length > 1 && (
          <aside className="ui-chat-people" aria-label="Who is in this chat">
            {participants.length > PEOPLE_SEARCH_AT && (
              <input
                className="ui-chat-people-search"
                type="search"
                aria-label="Find a person or agent"
                placeholder="Find a person or agent"
                value={peopleQuery}
                onChange={(event) => setPeopleQuery(event.target.value)}
              />
            )}
            <button
              type="button"
              className={cn("ui-chat-person", selected === null && "selected")}
              onClick={() => onSelect(null)}
            >
              <span className="ui-avatar" aria-hidden="true">
                <Users size={16} />
              </span>
              <span className="ui-chat-person-text">
                <span className="ui-chat-person-name">Everyone</span>
              </span>
            </button>
            {filterParticipants(participants, peopleQuery).map((person) => (
              <button
                type="button"
                key={person.id}
                className={cn(
                  "ui-chat-person",
                  selected === person.id && "selected",
                )}
                onClick={() =>
                  onSelect(selected === person.id ? null : person.id)
                }
              >
                <PersonAvatar person={person} />
                <span className="ui-chat-person-text">
                  <span className="ui-chat-person-name">{person.name}</span>
                  {person.detail && (
                    <span className="ui-chat-person-detail">
                      {person.detail}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </aside>
        )}
        {children}
      </div>
      <footer className="ui-chat-footer">{footer}</footer>
    </section>
  );
}

export function ChatMessageRow({
  name,
  time,
  tone,
  to,
  role,
  member,
  children,
}: {
  name: string;
  time: string;
  tone: string;
  to?: string;
  /** Agent role and member name: the avatar becomes the agent's shape. */
  role?: string;
  member?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="ui-chat-message-head">
        {tone === "user" ? (
          <span className="ui-avatar" aria-hidden="true">
            {initials(name)}
          </span>
        ) : (
          <span className="ui-avatar ui-avatar-glyph" aria-hidden="true">
            <AgentGlyph
              role={tone === "agent" ? (role ?? "agent") : "cobble"}
              name={tone === "agent" ? (member ?? role) : "Cobble"}
              size={30}
            />
          </span>
        )}
        <div className="agent-team-chat-meta">
          <strong>{name}</strong>
          {to && <span> → {to}</span>}
          <time>{time}</time>
        </div>
      </div>
      <div className="ui-chat-message-body">{children}</div>
    </>
  );
}

/** Characters shown before "Show more". */
export const CHAT_PREVIEW_CHARS = 420;

/**
 * Agent text for people: code blocks and raw JSON are hidden (they are in
 * the Data panel and the run's files), and blank-line runs are collapsed.
 */
export function cleanAgentText(text: string): {
  text: string;
  hidden: number;
} {
  let hidden = 0;
  let out = text.replace(/```[\s\S]*?(```|$)/g, () => {
    hidden++;
    return "";
  });
  const lines: string[] = [];
  let depth = 0;
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    const opensJson =
      depth === 0 &&
      (/^[{[]\s*$/.test(trimmed) ||
        /^\{\s*"[^"]+"\s*:/.test(trimmed) ||
        /^\[\s*\{/.test(trimmed));
    if (opensJson || depth > 0) {
      if (opensJson) hidden++;
      for (const ch of trimmed) {
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
      }
      if (depth < 0) depth = 0;
      continue;
    }
    lines.push(line);
  }
  out = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, hidden };
}

/** Short preview with a Show more button for long agent messages. */
export function ClampedMessage({
  text,
  render,
}: {
  text: string;
  render: (text: string) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const clean = cleanAgentText(text);
  const long = clean.text.length > CHAT_PREVIEW_CHARS;
  let shown = clean.text;
  if (long && !expanded) {
    const cut = clean.text.lastIndexOf(" ", CHAT_PREVIEW_CHARS);
    shown = `${clean.text.slice(0, cut > 200 ? cut : CHAT_PREVIEW_CHARS).trimEnd()}…`;
  }
  return (
    <>
      {shown ? render(shown) : null}
      {(long || clean.hidden > 0) && (
        <div className="ui-chat-more">
          {clean.hidden > 0 && (
            <span className="small">
              {clean.hidden === 1
                ? "1 code or data block hidden"
                : `${clean.hidden} code or data blocks hidden`}
            </span>
          )}
          {long && (
            <button
              type="button"
              className="ui-link-button"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
