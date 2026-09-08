"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface Job {
  id: string;
  title: string;
  status: string;
  _count: { candidates: number };
}

interface Candidate {
  id: string;
  name: string | null;
  email: string | null;
  phoneE164: string | null;
  jobId: string;
  routedBy: string | null;
  routingConfidence: number | null;
  parseFailed: boolean;
  createdAt: string;
}

export default function PipelinePage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [jobFilter, setJobFilter] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    fetch(`/api/${tenant}/overview`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Failed to load");
        return r.json();
      })
      .then((d) => {
        setJobs(d.jobs ?? []);
        setCandidates(d.recentCandidates ?? []);
      })
      .catch((e) => setError(e.message));
  }, [tenant]);

  const jobTitle = (id: string) => jobs.find((j) => j.id === id)?.title ?? "—";

  const visible = useMemo(
    () =>
      candidates.filter((c) => {
        if (jobFilter && c.jobId !== jobFilter) return false;
        // "Problems" are the rows a recruiter must act on by hand: no phone
        // means the agent can never call them, and a failed parse means the CV
        // yielded nothing usable.
        if (onlyProblems && c.phoneE164 && !c.parseFailed) return false;
        return true;
      }),
    [candidates, jobFilter, onlyProblems]
  );

  if (error) return <div className="notice notice-error">{error}</div>;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>Pipeline</h1>
        <p className="muted">Applications imported from your connected mailboxes, newest first.</p>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <select value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} style={{ width: "auto", minWidth: 220 }}>
          <option value="">All jobs</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title} ({j._count.candidates})
            </option>
          ))}
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", marginBottom: 0, fontWeight: 500 }}>
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
            />
          Only ones needing attention
        </label>
        <span className="subtle" style={{ marginLeft: "auto" }}>
          {visible.length} of {candidates.length}
        </span>
      </div>

      {candidates.length === 0 ? (
        <div className="card empty">
          <h3>No applications yet</h3>
          <p>
            Once a mailbox is connected, applications appear here within seconds
            of arriving. <Link href={`/${tenant}/settings/email`}>Connect a mailbox</Link>.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap"><table>
            <thead>
              <tr>
                <th style={{ paddingTop: 12 }}>Candidate</th>
                <th>Job</th>
                <th>Phone</th>
                <th>Routing</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{c.name ?? <span style={{ color: "var(--danger)" }}>Could not parse</span>}</div>
                    <div className="subtle">{c.email ?? "no email"}</div>
                  </td>
                  <td>
                    <Link href={`/${tenant}/jobs/${c.jobId}/candidates`} >
                      {jobTitle(c.jobId)}
                    </Link>
                  </td>
                  <td>
                    {c.phoneE164 ? (
                      c.phoneE164
                    ) : (
                      // Without a number the whole point of the product — the
                      // screening call — cannot happen for this candidate.
                      <span className="badge badge-danger">not callable</span>
                    )}
                  </td>
                  <td>
                    {c.routedBy === "auto" ? (
                      <span className="badge badge-success">matched {c.routingConfidence}%</span>
                    ) : c.routedBy === "fallback" ? (
                      <span className="badge badge-warning">no match — check job</span>
                    ) : (
                      <span className="subtle">{c.routedBy ?? "manual"}</span>
                    )}
                  </td>
                  <td className="subtle">{new Date(c.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
