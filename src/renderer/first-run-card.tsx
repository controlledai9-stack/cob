import React, { useState } from "react";
import type { AgentDetection, TeamMemberInput } from "../core/team/types";

/** Setup opens for a project with no team yet; once a team exists, the chat shows. */
export function shouldOpenSetup(members: readonly unknown[]): boolean {
  return members.length === 0;
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  "claude-api": "Claude API",
  free: "Free / local model",
  teammate: "A teammate's agent",
};

/**
 * Shown on the Agent Team page while a project has no team yet: find the
 * agents on this PC, accept a proposed team, answer the session brief, and
 * start Pilot. Every step can be skipped; nothing is downloaded or signed in.
 */
export function FirstRunCard({
  detected,
  detecting,
  onDetect,
  proposed,
  hasMembers,
  accept,
  brief,
  startPilot,
  close,
}: {
  detected?: AgentDetection[];
  detecting: boolean;
  onDetect: () => void;
  proposed: TeamMemberInput[];
  hasMembers: boolean;
  accept: () => Promise<void>;
  /** The session brief form. */
  brief: React.ReactNode;
  startPilot: () => Promise<void>;
  /** Leave setup and open the chat. */
  close: () => void;
}) {
  const [busy, setBusy] = useState<"" | "accept" | "pilot">("");
  const [error, setError] = useState("");
  const run = async (kind: "accept" | "pilot", action: () => Promise<void>) => {
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };
  const installed = (detected ?? []).filter((d) => d.installed);
  return (
    <section className="panel first-run" aria-labelledby="first-run-heading">
      <div className="first-run-head">
        <h2 id="first-run-heading">Set up your AI team</h2>
        <button type="button" className="secondary" onClick={close}>
          Skip to chat
        </button>
      </div>
      <p className="small">
        Four short steps. Skip any of them; nothing is downloaded or signed in
        for you.
      </p>
      <ol className="first-run-steps">
        <li>
          <h3>Find your agents</h3>
          {detecting && !detected ? (
            <p className="small">Looking for agents on this PC…</p>
          ) : installed.length ? (
            <ul className="first-run-found">
              {installed.map((d) => (
                <li key={d.agent}>
                  {AGENT_NAMES[d.agent] ?? d.agent}
                  {d.version ? <span className="small"> {d.version}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small">
              No agent found. Install Claude Code, Codex or Gemini CLI, or a
              free local model with Ollama, then look again.
            </p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={detecting}
            onClick={onDetect}
          >
            {detecting ? "Looking…" : "Look again"}
          </button>
        </li>
        <li>
          <h3>Your team</h3>
          {hasMembers ? (
            <p className="small">Your team is set. Change it later under the table button in the chat.</p>
          ) : proposed.length ? (
            <>
              <ul className="first-run-members">
                {proposed.map((m) => (
                  <li key={m.name}>
                    <strong>{m.name}</strong> · {m.role} ·{" "}
                    {AGENT_NAMES[m.agent] ?? m.agent}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void run("accept", accept)}
              >
                {busy === "accept" ? "Adding…" : "Accept this team"}
              </button>
            </>
          ) : (
            <p className="small">
              Once an agent is found, Cobble proposes a team for it here.
            </p>
          )}
        </li>
        <li>
          <h3>Session brief</h3>
          <p className="small">
            Answer once: how long the team may work, which agents, a spending
            limit and the top priority. Pilot works from this.
          </p>
          {brief}
        </li>
        <li>
          <h3>Start</h3>
          <div className="agent-team-actions">
            <button
              type="button"
              disabled={!hasMembers || !!busy}
              onClick={() => void run("pilot", startPilot)}
            >
              {busy === "pilot" ? "Starting…" : "Start Pilot"}
            </button>
            <button type="button" className="secondary" onClick={close}>
              Open the chat instead
            </button>
          </div>
          {!hasMembers && (
            <p className="small">Accept a team first.</p>
          )}
        </li>
      </ol>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
