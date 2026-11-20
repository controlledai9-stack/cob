import { useState } from "react";
import type {
  AgentDetection,
  TeamAgentId,
  TeamMember,
  TeamMemberInput,
  TeamRole,
} from "../shared/types";
import {
  TEAM_ROLES,
  FULL_ACCESS_ROLES,
  memberNameError,
  memberModelError,
} from "../core/team/types";

const cliModel = (agent: string) =>
  ["claude", "codex", "gemini"].includes(agent);

function MemberModel({
  member,
  disabled,
  update,
}: {
  member: TeamMember;
  disabled: boolean;
  update: (name: string, patch: Partial<TeamMemberInput>) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const value = draft ?? member.model ?? "";
  const error = memberModelError(value);
  return (
    <>
      <input
        aria-label={`${member.name} model`}
        placeholder="CLI default"
        value={value}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={error ? `model-error-${member.name}` : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (!error && value !== (member.model ?? ""))
            update(member.name, { model: value || null });
          if (!error) setDraft(undefined);
        }}
      />
      {error && (
        <span id={`model-error-${member.name}`} role="alert" className="error">
          {error}
        </span>
      )}
    </>
  );
}

export const names: Record<TeamAgentId, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  "claude-api": "Claude API",
  free: "Free / local model",
  teammate: "Teammate",
};

const agents: TeamAgentId[] = [
  "claude",
  "codex",
  "gemini",
  "claude-api",
  "free",
];

export function MembersTable({
  members,
  detected,
  pending,
  add,
  update,
  remove,
}: {
  members?: TeamMember[];
  detected?: AgentDetection[];
  pending: boolean;
  add: (input: TeamMemberInput) => Promise<void>;
  update: (name: string, patch: Partial<TeamMemberInput>) => void;
  remove: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<TeamRole>("coder");
  const [agent, setAgent] = useState("codex");
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const disabled = pending || !members;
  return (
    <>
      <table className="agent-team-roles">
        <thead>
          <tr>
            {[
              "Name",
              "Role",
              "Agent",
              "Model",
              "Backup",
              "Full access",
              "Remove",
            ].map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {members?.map((member) => (
            <tr key={member.name}>
              <th scope="row">{member.name}</th>
              <td>{member.role}</td>
              <td>
                <select
                  aria-label={`${member.name} agent`}
                  value={member.agent}
                  disabled={disabled}
                  onChange={(event) =>
                    update(member.name, { agent: event.currentTarget.value })
                  }
                >
                  {(member.role === "debugger"
                    ? ["free"]
                    : member.agent === "teammate"
                      ? [...agents, "teammate"]
                      : agents
                  ).map((id) => (
                    <option key={id} value={id}>
                      {names[id as TeamAgentId]}
                    </option>
                  ))}
                </select>
                {member.role !== "debugger" &&
                  detected?.find((item) => item.agent === member.agent)
                    ?.installed === false && (
                    <span className="agent-team-badge agent-team-warning">
                      {names[member.agent]} is not installed
                    </span>
                  )}
              </td>
              <td>
                {cliModel(member.agent) ? (
                  <MemberModel
                    key={`${member.agent}:${member.model ?? ""}`}
                    member={member}
                    disabled={disabled}
                    update={update}
                  />
                ) : (
                  <span className="small">
                    {member.agent === "teammate"
                      ? "Configured by teammate"
                      : "Uses existing provider model settings"}
                  </span>
                )}
              </td>
              <td>
                <select
                  aria-label={`${member.name} backup agent`}
                  value={member.backup ?? ""}
                  disabled={disabled || member.role === "debugger"}
                  onChange={(event) =>
                    update(member.name, {
                      backup: event.currentTarget.value || null,
                    })
                  }
                >
                  <option value="">None</option>
                  {agents
                    .filter((id) => id !== member.agent)
                    .map((id) => (
                      <option key={id} value={id}>
                        {names[id as TeamAgentId]}
                      </option>
                    ))}
                </select>
              </td>
              <td>
                {FULL_ACCESS_ROLES.includes(member.role) ? (
                  <label className="agent-team-checkbox">
                    <input
                      type="checkbox"
                      aria-label={`Full access for ${member.name}`}
                      checked={!!member.fullAccess}
                      disabled={disabled}
                      onChange={(event) =>
                        update(member.name, {
                          fullAccess: event.currentTarget.checked,
                        })
                      }
                    />
                    <span className="small">
                      {member.fullAccess ? "No sandbox" : "Sandboxed"}
                    </span>
                  </label>
                ) : (
                  <span className="small">
                    {member.role === "debugger"
                      ? "Sandboxed file tools"
                      : "Read-only"}
                  </span>
                )}
              </td>
              <td>
                <button
                  type="button"
                  aria-label={`Remove ${member.name}`}
                  disabled={disabled}
                  onClick={() => remove(member.name)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="agent-team-actions"
        onSubmit={async (event) => {
          event.preventDefault();
          const validation =
            memberNameError(name) ??
            (cliModel(agent) ? memberModelError(model) : null) ??
            (members?.some((member) => member.name === name)
              ? "Member name is already taken"
              : null);
          setError(validation ?? "");
          if (validation || disabled) return;
          try {
            await add({
              name,
              role,
              agent,
              ...(cliModel(agent) ? { model: model || null } : {}),
            });
            setModel("");
            setName("");
          } catch (error) {
            setError(String(error instanceof Error ? error.message : error));
          }
        }}
      >
        <label>
          Name{" "}
          <input
            aria-label="New member name"
            value={name}
            maxLength={31}
            onChange={(event) => setName(event.currentTarget.value)}
            disabled={disabled}
          />
        </label>
        <label>
          Role{" "}
          <select
            aria-label="New member role"
            value={role}
            onChange={(event) => {
              const next = event.currentTarget.value as TeamRole;
              setRole(next);
              if (next === "debugger") setAgent("free");
            }}
            disabled={disabled}
          >
            {TEAM_ROLES.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent{" "}
          <select
            aria-label="New member agent"
            value={agent}
            onChange={(event) => setAgent(event.currentTarget.value)}
            disabled={disabled}
          >
            {(role === "debugger" ? ["free" as const] : agents).map((id) => (
              <option key={id} value={id}>
                {names[id]}
              </option>
            ))}
          </select>
        </label>
        {cliModel(agent) ? (
          <label>
            Model{" "}
            <input
              aria-label="New member model"
              placeholder="CLI default (blank)"
              value={model}
              onChange={(event) => setModel(event.currentTarget.value)}
              disabled={disabled}
            />
          </label>
        ) : (
          <span className="small">Uses existing provider model settings</span>
        )}
        <button type="submit" disabled={disabled}>
          Add member
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
