"use client";

import { useState } from "react";
import {
  CANDIDATE_STATUSES,
  CANDIDATE_STATUS_LABELS,
  type CandidateStatus,
} from "@pratibha/shared";

/**
 * Which badge each status wears.
 *
 * Carried on the existing badge classes rather than new colours: the point of
 * the palette is that "green" means the same thing on every screen, and a
 * pipeline with seven bespoke colours would say nothing except that somebody
 * enjoyed picking them. So: the terminal good outcome is green, the terminal
 * bad one red, the judgement call amber, and the four automatic positions stay
 * neutral or accent because they are progress, not verdicts.
 */
const BADGE_CLASS: Record<CandidateStatus, string> = {
  inbox: "badge-neutral",
  screened: "badge-neutral",
  shortlisted: "badge-accent",
  interviewed: "badge-accent",
  advance_stage: "badge-warning",
  hired: "badge-success",
  rejected: "badge-danger",
};

export function CandidateStatusBadge({ status }: { status: CandidateStatus }) {
  return (
    <span className={`badge ${BADGE_CLASS[status]}`}>{CANDIDATE_STATUS_LABELS[status]}</span>
  );
}

/**
 * The status control on the candidate detail page.
 *
 * Every status is offered, including moving backwards: the recruiter is the
 * authority on where somebody stands, and the server takes the same view — this
 * select is a convenience, not the check. Server-side authorisation decides
 * whether the change is allowed, so a viewer who reaches this control still
 * gets a refusal from the API.
 */
export function CandidateStatusPicker({
  tenant,
  candidateId,
  status,
  onChanged,
}: {
  tenant: string;
  candidateId: string;
  status: CandidateStatus;
  /** Re-fetch the page's data. The change adds a timeline entry too, so the
   *  whole record is reloaded rather than the badge patched in isolation. */
  onChanged: () => void | Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: CandidateStatus) {
    if (next === status) return;
    setSaving(true);
    setError(null);

    try {
      const res = await fetch(`/api/${tenant}/candidates/${candidateId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? "Could not change the status");
        return;
      }

      await onChanged();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="status-picker">
      <label className="status-picker-label" htmlFor="candidate-status">
        Status
      </label>
      <select
        id="candidate-status"
        className="input status-picker-select"
        value={status}
        disabled={saving}
        onChange={(e) => change(e.target.value as CandidateStatus)}
      >
        {CANDIDATE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {CANDIDATE_STATUS_LABELS[s]}
          </option>
        ))}
      </select>
      {error ? <p className="status-picker-error">{error}</p> : null}
    </div>
  );
}
