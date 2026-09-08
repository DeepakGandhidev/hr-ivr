"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Screening {
  id: string;
  score: number;
  verdict: string;
  reasonSummary: string;
}

interface OutreachEmail {
  id: string;
  sentAt?: string | null;
  status?: string | null;
  approvalId: string;
}

interface Candidate {
  id: string;
  name?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  /** Optional: a caller that forgets to include it must not crash the page. */
  screenings?: Screening[];
  outreachEmails?: OutreachEmail[];
}

interface ShortlistItem {
  id: string;
  candidateId: string;
  addedBy: string;
  removedBy?: string | null;
  finalState?: string | null;
  candidate: Candidate;
}

interface Approval {
  id: string;
  approvedAt: string;
}

interface Shortlist {
  id: string;
  status: string;
  createdAt?: string;
  approvals?: Approval[];
  _count?: { items: number };
}

interface JobCandidate {
  id: string;
  screenings?: { score: number; verdict: string }[];
}

interface SendResult {
  candidateId: string;
  outreachEmailId: string;
  status: string;
}

export default function ShortlistPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const [shortlist, setShortlist] = useState<Shortlist | null>(null);
  const [shortlists, setShortlists] = useState<Shortlist[]>([]);
  // Which shortlist the page is showing. Null means "decide on load", so the
  // default survives a reload but an explicit choice is not overridden by it.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<ShortlistItem[]>([]);
  // Read only to explain an empty shortlist. "No shortlisted candidates yet"
  // reads as a fault when the real answer is that every candidate was screened
  // and scored under the threshold — a setting the recruiter can act on.
  const [jobCandidates, setJobCandidates] = useState<JobCandidate[]>([]);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Alongside the shortlist, so an empty one can be explained rather than
      // just reported. Failures here are not surfaced: this is context for the
      // empty state, and losing it must not look like the shortlist failed.
      fetch(`/api/${tenant}/candidates?jobId=${id}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setJobCandidates(d.candidates ?? []))
        .catch(() => {});
      fetch(`/api/${tenant}/jobs/${id}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setThreshold(d.job?.screeningThreshold ?? 70))
        .catch(() => {});

      const listRes = await fetch(`/api/${tenant}/shortlists?jobId=${id}`, { cache: "no-store" });
      const listData = await listRes.json();
      const all: Shortlist[] = listData.shortlists ?? [];
      setShortlists(all);

      // Newest first from the API. Default to the approved one rather than the
      // newest, because screening a candidate after an approval opens a fresh
      // draft — and defaulting to that would hide the approved shortlist along
      // with the invites already sent under it, inviting a duplicate approval.
      const chosen =
        all.find((s) => s.id === selectedId) ?? all.find((s) => s.status === "approved") ?? all[0];
      if (!chosen) return;
      setSelectedId(chosen.id);

      const res = await fetch(`/api/${tenant}/shortlists/${chosen.id}`, { cache: "no-store" });
      const data = await res.json();
      if (data?.shortlist) {
        setShortlist(data.shortlist);
        setItems(data.shortlist.items ?? []);
      } else {
        setShortlist(chosen);
      }
    } catch {
      setError("Failed to load shortlist");
    }
  }, [tenant, id, selectedId]);

  useEffect(() => {
    load();
  }, [load]);

  async function updateShortlist(candidateId: string, action: "add" | "remove") {
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/shortlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, action }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Failed to update shortlist");
      return;
    }
    setShortlist(data.shortlist);
    setItems(data.shortlist?.items ?? []);
  }

  async function approveShortlist() {
    if (!shortlist) return;
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/shortlists/${shortlist.id}/approve`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Failed to approve shortlist");
      return;
    }
    setMessage("Shortlist approved. You can now request interviews.");
    // Re-read rather than patching status locally: approving mints the approval
    // the invite buttons are gated on, and the page needs its id.
    await load();
  }

  /**
   * Send the interview invite. `candidateIds` omitted means everyone on the
   * approved shortlist; `resend` re-mails someone who already has an invite
   * under this approval, which the server otherwise skips.
   */
  async function requestInterview(candidateIds: string[] | undefined, resend = false) {
    if (!shortlist) return;
    setError(null);
    setMessage(null);
    setSending(candidateIds?.length === 1 ? candidateIds[0] : "all");

    try {
      const res = await fetch(`/api/${tenant}/shortlists/${shortlist.id}/send-invites`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(candidateIds ? { candidateIds } : {}), resend }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not send the interview invite");
        return;
      }
      setMessage(describeSend(data.sent ?? []));
      await load();
    } catch {
      setError("Could not send the interview invite");
    } finally {
      setSending(null);
    }
  }

  const activeItems = items.filter((item) => !item.removedBy && item.finalState !== "removed");
  const isApproved = shortlist?.status === "approved";
  const archivedItems = items.filter((item) => item.removedBy || item.finalState === "removed");
  const currentApprovalId = shortlist?.approvals?.[0]?.id;

  /** Invited means: mailed successfully, under the approval now in force. */
  const invitedUnderApproval = (candidate: Candidate) =>
    Boolean(
      currentApprovalId &&
        candidate.outreachEmails?.some(
          (email) => email.approvalId === currentApprovalId && email.status === "sent"
        )
    );

  const invitable = activeItems.filter((item) => item.candidate.email);
  const pending = invitable.filter((item) => !invitedUnderApproval(item.candidate));
  const withoutEmail = activeItems.filter((item) => !item.candidate.email);

  const screened = jobCandidates.filter((c) => (c.screenings?.length ?? 0) > 0);
  const topScore = screened.reduce((max, c) => Math.max(max, c.screenings?.[0]?.score ?? 0), 0);

  /**
   * Why is this list empty? The three answers need different actions, and the
   * old copy gave the same one ("screen candidates") to all of them — advice
   * that is simply wrong once everything has been screened and archived.
   */
  function emptyShortlistExplanation() {
    if (jobCandidates.length === 0) {
      return (
        <>
          <h3>No candidates yet</h3>
          <p>Add CVs to this job, then screen them to build a shortlist.</p>
          <Link href={`/${tenant}/jobs/${id}/candidates`} className="btn btn-primary" style={{ marginTop: 16 }}>
            Add candidates
          </Link>
        </>
      );
    }

    if (screened.length === 0) {
      return (
        <>
          <h3>Nothing screened yet</h3>
          <p>
            {jobCandidates.length} candidate(s) are waiting. Screening is what
            scores them and puts anyone above the threshold on this shortlist.
          </p>
          <Link href={`/${tenant}/jobs/${id}/candidates`} className="btn btn-primary" style={{ marginTop: 16 }}>
            Screen candidates
          </Link>
        </>
      );
    }

    return (
      <>
        <h3>Everyone scored below the threshold</h3>
        <p>
          All {screened.length} screened candidate(s) were archived. The best
          score was {topScore}
          {threshold !== null ? `, and the threshold is ${threshold}` : ""} — so
          nobody reached the shortlist. Lower the job&apos;s threshold, or relax
          its must-haves, and screen again.
        </p>
        <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
          <Link href={`/${tenant}/jobs/${id}`} className="btn btn-primary">Edit the job</Link>
          <Link href={`/${tenant}/jobs/${id}/candidates`} className="btn">Review candidates</Link>
        </div>
      </>
    );
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="page-head">
        <Link href={`/${tenant}/jobs/${id}`} className="subtle">&larr; Back to job</Link>
        <h1 style={{ marginTop: 6 }}>Shortlist</h1>
        <p className="muted">
          Approving the shortlist is what lets these candidates be interviewed.
          Until then the agent refuses their call.
        </p>
      </div>
      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      {shortlists.length > 1 && (
        <div className="row" style={{ marginBottom: 16 }}>
          <span className="subtle">This job has {shortlists.length} shortlists:</span>
          {shortlists.map((option) => (
            <button
              key={option.id}
              className={`sm${option.id === selectedId ? " primary" : ""}`}
              onClick={() => setSelectedId(option.id)}
              disabled={sending !== null}
            >
              {option.status}
              {option._count ? ` · ${option._count.items}` : ""}
            </button>
          ))}
        </div>
      )}
      {shortlist && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <strong>{isApproved ? "Approved" : "Not approved yet"}</strong>
              <div className="subtle">
                {isApproved
                  ? `${activeItems.length} candidate(s) cleared to call the agent`
                  : `${activeItems.length} candidate(s) waiting on approval`}
              </div>
            </div>
            <span className={`badge ${isApproved ? "badge-success" : "badge-warning"}`}>
              {shortlist.status}
            </span>
          </div>
        </div>
      )}

      {!shortlist && (
        <div className="card empty">
          <h3>No shortlist yet</h3>
          <p>
            Screen candidates first — screening is what puts them on the
            shortlist. Open the job&apos;s candidate list to run it.
          </p>
          <Link href={`/${tenant}/jobs/${id}/candidates`} className="btn btn-primary" style={{ marginTop: 16 }}>
            Go to candidates
          </Link>
        </div>
      )}

      <h3>AI-shortlisted candidates</h3>
      {activeItems.length === 0 ? (
        <div className="card empty">{emptyShortlistExplanation()}</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {activeItems.map((item) => {
            const latest = item.candidate.screenings?.[0];
            const invited = invitedUnderApproval(item.candidate);
            const hasEmail = Boolean(item.candidate.email);
            const busy = sending === item.candidateId || sending === "all";

            return (
              <li key={item.id} className="card" style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <strong>{item.candidate.name || item.candidate.email || item.candidate.phoneE164 || "Unknown"}</strong>
                  <div className="row" style={{ gap: 6 }}>
                    {invited && <span className="badge badge-success">invited</span>}
                    <button
                      className="sm"
                      disabled={!isApproved || !hasEmail || busy}
                      onClick={() => requestInterview([item.candidateId], invited)}
                      title={
                        !isApproved
                          ? "Approve the shortlist before contacting anyone"
                          : !hasEmail
                            ? "This candidate has no email address to invite"
                            : invited
                              ? "Send the interview invite to this candidate again"
                              : undefined
                      }
                    >
                      {busy
                        ? "Sending…"
                        : invited
                          ? "Send again"
                          : "Request interview"}
                    </button>
                    <button className="sm" onClick={() => updateShortlist(item.candidateId, "remove")} disabled={busy}>
                      Remove
                    </button>
                  </div>
                </div>
                <p style={{ marginBottom: 4 }}>Score {latest?.score ?? "—"} <span className="subtle">· {latest?.verdict ?? "not screened"}</span></p>
                <p className="muted" style={{ marginBottom: 0 }}>{latest?.reasonSummary ?? "No reason provided"}</p>
                {!hasEmail && (
                  <p className="subtle" style={{ marginTop: 6, marginBottom: 0, color: "var(--danger)" }}>
                    No email address — this candidate cannot be invited.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="row" style={{ marginBottom: 24 }}>
        <button
          onClick={approveShortlist}
          disabled={!shortlist || activeItems.length === 0 || isApproved}
          className="primary"
          title={
            isApproved
              ? "Already approved"
              : activeItems.length === 0
                ? "Add at least one candidate first"
                : undefined
          }
        >
          {isApproved ? "Shortlist approved" : `Approve ${activeItems.length} candidate(s)`}
        </button>

        {isApproved && (
          <button
            onClick={() => requestInterview(pending.map((item) => item.candidateId))}
            disabled={pending.length === 0 || sending !== null}
            className="primary"
            title={
              pending.length === 0
                ? "Everyone with an email address has already been invited"
                : undefined
            }
          >
            {sending === "all"
              ? "Sending invites…"
              : pending.length === 0
                ? "All invites sent"
                : `Request ${pending.length} interview(s)`}
          </button>
        )}

        {isApproved ? (
          <span className="subtle">
            These candidates can now call the agent and be interviewed.
            {withoutEmail.length > 0 &&
              ` ${withoutEmail.length} of them have no email address and cannot be invited.`}
          </span>
        ) : (
          <span className="subtle">
            Approve the shortlist to enable interview invites — no candidate is
            contacted before that.
          </span>
        )}
      </div>

      <h3>Archived</h3>
      {archivedItems.length === 0 ? (
        <p className="muted">No archived candidates.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {archivedItems.map((item) => {
            const latest = item.candidate.screenings?.[0];
            return (
              <li key={item.id} className="card" style={{ marginBottom: 12, opacity: 0.65 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <strong>{item.candidate.name || item.candidate.email || item.candidate.phoneE164 || "Unknown"}</strong>
                  <button className="sm" onClick={() => updateShortlist(item.candidateId, "add")}>
                    Add back
                  </button>
                </div>
                <p style={{ marginBottom: 4 }}>Score {latest?.score ?? "—"} <span className="subtle">· {latest?.verdict ?? "not screened"}</span></p>
                <p className="muted">{latest?.reasonSummary ?? "No reason provided"}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The endpoint reports an outcome per candidate and several of them are not
 * failures — no email address, or an invite that already went out. Saying "sent
 * 3" when two were skipped would leave the recruiter believing five people were
 * contacted.
 */
function describeSend(sent: SendResult[]): string {
  const count = (predicate: (s: SendResult) => boolean) => sent.filter(predicate).length;

  const ok = count((s) => s.status === "sent");
  const noEmail = count((s) => s.status === "skipped_no_email");
  const already = count((s) => s.status === "skipped_already_invited");
  const failed = count((s) => s.status.startsWith("failed"));

  const parts: string[] = [];
  if (ok) parts.push(`${ok} interview invite(s) sent`);
  if (already) parts.push(`${already} already invited, left alone`);
  if (noEmail) parts.push(`${noEmail} skipped with no email address`);

  if (failed) {
    // The provider's reason is the actionable part — an unverified sending
    // domain reads as "failed to send" otherwise, which sends the recruiter
    // retrying instead of to their DNS settings.
    const reason = sent.find((s) => s.status.startsWith("failed"))?.status.replace(/^failed: /, "");
    parts.push(`${failed} failed to send${reason ? ` (${reason})` : ""}`);
  }

  return parts.length ? `${parts.join(". ")}.` : "Nothing to send.";
}
