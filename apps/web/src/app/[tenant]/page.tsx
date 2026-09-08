"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Job {
  id: string;
  title: string;
  status: string;
  _count: { candidates: number };
}

interface Mailbox {
  id: string;
  address: string;
  status: string;
  autoRoute: boolean;
  lastPollAt: string | null;
  errorDetail: string | null;
}

interface Candidate {
  id: string;
  name: string | null;
  email: string | null;
  phoneE164: string | null;
  jobId: string;
  routedBy: string | null;
  parseFailed: boolean;
  createdAt: string;
}

interface Overview {
  jobs: Job[];
  mailboxes: Mailbox[];
  recentCandidates: Candidate[];
  stats: {
    openJobs: number;
    totalJobs: number;
    candidates: number;
    unscreened: number;
    shortlisted: number;
    awaitingApproval: number;
    interviewsCompleted: number;
  };
}

function Stat({ label, value, href, accent }: { label: string; value: number; href?: string; accent?: boolean }) {
  // The accent only fires when the number is non-zero: highlighting "0 awaiting
  // approval" trains people to ignore the colour.
  const className = `stat${accent && value > 0 ? " stat-attention" : ""}`;
  const body = (
    <>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </>
  );
  return href
    ? <Link href={href} className={className}>{body}</Link>
    : <div className={className}>{body}</div>;
}

export default function DashboardPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/${tenant}/overview`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "Failed to load");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [tenant]);

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;

  const { stats, jobs, mailboxes, recentCandidates } = data;
  const jobTitle = (id: string) => jobs.find((j) => j.id === id)?.title ?? "—";

  // A brand-new workspace has nothing to show, and an empty dashboard reads as
  // a broken one. Say what to do instead.
  const isEmpty = jobs.length === 0 && stats.candidates === 0;

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <h1>Overview</h1>
        <p className="muted">Everything happening across your hiring right now.</p>
      </div>

      {isEmpty ? (
        <div className="card empty" style={{ textAlign: "left" }}>
          <h3>Let&apos;s get you set up</h3>
          <ol style={{ lineHeight: 2, paddingLeft: 20 }}>
            <li><Link href={`/${tenant}/jobs/new`}>Create your first job</Link> and open it.</li>
            <li><Link href={`/${tenant}/settings/email`}>Connect your hiring mailbox</Link> so applications arrive automatically.</li>
            <li>Applications are parsed into candidates as the mail arrives — no forwarding rules, no DNS changes.</li>
          </ol>
        </div>
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", marginBottom: 20 }}>
            <Stat label="Open jobs" value={stats.openJobs} href={`/${tenant}/jobs`} />
            <Stat label="Candidates" value={stats.candidates} href={`/${tenant}/pipeline`} />
            <Stat label="Not yet screened" value={stats.unscreened} href={`/${tenant}/pipeline`} accent />
            <Stat label="Awaiting approval" value={stats.awaitingApproval} accent />
            <Stat label="Interviews done" value={stats.interviewsCompleted} />
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", marginBottom: 20 }}>
            <div className="card">
              <h3>Jobs</h3>
              {jobs.length === 0 ? (
                <p className="muted">
                  No jobs yet. <Link href={`/${tenant}/jobs/new`}>Create one</Link>.
                </p>
              ) : (
                jobs.slice(0, 6).map((j) => (
                  <div key={j.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--border)" }}>
                    <Link href={`/${tenant}/jobs/${j.id}`} >
                      {j.title}
                    </Link>
                    <span className="subtle">
                      {j._count.candidates} · {j.status}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="card">
              <h3>Mailboxes</h3>
              {mailboxes.length === 0 ? (
                <p className="muted">
                  None connected. <Link href={`/${tenant}/settings/email`}>Connect one</Link> to import applications automatically.
                </p>
              ) : (
                mailboxes.map((m) => (
                  <div key={m.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>{m.address}</span>
                      <span className={`badge ${m.status === "error" ? "badge-danger" : m.status === "revoked" ? "badge-neutral" : "badge-success"}`}>
                        {m.status === "revoked" ? "paused" : m.status}
                      </span>
                    </div>
                    <div className="subtle">
                      {m.autoRoute ? "all jobs" : "one job"}
                      {m.lastPollAt ? ` · checked ${new Date(m.lastPollAt).toLocaleTimeString()}` : " · not checked yet"}
                    </div>
                    {m.errorDetail && <div className="subtle" style={{ color: "var(--danger)" }}>{m.errorDetail}</div>}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="card">
            <h3>Latest applications</h3>
            {recentCandidates.length === 0 ? (
              <p className="muted">Nothing yet.</p>
            ) : (
              <div className="table-wrap"><table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Job</th>
                    <th>Phone</th>
                    <th>Filed</th>
                  </tr>
                </thead>
                <tbody>
                  {recentCandidates.slice(0, 10).map((c) => (
                    <tr key={c.id}>
                      <td>{c.name ?? <span className="badge badge-danger">could not parse</span>}</td>
                      <td>{jobTitle(c.jobId)}</td>
                      <td>
                        {/* No phone means the agent can never call them. */}
                        {c.phoneE164 ?? <span className="badge badge-danger">no phone</span>}
                      </td>
                      <td className="subtle">{c.routedBy ?? "manual"}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
