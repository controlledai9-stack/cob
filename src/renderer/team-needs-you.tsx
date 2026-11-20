import React, { useRef, useState } from "react";
import type { AppHubAction, AppHubNeed } from "../core/team/app-hub";

export type AppHubActionHandler = (
  action: AppHubAction,
  answer?: string,
) => void | Promise<void>;

/** UI guard only. The backend must validate every target against fresh state. */
export async function submitAppHubAction(
  action: AppHubAction,
  onAction: AppHubActionHandler,
  answer?: string,
  busy = false,
): Promise<boolean> {
  if (action.humanOnly || busy) return false;
  if (action.kind === "answer" && !answer?.trim()) return false;
  await onAction(action, action.kind === "answer" ? answer!.trim() : undefined);
  return true;
}

export function AppHubActions({
  actions,
  onAction,
  busyActionId,
}: {
  actions: AppHubAction[];
  onAction: AppHubActionHandler;
  busyActionId?: string;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  const busy = pending !== undefined || busyActionId !== undefined;

  async function perform(action: AppHubAction) {
    if (inFlight.current || busy || action.humanOnly) return;
    inFlight.current = true;
    setPending(action.id);
    setError(undefined);
    try {
      const sent = await submitAppHubAction(
        action,
        onAction,
        answers[action.id],
      );
      if (sent && action.kind === "answer") {
        setAnswers((previous) => ({ ...previous, [action.id]: "" }));
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Action failed. Try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(undefined);
    }
  }

  return (
    <div className="app-hub-actions" aria-busy={busy}>
      {actions.map((action) => {
        if (action.humanOnly) {
          return (
            <p className="app-hub-human-path" key={action.id}>
              {action.label}: Use the existing human approval or sign-in path
              shown for this item. Complete it there, then return to Cobble.
            </p>
          );
        }
        const working = pending === action.id || busyActionId === action.id;
        const button = (
          <button
            type={action.kind === "answer" ? "submit" : "button"}
            disabled={
              busy || (action.kind === "answer" && !answers[action.id]?.trim())
            }
            onClick={
              action.kind === "answer" ? undefined : () => void perform(action)
            }
          >
            {working ? `${action.label}…` : action.label}
          </button>
        );
        return action.kind === "answer" ? (
          <form
            className="app-hub-answer"
            key={action.id}
            onSubmit={(event) => {
              event.preventDefault();
              void perform(action);
            }}
          >
            <label>
              <span>{action.label}</span>
              <input
                type="text"
                value={answers[action.id] ?? ""}
                disabled={busy}
                required
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [action.id]: event.target.value,
                  }))
                }
              />
            </label>
            {button}
          </form>
        ) : (
          <React.Fragment key={action.id}>{button}</React.Fragment>
        );
      })}
      {error && (
        <p className="app-hub-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function TeamNeedsYou({
  items,
  onAction,
  busyActionId,
}: {
  items: AppHubNeed[];
  onAction: AppHubActionHandler;
  busyActionId?: string;
}) {
  return (
    <section className="app-hub app-hub-needs" aria-label="Needs you">
      <h3>Needs you</h3>
      {items.length === 0 ? (
        <p>Nothing needs your attention.</p>
      ) : (
        <ul className="app-hub-list">
          {items.map((item) => (
            <li className="app-hub-item" key={item.id}>
              <h4>{item.title}</h4>
              {item.detail && <p className="app-hub-detail">{item.detail}</p>}
              <AppHubActions
                actions={item.actions}
                onAction={onAction}
                busyActionId={busyActionId}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
