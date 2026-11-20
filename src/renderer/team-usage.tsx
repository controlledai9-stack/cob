import { costLabel } from "../shared/cost-label";
import { useEffect, useRef, useState } from "react";
import type { UsageLimitsView } from "../shared/usage-view";

export function AiUsageCard({
  view,
  pending,
  setStopAt,
}: {
  view: UsageLimitsView | undefined;
  pending?: boolean;
  setStopAt(percent: number): void;
}) {
  const stopAt = view?.stopAt ?? 95;
  const [value, setValue] = useState(String(stopAt));
  const committed = useRef(stopAt);
  useEffect(() => {
    setValue(String(stopAt));
    committed.current = stopAt;
  }, [stopAt]);
  function commit(value: string) {
    if (pending || !value.trim()) return;
    const percent = Number(value);
    if (!Number.isFinite(percent)) return;
    const next = Math.max(50, Math.min(100, Math.round(percent)));
    setValue(String(next));
    if (next === committed.current) return;
    committed.current = next;
    setStopAt(next);
  }
  return (
    <section className="agent-team-card agent-team-usage">
      <h3>AI usage</h3>
      <label className="agent-team-actions">
        Stop at (%)
        <input
          type="number"
          aria-label="Stop at percent"
          min={50}
          max={100}
          step={1}
          value={value}
          disabled={pending}
          onChange={(event) => setValue(event.currentTarget.value)}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(event.currentTarget.value);
          }}
        />
      </label>
      {view?.agents.length ? (
        <ul className="agent-team-usage-list">
          {view.agents.map((usage) => (
            <li key={usage.agent} className="agent-team-usage-row">
              <div className="agent-team-actions">
                <strong>{usage.agent}</strong>
                <span>
                  {usage.percent === null ? "—" : `${usage.percent}%`}
                </span>
                {usage.windowHours !== null && (
                  <span>{usage.windowHours}h</span>
                )}
                <span className="agent-team-badge">{usage.source}</span>
                {usage.stopped && (
                  <span className="agent-team-badge agent-team-warning">
                    stopped
                  </span>
                )}
              </div>
              <span className="small">
                {costLabel(usage.loginType)}
                {!usage.loginType || usage.loginType === "unknown"
                  ? " (login type unknown)"
                  : ""}
              </span>
              <div
                role="progressbar"
                aria-label={`${usage.agent} usage`}
                aria-valuenow={usage.percent ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                className={`agent-team-usage-bar${usage.stopped || (usage.percent !== null && usage.percent >= stopAt) ? " is-warning" : ""}`}
              >
                <span
                  style={{
                    width: `${Math.max(0, Math.min(100, usage.percent ?? 0))}%`,
                  }}
                />
              </div>
              {usage.resetsAt && (
                <span className="small">
                  resets at{" "}
                  <time dateTime={usage.resetsAt}>
                    {new Date(usage.resetsAt).toLocaleTimeString()}
                  </time>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small">No usage data yet.</p>
      )}
    </section>
  );
}
