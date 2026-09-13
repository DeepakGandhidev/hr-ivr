"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * The overview, rebuilt to the client's reference design.
 *
 * The organising idea of that design is that Pratibha does the work and the
 * human makes decisions — so "Needs you" is the first thing on the page and
 * the funnel highlights the one stage that waits on a person. Everything here
 * is real data; where the schema cannot answer a question the design asks
 * (which reports have been *read*, for instance) the label says what the
 * number actually is rather than implying we know more than we do.
 */

interface Job {
  id: string;
  title: string;
  status: string;
  createdAt?: string;
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

interface LiveCall {
  id: string;
  startedAt: string;
  language: string | null;
  candidate: { id: string; name: string | null; job: { title: string } };
}

interface Report {
  id: string;
  overallScore: number;
  recommendation: string;
  generatedAt: string;
  interviewCall: { candidate: { id: string; name: string | null; job: { title: string } } };
}

interface Blocked {
  id: string;
  name: string | null;
  jobId: string;
  job: { title: string };
}

interface ActivityEvent {
  at: string;
  kind: string;
  title: string;
  detail: string;
}

interface Overview {
  jobs: Job[];
  mailboxes: Mailbox[];
  recentCandidates: Candidate[];
  liveCall: LiveCall | null;
  recentReports: Report[];
  blockedCandidates: Blocked[];
  funnel: {
    applications: number;
    screened: number;
    shortlisted: number;
    approved: number;
    interviewed: number;
    recommended: number;
  };
  usage: {
    period: string;
    interviewMinutesUsed: number;
    interviewMinuteLimit: number | null;
    interviewsUsed: number;
    interviewLimit: number | null;
    screeningsUsed: number;
    screeningLimit: number | null;
  };
  activity: ActivityEvent[];
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

function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** Elapsed time on a live call, as mm:ss. */
function elapsed(fromIso: string, now: number) {
  const secs = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

const LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

export default function OverviewPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(`/api/${tenant}/overview`);
      const body = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok) {
        setError(body.message || "Could not load your overview");
        return;
      }
      setData(body);
    }
    load();
    // A call in progress is the one thing on this page that changes by the
    // second, so the page re-reads while one is live rather than showing a
    // frozen timer that looks broken.
    const poll = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [tenant]);

  useEffect(() => {
    if (!data?.liveCall) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [data?.liveCall]);

  if (error) return <div className="notice notice-error">{error}</div>;
  if (!data) return <div className="card empty"><p className="muted">Loading your overview…</p></div>;

  const { funnel, stats } = data;
  const openJobs = data.jobs.filter((j) => j.status === "open");
  const healthyMailboxes = data.mailboxes.filter((m) => m.status === "connected");
  const brokenMailboxes = data.mailboxes.filter((m) => m.status !== "connected");
  const pendingReports = data.recentReports.length;

  // Widths are relative to the widest stage, not to a fixed scale: with 187
  // applications and 5 recommendations, a linear scale renders the last four
  // bars as invisible slivers.
  const widest = Math.max(funnel.applications, 1);
  const pct = (n: number) => `${Math.max(n > 0 ? 2 : 0, (n / widest) * 100)}%`;

  const stages: Array<{ k: number; t: string; gate?: boolean }> = [
    { k: funnel.applications, t: "Applications" },
    { k: funnel.screened, t: "Screened" },
    { k: funnel.shortlisted, t: "Shortlisted" },
    { k: funnel.approved, t: "Approved by you", gate: true },
    { k: funnel.interviewed, t: "Interviewed" },
    { k: funnel.recommended, t: "Recommended" },
  ];

  return (
    <div className="dash">
      <div className="dash-top">
        <div>
          <h1>{greeting()}</h1>
          <p className="sub">
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            {" · "}
            Pratibha has read {stats.candidates} {stats.candidates === 1 ? "application" : "applications"} and
            completed {stats.interviewsCompleted} {stats.interviewsCompleted === 1 ? "interview" : "interviews"}.
          </p>
        </div>
        <div className="row">
          <Link href={`/${tenant}/jobs/new`} className="btn btn-saffron">+ New role</Link>
        </div>
      </div>

      {data.liveCall && (
        <div className="live">
          <span className="pulse" />
          <div>
            <b>On a call with {data.liveCall.candidate.name ?? "a candidate"}</b>{" "}
            <span className="live-sub">
              · {data.liveCall.candidate.job.title} · {elapsed(data.liveCall.startedAt, now)} elapsed
              {data.liveCall.language ? ` · ${LANGUAGES[data.liveCall.language] ?? data.liveCall.language}` : ""}
            </span>
          </div>
          <div className="right">
            <div>Interviews <b>{stats.interviewsCompleted}</b></div>
            <div>Reports pending <b>{pendingReports}</b></div>
            <div>
              Mailbox{" "}
              <b style={{ color: brokenMailboxes.length ? "#FDA4AF" : "#86EFAC" }}>
                {data.mailboxes.length === 0 ? "none" : brokenMailboxes.length ? "needs attention" : "healthy"}
              </b>
            </div>
          </div>
        </div>
      )}

      <div className="sec-h">
        <h2>Needs you</h2>
        <span style={{ fontSize: 13, color: "var(--brand-muted)" }}>
          Pratibha does the work — these are your decisions
        </span>
      </div>
      <div className="needs">
        <div className={`need${stats.awaitingApproval > 0 ? " hot" : ""}`}>
          <span className="k">{stats.awaitingApproval}</span>
          <span className="t">Shortlists awaiting approval</span>
          <span className="d">
            {stats.awaitingApproval > 0
              ? "Nobody is contacted until you say so."
              : "Nothing waiting on you here."}
          </span>
          {stats.awaitingApproval > 0 && (
            <Link href={`/${tenant}/pipeline`} className="btn btn-saffron btn-sm">Review shortlists</Link>
          )}
        </div>

        <div className="need">
          <span className="k">{pendingReports}</span>
          {/* Deliberately "recent", not "unread": nothing records who has read
              what, and a count that claims otherwise would be a lie. */}
          <span className="t">Recent interview reports</span>
          <span className="d">
            {data.recentReports.length > 0
              ? data.recentReports
                  .slice(0, 2)
                  .map((r) => `${r.interviewCall.candidate.name ?? "Candidate"} scored ${r.overallScore}`)
                  .join(", ")
              : "No interview reports yet."}
          </span>
          {pendingReports > 0 && (
            <Link href={`/${tenant}/pipeline`} className="btn btn-ghost btn-sm">Read reports</Link>
          )}
        </div>

        <div className={`need${data.blockedCandidates.length > 0 ? " hot" : ""}`}>
          <span className="k">{data.blockedCandidates.length}</span>
          <span className="t">
            {data.blockedCandidates.length === 1 ? "Candidate without a phone number" : "Candidates without a phone number"}
          </span>
          <span className="d">
            {data.blockedCandidates.length > 0
              ? `${data.blockedCandidates[0].name ?? "A candidate"} applied for ${data.blockedCandidates[0].job.title} — Pratibha can't invite them to call.`
              : "Everyone we have can be reached."}
          </span>
          {data.blockedCandidates.length > 0 && (
            <Link
              href={`/${tenant}/jobs/${data.blockedCandidates[0].jobId}/candidates`}
              className="btn btn-ghost btn-sm"
            >
              Add number
            </Link>
          )}
        </div>

        <div className={`need${brokenMailboxes.length ? " hot" : " ok"}`}>
          <span className="k">{brokenMailboxes.length ? brokenMailboxes.length : "All clear"}</span>
          <span className="t">Mailbox &amp; postings</span>
          <span className="d">
            {data.mailboxes.length === 0
              ? "No mailbox connected — applications can only be added by hand."
              : brokenMailboxes.length
                ? `${brokenMailboxes[0].address}: ${brokenMailboxes[0].errorDetail ?? "not connected"}`
                : `${healthyMailboxes[0]?.address} checked ${
                    healthyMailboxes[0]?.lastPollAt
                      ? new Date(healthyMailboxes[0].lastPollAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "—"
                  }. ${openJobs.length} ${openJobs.length === 1 ? "role" : "roles"} open.`}
          </span>
          {(brokenMailboxes.length > 0 || data.mailboxes.length === 0) && (
            <Link href={`/${tenant}/settings/email`} className="btn btn-ghost btn-sm">Open mailbox settings</Link>
          )}
        </div>
      </div>

      <div className="funnel">
        <div className="sec-h" style={{ margin: 0 }}>
          <h2>This month&rsquo;s pipeline</h2>
          <span style={{ fontSize: 13, color: "var(--brand-muted)" }}>
            Across {openJobs.length} open {openJobs.length === 1 ? "role" : "roles"}
          </span>
        </div>
        <div className="funnel-row">
          {stages.map((s) => (
            <div key={s.t} className={`stage${s.gate ? " gate" : ""}`}>
              <div className="k">{s.k}</div>
              <div className="t">{s.t}</div>
              <div className="bar"><i style={{ width: pct(s.k) }} /></div>
            </div>
          ))}
        </div>
      </div>

      <div className="dash-grid">
        <div className="card">
          <div className="sec-h">
            <h2 style={{ margin: 0 }}>Open roles</h2>
            <Link href={`/${tenant}/jobs`}>View all</Link>
          </div>
          {data.jobs.length === 0 ? (
            <p className="muted">No roles yet. <Link href={`/${tenant}/jobs/new`}>Create one</Link>.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Role</th><th>Applied</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {data.jobs.slice(0, 6).map((job) => (
                    <tr key={job.id}>
                      <td className="role">
                        <Link href={`/${tenant}/jobs/${job.id}`} style={{ color: "inherit" }}>{job.title}</Link>
                        {job.createdAt && (
                          <small>Created {new Date(job.createdAt).toLocaleDateString()}</small>
                        )}
                      </td>
                      <td>{job._count.candidates}</td>
                      <td>
                        <span className={`pill ${job.status === "open" ? "ok" : job.status === "draft" ? "gate" : "mute"}`}>
                          {job.status}
                        </span>
                      </td>
                      <td>
                        <Link href={`/${tenant}/jobs/${job.id}/shortlist`} className="rowbtn">Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>What Pratibha did today</h2>
          {data.activity.length === 0 ? (
            <p className="muted">Nothing yet today.</p>
          ) : (
            <div className="feed">
              {data.activity.map((e, i) => (
                <div className="ev" key={`${e.at}-${i}`}>
                  <time>{timeOf(e.at)}</time>
                  <div><b>{e.title}</b> <span>· {e.detail}</span></div>
                </div>
              ))}
            </div>
          )}

          {data.mailboxes.slice(0, 1).map((m) => (
            <div className="mail" key={m.id}>
              <div>
                <b>{m.address}</b>
                <span>
                  {m.autoRoute ? "All roles" : "One role"} ·{" "}
                  {m.lastPollAt ? `checked ${timeOf(m.lastPollAt)}` : "not polled yet"}
                </span>
              </div>
              <span className={`pill ${m.status === "connected" ? "ok" : "bad"}`}>{m.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="sec-h">
          <h2 style={{ margin: 0 }}>Latest applications</h2>
          <Link href={`/${tenant}/pipeline`}>All {stats.candidates}</Link>
        </div>
        {data.recentCandidates.length === 0 ? (
          <p className="muted">No applications yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Candidate</th><th>Role</th><th>Phone</th><th>Source</th><th>Stage</th></tr>
              </thead>
              <tbody>
                {data.recentCandidates.slice(0, 6).map((c) => {
                  const job = data.jobs.find((j) => j.id === c.jobId);
                  return (
                    <tr key={c.id}>
                      <td className="role">
                        <Link href={`/${tenant}/candidates/${c.id}`} style={{ color: "inherit" }}>
                          {c.name ?? c.email ?? "Unnamed"}
                        </Link>
                      </td>
                      <td>{job?.title ?? "—"}</td>
                      <td>{c.phoneE164 ?? <span className="pill bad">No phone</span>}</td>
                      <td>{c.routedBy ?? "—"}</td>
                      <td>
                        {c.parseFailed
                          ? <span className="pill mute">CV unreadable</span>
                          : <span className="pill ok">Filed</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
