"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * Edit and archive, for one job.
 *
 * `canDelete` is resolved on the server and passed in, so the button does not
 * appear and then vanish once a role check lands. It is a display rule only —
 * the API enforces Action.jobDelete regardless of what this renders.
 */
export default function JobActions({
  tenant,
  jobId,
  title,
  candidateCount,
  canDelete,
}: {
  tenant: string;
  jobId: string;
  title: string;
  candidateCount: number;
  canDelete: boolean;
}) {
  const router = useRouter();
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
      router.refresh();
      router.push(`/${tenant}/jobs`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row" style={{ gap: 8 }}>
        <Link
          href={`/${tenant}/jobs/${jobId}/edit`}
          className="btn"
          onClick={(e) => e.stopPropagation()}
        >
          Edit
        </Link>
        {canDelete && (
          <button
            type="button"
            className="btn"
            onClick={(e) => {
              // The jobs list wraps each card in a link; without this, asking to
              // archive would navigate into the job instead.
              e.preventDefault();
              e.stopPropagation();
              setConfirming(true);
            }}
          >
            Archive
          </button>
        )}
      </div>

      {confirming && (
        <div className="modal-backdrop" onClick={() => !busy && setConfirming(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>Archive “{title}”?</h3>

            {candidateCount > 0 ? (
              <p>
                This role has <strong>{candidateCount}</strong>{" "}
                {candidateCount === 1 ? "candidate" : "candidates"} attached. Archiving hides
                it from the portal and closes it to new applications.{" "}
                <strong>Nothing is deleted</strong> — their CVs, screening scores, calls and
                reports are all kept.
              </p>
            ) : (
              <p>
                Archiving hides this role from the portal and closes it to new applications.
                Nothing is deleted.
              </p>
            )}

            {error && <div className="notice notice-error">{error}</div>}

            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={archive}>
                {busy ? "Archiving…" : "Archive job"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
