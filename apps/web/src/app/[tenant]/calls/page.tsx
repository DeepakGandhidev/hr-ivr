"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface Call {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: string | null;
  language: string | null;
  recognised: boolean;
  transcriptRef: string | null;
  recordingRef: string | null;
  candidate: {
    id: string;
    name: string | null;
    email: string | null;
    job: { id: string; title: string };
  };
  assessmentReport: { overallScore: number; recommendation: string } | null;
}

interface Payload {
  calls: Call[];
  jobs: Array<{ id: string; title: string }>;
  totals: { calls: number; minutes: number; endedCalls: number; truncated: boolean };
}

const LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

const STATUSES = [
  "completed", "dropped", "no_show", "unknown_caller", "out_of_window", "declined_consent",
];

/** A call that did not reach an interview is the interesting kind here. */
const pillFor = (status: string | null) => {
  if (status === "completed") return "ok";
  if (!status) return "mute";
  return "bad";
};

function duration(start: string, end: string | null) {
  if (!end) return "in progress";
  const secs = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s`;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export default function CallsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;

  // Last 7 days by default — the acceptance criterion for this page is
  // opening it and filtering to a week, so that is where it opens.
  const defaults = useMemo(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 7);
    return { from: isoDay(from), to: isoDay(to) };
  }, []);

  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(jobId ? { jobId } : {}),
      ...(status ? { status } : {}),
    });
    try {
      const res = await fetch(`/api/${tenant}/calls?${qs}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || "Could not load calls");
        return;
      }
      setError(null);
      setData(body);
    } finally {
      setLoading(false);
    }
  }, [tenant, from, to, jobId, status]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="dash" style={{ maxWidth: 1100 }}>
      <div className="dash-top">
        <div>
          <h1>Calls</h1>
          <p className="sub">Every call Pratibha has taken — including the ones that did not work.</p>
        </div>
        {data && (
          <div className="row" style={{ gap: 24 }}>
            <div>
              <div className="subtle">Calls</div>
              <div className="score" style={{ fontSize: 24 }}>{data.totals.calls}</div>
            </div>
            <div>
              <div className="subtle">Total minutes</div>
              <div className="score" style={{ fontSize: 24 }}>{data.totals.minutes}</div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label>
            <div className="subtle">From</div>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <div className="subtle">To</div>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <label>
            <div className="subtle">Role</div>
            <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">All roles</option>
              {data?.jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
            </select>
          </label>
          <label>
            <div className="subtle">Status</div>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All outcomes</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            onClick={() => { setFrom(defaults.from); setTo(defaults.to); setJobId(""); setStatus(""); }}
          >
            Reset
          </button>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {/* Stated rather than silently omitted: a page whose whole purpose is
          spotting problems must not hide a category of call it cannot show. */}
      <div className="notice notice-info" style={{ marginBottom: 16 }}>
        Callers we could not recognise are not listed here. Pratibha answers on one number
        shared by every workspace, so an unmatched call cannot be attributed to a tenant —
        those are recorded on the platform log instead.
      </div>

      <div className="card">
        {loading && !data ? (
          <p className="muted">Loading…</p>
        ) : !data || data.calls.length === 0 ? (
          <p className="muted">No calls in this period.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th><th>Candidate</th><th>Role</th><th>Duration</th>
                  <th>Language</th><th>Status</th><th>Score</th><th>Transcript</th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.startedAt).toLocaleString()}</td>
                    <td className="role">
                      <Link href={`/${tenant}/candidates/${c.candidate.id}`} style={{ color: "inherit" }}>
                        {c.candidate.name ?? c.candidate.email ?? "Unnamed"}
                      </Link>
                    </td>
                    <td>{c.candidate.job.title}</td>
                    <td>{duration(c.startedAt, c.endedAt)}</td>
                    <td>{c.language ? LANGUAGES[c.language] ?? c.language : "—"}</td>
                    <td>
                      <span className={`pill ${pillFor(c.status)}`}>
                        {c.status ? c.status.replace(/_/g, " ") : "in progress"}
                      </span>
                    </td>
                    <td>
                      {c.assessmentReport
                        ? <span className={`score${c.assessmentReport.overallScore >= 7 ? " hi" : ""}`}>
                            {c.assessmentReport.overallScore}
                          </span>
                        : <span className="subtle">—</span>}
                    </td>
                    <td>
                      {c.transcriptRef
                        ? <a href={c.transcriptRef}>Open</a>
                        : <span className="subtle">In ProMonkey OS</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.totals.truncated && (
          <p className="muted" style={{ marginTop: 12 }}>
            Showing the most recent 500 calls. Narrow the date range to see earlier ones.
          </p>
        )}
      </div>
    </div>
  );
}
