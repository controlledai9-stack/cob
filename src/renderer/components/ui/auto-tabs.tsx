import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "./utils";

/**
 * Turns a long page of stacked panels into tabs: each panel (a child with a
 * heading) becomes one tab and only the selected one is shown. Children
 * without a heading (errors, notices) always stay visible. Works on any
 * page without restructuring it; the choice is remembered per page.
 */
export function AutoTabs({
  storageKey,
  disabled = false,
  className,
  children,
}: {
  storageKey: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [selected, setSelected] = useState(() => readChoice(storageKey));

  const apply = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const items = disabled ? [] : tabItems(el);
    const next = uniqueLabels(items.map(labelOf));
    const index = Math.max(
      0,
      next.indexOf(selected) >= 0 ? next.indexOf(selected) : 0,
    );
    items.forEach((item, i) => {
      const hide = items.length > 1 && i !== index;
      if (hide) item.setAttribute("data-tab-hidden", "");
      else item.removeAttribute("data-tab-hidden");
    });
    if (disabled)
      el.querySelectorAll("[data-tab-hidden]").forEach((node) =>
        node.removeAttribute("data-tab-hidden"),
      );
    setLabels((old) =>
      old.length === next.length && old.every((l, i) => l === next[i])
        ? old
        : next,
    );
  }, [disabled, selected]);

  useLayoutEffect(() => {
    apply();
    const el = box.current;
    if (!el || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => apply());
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [apply]);

  const current =
    labels.indexOf(selected) >= 0 ? selected : (labels[0] ?? "");
  return (
    <div className={cn("ui-autotabs", className)}>
      {labels.length > 1 && (
        <div className="ui-tabbar" role="tablist" aria-label="Sections">
          {labels.map((label) => (
            <button
              type="button"
              role="tab"
              key={label}
              aria-selected={label === current}
              className={cn("ui-tab", label === current && "is-active")}
              onClick={() => {
                setSelected(label);
                saveChoice(storageKey, label);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div ref={box} className="ui-autotabs-body">
        {children}
      </div>
    </div>
  );
}

const HEADING = "h2, h3";

/** The panels to turn into tabs: children (of the first level with more than one child) that have a heading. */
export function tabItems(root: Element): HTMLElement[] {
  let level: Element = root;
  while (level.children.length === 1 && level.firstElementChild)
    level = level.firstElementChild;
  return Array.from(level.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      !child.classList.contains("ui-tabbar") &&
      !child.classList.contains("modal-backdrop") &&
      !child.querySelector(":scope > [role=dialog]") &&
      !!labelOf(child),
  );
}

export function labelOf(el: Element): string {
  if (el.classList.contains("status-grid")) return "Overview";
  const explicit = el.getAttribute("data-tab");
  if (explicit) return explicit;
  const heading = el.querySelector(HEADING);
  const text = heading?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "";
  return text.length > 26 ? `${text.slice(0, 25).trimEnd()}…` : text;
}

export function uniqueLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} ${n}`;
  });
}

function readChoice(key: string): string {
  try {
    return localStorage.getItem(`cobble-tab:${key}`) ?? "";
  } catch {
    return "";
  }
}

function saveChoice(key: string, label: string) {
  try {
    localStorage.setItem(`cobble-tab:${key}`, label);
  } catch {
    /* The choice is a convenience only. */
  }
}
