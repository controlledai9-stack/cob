import React, { useCallback, useEffect, useState } from "react";
import type { BuildPlanItem, BuildPlanView } from "../core/team/build-plan";

/** The build plan from the backlog, kept current while Autopilot works. */
export function BuildPlanPanel({
  load,
  subscribe,
  initial,
}: {
  load?: () => Promise<BuildPlanView>;
  subscribe?: (refresh: () => void) => () => void;
  initial?: BuildPlanView;
}) {
  const [view, setView] = useState<BuildPlanView | undefined>(initial);
  const [error, setError] = useState("");
  const refresh = useCallback(() => {
    if (!load) return;
    load().then(
      (next) => {
        setView(next);
        setError("");
      },
      (cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [load]);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 20_000);
    const off = subscribe?.(refresh);
    return () => {
      clearInterval(timer);
      off?.();
    };
  }, [refresh, subscribe]);

  const groups: { key: keyof BuildPlanView; title: string; tone: string }[] = [
    { key: "running", title: "Running now", tone: "is-running" },
    { key: "next", title: "Next", tone: "is-next" },
    { key: "attention", title: "Needs attention", tone: "is-attention" },
    { key: "claude", title: "Waiting for Claude", tone: "is-claude" },
    { key: "done", title: "Done", tone: "is-done" },
  ];
  const total = view
    ? groups.reduce((n, g) => n + (view[g.key] as BuildPlanItem[]).length, 0)
    : 0;
  return (
    <section className="panel build-plan">
      <h2>Build plan</h2>
      <p className="small">
        {view
          ? `${view.done.length} of ${total} done · updates on its own from ${view.source}`
          : "Loading the build plan…"}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {view && total === 0 && (
        <p className="small">
          The backlog is empty. Say <code>add &lt;idea&gt;</code> in Team Chat
          to plan new work.
        </p>
      )}
      {view && (
        <div className="build-plan-groups">
          {groups.map(({ key, title, tone }) => {
            const items = view[key] as BuildPlanItem[];
            if (!items.length) return null;
            return (
              <div key={key} className={`build-plan-group ${tone}`}>
                <h3>
                  {title} <span className="build-plan-count">{items.length}</span>
                </h3>
                <ul>
                  {items.map((item, index) => (
                    <li key={index}>
                      <span>{item.label}</span>
                      {item.note && (
                        <span className="build-plan-note">{item.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
