"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * A modal dialog: labelled by its title, closed by Escape or the backdrop, and
 * handing focus back to whatever opened it.
 */
export default function Dialog({
  title,
  onClose,
  children,
  wide = false,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** While true, Escape and the backdrop do not close it. */
  busy?: boolean;
}) {
  const titleId = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // The first field if there is one, else the dialog itself.
    const first = box.current?.querySelector<HTMLElement>(
      "input, select, textarea, [data-autofocus]"
    );
    (first ?? box.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) onClose();
      // Focus stays inside while it is open: Tab from the last control wraps
      // to the first, Shift+Tab from the first to the last.
      if (e.key === "Tab" && box.current) {
        const focusable = Array.from(
          box.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === box.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !box.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
    // onClose is intentionally not a dependency: re-running would steal focus
    // back to the first field on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()} role="presentation">
      <div
        ref={box}
        className={`modal jm-dialog${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="jm-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn-link" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
