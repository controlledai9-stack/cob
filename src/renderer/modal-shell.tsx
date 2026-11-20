import React, { useEffect, useRef, useId } from "react";
import { createPortal } from "react-dom";

export function ModalShell({
  title,
  onClose,
  children,
  className = "workspace-connection-modal",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  const previous = useRef(typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  useEffect(() => {
    const controls = () =>
      Array.from(
        root.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.getClientRects().length);
    (controls()[0] ?? root.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (!first) {
        event.preventDefault();
        root.current?.focus();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !root.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !root.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous.current?.isConnected) previous.current.focus();
    };
  }, []);
  const dialog = (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-card ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={root}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
  // Rendered at the top of the document so page layouts (tabs, scrolling
  // panels) can never hide or clip a pop-up.
  return typeof document === "undefined"
    ? dialog
    : createPortal(dialog, document.body);
}
