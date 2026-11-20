import React from "react";
import type { AppHubHealth } from "../core/team/app-hub";
import { AppHubActions, type AppHubActionHandler } from "./team-needs-you";

export function TeamHealthBanner({
  items,
  onAction,
  busyActionId,
}: {
  items: AppHubHealth[];
  onAction: AppHubActionHandler;
  busyActionId?: string;
}) {
  return (
    <section className="app-hub app-hub-health" aria-label="Pipeline health">
      <h3>Pipeline health</h3>
      {items.length === 0 ? (
        <p>No pipeline health issues reported.</p>
      ) : (
        <ul className="app-hub-list">
          {items.map((item) => (
            <li className={`app-hub-item is-${item.severity}`} key={item.id}>
              <h4>
                <span className="app-hub-severity">{item.severity}</span>{" "}
                {item.title}
              </h4>
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
