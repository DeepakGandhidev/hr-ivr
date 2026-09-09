"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AddCandidates from "@/components/AddCandidates";
import EmailCandidate from "@/components/EmailCandidate";

interface Screening {
  id: string;
  score: number;
  verdict: string;
  reasonSummary: string;
  createdAt: string;
}

interface Job {
  id: string;
  title: string;
}

interface Candidate {
  id: string;
  routedBy?: string | null;
  name?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  parseFailed?: boolean;
  cvParsed?: Record<string, unknown> | null;
  createdAt: string;
  screenings: Screening[];
}

export default function CandidatesPage({ params }: { params: { tenant: string; id: string } }) {
  const router = useRouter();
  const { tenant, id } = params;
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [emailing, setEmailing] = useState<Candidate | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [moving, setMoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/${tenant}/candidates?jobId=${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load candidates");
      setCandidates(data.candidates ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load candidates");
    } finally {
      setLoaded(true);
    }
  }, [tenant, id]);

  useEffect(() => {
    load();
  }, [load]);

  // The move target list. Failures are silent: this only powers a dropdown, and
  // an error banner here would look like the candidate list itself had failed.
  useEffect(() => {
    fetch(`/api/${tenant}/jobs`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {});
  }, [tenant]);

  async function moveCandidate(candidateId: string, jobId: string) {
    setMoving(candidateId);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/candidates/${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not move this candidate");

      await load();
      router.refresh();
      setMessage(
        `Moved to ${data.movedTo}.` +
          (data.discardedScreenings
            ? ` Their previous score was cleared — screen them again for the new role.`
            : "")
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move this candidate");
    } finally {
      setMoving(null);
    }
  }

  /** @returns true when the candidate was scored, so bulk runs can stop on failure. */
  async function screenOne(candidateId: string): Promise<boolean> {
    const res = await fetch(`/api/${tenant}/candidates/${candidateId}/screen`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Screening failed");
      return false;
    }
    return true;
  }

  async function screenCandidate(candidateId: string) {
    setBusy(candidateId);
    setError(null);
    setMessage(null);
    const ok = await screenOne(candidateId);
    setBusy(null);
    if (ok) {
      await load();
      router.refresh();
      setMessage("Screened. Shortlisted candidates appear on the Shortlist tab.");
    }
  }

  async function screenAll() {
    const pending = candidates.filter((c) => c.screenings.length === 0);
    if (pending.length === 0) return;

    setError(null);
    setMessage(null);
    setBulk({ done: 0, total: pending.length });

    // Sequential, not parallel: each screening is a model call metered against
    // the tenant's quota, and firing them at once would blow the limit and give
    // no way to tell which ones actually landed.
    let done = 0;
    for (const candidate of pending) {
      const ok = await screenOne(candidate.id);
      if (!ok) break;
      done += 1;
      setBulk({ done, total: pending.length });
    }

    setBulk(null);
    await load();
    router.refresh();
    setMessage(`Screened ${done} of ${pending.length}.`);
  }

  const unscreened = candidates.filter((c) => c.screenings.length === 0);
  const verdictClass = (v?: string) =>
    v === "shortlist" ? "badge-success" : v === "reject" ? "badge-danger" : "badge-neutral";

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <Link href={`/${tenant}/jobs/${id}`} className="subtle">&larr; Back to job</Link>
        <h1 style={{ marginTop: 6 }}>Candidates</h1>
        <p className="muted">
          Screening scores each CV against the job&apos;s must-haves. Anyone it
          shortlists moves to the Shortlist tab for your approval.
        </p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      <div style={{ marginBottom: 16 }}>
        <AddCandidates tenant={tenant} jobId={id} onAdded={load} />
      </div>

      {candidates.length > 0 && (
        <div className="row" style={{ marginBottom: 16 }}>
          <button
            onClick={screenAll}
            disabled={Boolean(bulk) || unscreened.length === 0}
            className="primary"
          >
            {bulk
              ? `Screening ${bulk.done}/${bulk.total}…`
              : unscreened.length === 0
                ? "All candidates screened"
                : `Screen ${unscreened.length} unscreened`}
          </button>
          <Link href={`/${tenant}/jobs/${id}/shortlist`} className="btn">Go to shortlist</Link>
          <span className="subtle" style={{ marginLeft: "auto" }}>
            {candidates.length} candidate(s)
          </span>
        </div>
      )}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : candidates.length === 0 ? (
        <div className="card empty">
          <h3>No candidates yet</h3>
          <p>
            Add CVs above — one or a whole folder at a time — or connect a
            mailbox and applications will be imported and parsed automatically
            as they arrive.
          </p>
          <Link href={`/${tenant}/settings/email`} className="btn" style={{ marginTop: 16 }}>
            Connect a mailbox
          </Link>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ paddingTop: 12 }}>Candidate</th>
                  <th>Phone</th>
                  <th>Score</th>
                  <th>Verdict</th>
                  <th>Reason</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => {
                  const latest = candidate.screenings[0];
                  return (
                    <tr key={candidate.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>
                          <Link href={`/${tenant}/candidates/${candidate.id}`} style={{ color: "inherit" }}>
                            {candidate.name || <span style={{ color: "var(--danger)" }}>Could not parse</span>}
                          </Link>
                        </div>
                        <div className="subtle">{candidate.email || "no email"}</div>
                        {candidate.routedBy === "fallback" && (
                          // The router could not match this application to a
                          // job and filed it here as a last resort, so it is
                          // the most likely one to be sitting on the wrong role.
                          <span className="badge badge-warning" style={{ marginTop: 4 }}>
                            unmatched — filed here as fallback
                          </span>
                        )}
                      </td>
                      <td>
                        {candidate.phoneE164 ?? (
                          // Screening still works, but this candidate can never
                          // reach the interview stage, so say so here.
                          <span className="badge badge-danger">not callable</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{latest?.score ?? "—"}</td>
                      <td>
                        {latest ? (
                          <span className={`badge ${verdictClass(latest.verdict)}`}>{latest.verdict}</span>
                        ) : (
                          <span className="badge badge-neutral">not screened</span>
                        )}
                      </td>
                      <td className="subtle" style={{ maxWidth: 280 }}>
                        {latest?.reasonSummary ?? "—"}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                          <select
                            aria-label={`Move ${candidate.name ?? "candidate"} to another job`}
                            title="Move this candidate to another job"
                            value=""
                            disabled={moving === candidate.id || Boolean(bulk)}
                            onChange={(e) => {
                              if (e.target.value) moveCandidate(candidate.id, e.target.value);
                            }}
                            style={{ width: "auto", padding: "5px 8px", fontSize: 13 }}
                          >
                            <option value="">
                              {moving === candidate.id ? "Moving…" : "Move to…"}
                            </option>
                            {jobs
                              .filter((job) => job.id !== id)
                              .map((job) => (
                                <option key={job.id} value={job.id}>
                                  {job.title}
                                </option>
                              ))}
                          </select>
                          <button
                            className="sm"
                            onClick={() => setEmailing(candidate)}
                            disabled={!candidate.email || Boolean(bulk)}
                            title={
                              candidate.email
                                ? `Write an email to ${candidate.email}`
                                : "This candidate has no email address on file"
                            }
                          >
                            Email
                          </button>
                          <button
                            className="sm"
                            onClick={() => screenCandidate(candidate.id)}
                            disabled={busy === candidate.id || Boolean(bulk)}
                          >
                            {busy === candidate.id ? "Screening…" : latest ? "Re-screen" : "Screen"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {emailing && (
        <EmailCandidate
          tenant={tenant}
          candidate={emailing}
          onClose={() => setEmailing(null)}
          onSent={(text) => {
            setError(null);
            setMessage(text);
          }}
        />
      )}
    </div>
  );
}
