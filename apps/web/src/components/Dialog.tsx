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
