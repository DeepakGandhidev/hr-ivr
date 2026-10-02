"use client";

import { useEffect, useRef, useState } from "react";

/** A modal. Escape and the backdrop close it unless it is busy. */
export function Dialog({
  title,
  children,
  onClose,
  busy,
  width,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={width ? { width } : undefined}>
        <div className="dialog-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** The ⋯ menu. Items are rendered by the caller; any click inside closes it. */
export function ActionMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" aria-label={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="13" height="13" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="2.2" cy="7" r="1.4" />
          <circle cx="7" cy="7" r="1.4" />
          <circle cx="11.8" cy="7" r="1.4" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Chip({ tone, children, small }: { tone: string; children: React.ReactNode; small?: boolean }) {
  return <span className={`chip chip-${tone}${small ? " sm" : ""}`}>{children}</span>;
}

/** A short-lived confirmation at the bottom of the screen. */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3200);
    return () => clearTimeout(t);
  }, [message]);
  return {
    show: setMessage,
    node: message ? (
      <div className="toast" role="status">
        {message}
      </div>
    ) : null,
  };
}

/** A required reason box, the same everywhere a sensitive action asks for one. */
export function ReasonField({
  value,
  onChange,
  label = "Reason",
  placeholder = "Recorded in the activity log",
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor="reason">{label}</label>
      <textarea
        id="reason"
        className="textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={500}
        required
        style={{ minHeight: 64 }}
      />
    </div>
  );
}
