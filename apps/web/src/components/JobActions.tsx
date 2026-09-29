"use client";

import { useState } from "react";
import Dialog from "@/components/Dialog";
import { plural } from "@/lib/format";

/**
 * Archiving a job, with its confirmation.
 *
 * A hook rather than a button, because Archive lives in the three-dot menu on
 * job cards and on the job header: the menu item calls `request()` and the
 * page renders `dialog`. Whether the menu offers Archive at all is a display
 * rule only — the API enforces Action.jobDelete regardless.
 */
export function useArchiveJob({
  tenant,
  jobId,
  title,
  candidateCount,
  onArchived,
}: {
  tenant: string;
  jobId: string;
  title: string;
  candidateCount: number;
  onArchived: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/jobs/${jobId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not archive this job");
        return;
      }
      setConfirming(false);
      onArchived();
    } finally {
      setBusy(false);
    }
  }

  const dialog = confirming ? (
    <Dialog title={`Archive “${title}”?`} onClose={() => setConfirming(false)} busy={busy}>
      {candidateCount > 0 ? (
        <p>
          This role has <strong>{plural(candidateCount, "candidate")}</strong> attached. Archiving hides it from
          the portal and closes it to new applications. <strong>Nothing is deleted</strong> — their CVs,
          screening scores, calls and reports are all kept.
        </p>
      ) : (
        <p>Archiving hides this role from the portal and closes it to new applications. Nothing is deleted.</p>
      )}

      {error && <div className="notice notice-error">{error}</div>}

      <div className="jm-dialog-actions">
        <button type="button" className="btn-line" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
        <button type="button" className="btn-ink" disabled={busy} onClick={archive}>
          {busy ? "Archiving…" : "Archive job"}
        </button>
      </div>
    </Dialog>
  ) : null;

  return {
    request: () => {
      setError(null);
      setConfirming(true);
    },
    dialog,
  };
}
