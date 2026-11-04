"use client";

import { useState } from "react";
import { api } from "@/lib/client";
import { Dialog, ReasonField } from "@/components/ui";
import { useSubmit } from "@/components/WorkspaceActions";

/** The refusal shown on a disabled edit control; the API says the same for Support. */
export const EDIT_REFUSAL = "Only an Owner or Engineer can edit a workspace.";

/**
 * One edit dialog, the same everywhere on the workspace page: the fields the
 * caller renders, a required reason, the server's refusal word for word, and
 * Save. The payload is read at submit time, so it sees the latest field state.
 */
export function EditDialog({
  title,
  path,
  payload,
  confirm,
  onClose,
  onDone,
  danger,
  width,
  ready = true,
  children,
}: {
  title: string;
  path: string;
  payload: () => Record<string, unknown>;
  confirm: string;
  onClose: () => void;
  onDone: (message: string) => void;
  danger?: boolean;
  width?: number;
  ready?: boolean;
  children?: React.ReactNode;
}) {
  const [reason, setReason] = useState("");
  const { busy, error, run } = useSubmit();
  return (
    <Dialog title={title} onClose={onClose} busy={busy} width={width}>
      {children}
      <ReasonField value={reason} onChange={setReason} />
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? "btn-danger-solid" : "btn-primary"}`} disabled={busy || !ready}
          onClick={() =>
            run(async () => {
              const res = await api<{ message: string }>(path, { ...payload(), reason });
              onDone(res.message);
            })
          }>
          {busy ? "Saving…" : confirm}
        </button>
      </div>
    </Dialog>
  );
}

/** A labelled text input. */
export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  max,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  max?: number;
  placeholder?: string;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input" value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** A label-and-value line in a read-only card. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="card-row" style={{ fontSize: 13.5, alignItems: "flex-start" }}>
      <span className="cell-muted" style={{ width: 150, flexShrink: 0 }}>{label}</span>
      <span className="grow" style={{ minWidth: 0, whiteSpace: "pre-wrap", color: "var(--ink-body)" }}>{children}</span>
    </div>
  );
}
