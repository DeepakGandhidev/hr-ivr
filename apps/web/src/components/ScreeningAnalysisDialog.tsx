"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Dialog from "@/components/Dialog";
import { displayName } from "@/lib/candidates";

interface Analysis {
  candidate: { id: string; name: string | null; nameSource: string | null; hasCvFile: boolean };
  job: { id: string; title: string };
  threshold: number;
  onShortlist: boolean;
  screening: {
    id: string;
    score: number;
    matches: string[];
    gaps: string[];
    reason: string | null;
    createdAt: string;
  } | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "28 Sep", with the year only when it is not this one. Fixed months: ICU now prints "Sept". */
export function shortDate(value: string | Date) {
  const d = new Date(value);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/**
 * PL82 — the screening analysis, read over the Pipeline without leaving it.
 * Shortlist here is the same draft-shortlist add as the Candidates tab: it
 * sends nothing to the candidate until someone approves the shortlist.
 */
export default function ScreeningAnalysisDialog({
  tenant,
  candidateId,
  canEdit,
  onClose,
  onMove,
  onShortlisted,
}: {
  tenant: string;
  candidateId: string;
  canEdit: boolean;
  onClose: () => void;
  onMove: () => void;
  onShortlisted: (message: string) => void;
}) {
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/${tenant}/candidates/${candidateId}/analysis`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || "Could not load the screening");
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [tenant, candidateId]);

  const name = displayName(data?.candidate.name) ?? "Candidate";

  async function shortlist() {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/shortlists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: data.candidate.id, action: "add" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.message || "Could not update the shortlist");
      setData({ ...data, onShortlist: true });
      onShortlisted(`${name} added to the shortlist. Nothing has been sent to them.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the shortlist");
    } finally {
      setBusy(false);
    }
  }

  const s = data?.screening;
  const suggested = s ? s.score >= (data?.threshold ?? 0) : false;

  return (
    <Dialog title={data ? name : "Screening"} onClose={onClose} wide busy={busy}>
      {error && <div className="notice notice-error">{error}</div>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <div className="sa">
          <p className="sa-sub">
            {s ? `Screened against ${data.job.title} · ${shortDate(s.createdAt)}` : `Not yet screened against ${data.job.title}`}
          </p>
          {s && (
            <>
              <div className="sa-score">
                <span className="sa-score-n">{s.score}</span>
                <span className="sa-score-of">
                  out of 100, against the
                  <br />
                  role&apos;s requirements
                </span>
                <span className="jm-spacer" />
                <span className={`chip ${suggested ? "chip-green" : "chip-neutral"}`}>
                  {suggested ? "Suggested for shortlist" : "Not suggested"}
                </span>
              </div>
              {s.matches.length > 0 && (
                <section>
                  <h3 className="sa-h sa-h-ok">Matches</h3>
                  <ul className="sa-list">
                    {s.matches.map((m, i) => (
                      <li key={i}>
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="sa-ok">
                          <path d="M2 7.5 L5.5 11 L12 3.5" />
                        </svg>
                        <span>{m}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {s.gaps.length > 0 && (
                <section>
                  <h3 className="sa-h sa-h-gap">Gaps</h3>
                  <ul className="sa-list">
                    {s.gaps.map((g, i) => (
                      <li key={i}>
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="sa-gap">
                          <path d="M2.5 7 L11.5 7" />
                        </svg>
                        <span>{g}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {s.reason && (
                <section>
                  <h3 className="sa-h">Why this score</h3>
                  <p className="sa-why">{s.reason}</p>
                </section>
              )}
            </>
          )}
          <div className="sa-foot">
            {canEdit &&
              (data.onShortlist ? (
                <span className="chip chip-green">On the shortlist</span>
              ) : (
                <button type="button" className="btn-ink" onClick={shortlist} disabled={busy || !s}>
                  {busy ? "Adding…" : "Shortlist"}
                </button>
              ))}
            <Link href={`/${tenant}/candidates/${data.candidate.id}`} className="btn-line">
              Open full profile
            </Link>
            {data.candidate.hasCvFile && (
              <a href={`/api/${tenant}/candidates/${data.candidate.id}/cv`} target="_blank" rel="noreferrer" className="sa-quiet">
                View CV
              </a>
            )}
            <span className="jm-spacer" />
            {canEdit && (
              <button type="button" className="btn-link sa-quiet" onClick={onMove}>
                Move to another job
              </button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
