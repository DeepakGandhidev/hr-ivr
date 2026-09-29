"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { JobShellError, JobTabHeader, JobTabs, useJobSummary } from "@/components/JobShell";
import Markdown, { sentencesOf } from "@/components/Markdown";
import ScreeningDetail, { CheckIcon } from "@/components/ScreeningDetail";
import Time from "@/components/Time";
import { plural } from "@/lib/format";

interface Screening {
  id: string;
  score: number;
  verdict: string;
  reasonSummary: string;
  matchedMustHaves: string[] | null;
  gaps: string[] | null;
  createdAt: string;
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
  status?: string;
  /** Optional: a payload that forgets it must not take the page down. */
  screenings?: Screening[];
  outreachEmails?: OutreachEmail[];
  interviewCalls?: Array<{ id: string }>;
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
  approver?: { name?: string | null; email: string } | null;
}

interface Shortlist {
  id: string;
  status: string;
  createdAt?: string;
  approvals?: Approval[];
  items?: ShortlistItem[];
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

const nameOf = (c: Candidate) => c.name || c.email || c.phoneE164 || "Unknown";
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const isActive = (item: ShortlistItem) => !item.removedBy && item.finalState !== "removed";

/**
 * The shortlist: who is waiting for approval, and what happened to the people
 * approved before.
 *
 * Approval is the only path to an interview. Approving records who and when,
 * exactly as before, and then sends the invitations through the same gated
 * endpoint as always — which refuses anyone outside the approval.
 */
export default function ShortlistPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const { summary, error: summaryError, refresh } = useJobSummary();
  const [shortlists, setShortlists] = useState<Shortlist[] | null>(null);
  // Read only to explain an empty shortlist: "nothing here" reads as a fault
  // when the real answer is that everyone scored under the threshold.
  const [jobCandidates, setJobCandidates] = useState<JobCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ who: string; screening: Screening } | null>(null);

  const load = useCallback(async () => {
    try {
      fetch(`/api/${tenant}/candidates?jobId=${id}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setJobCandidates(d.candidates ?? []))
        .catch(() => {});

      const res = await fetch(`/api/${tenant}/shortlists?jobId=${id}&detail=1`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load shortlist");
      setShortlists(data.shortlists ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load shortlist");
    }
  }, [tenant, id]);

  useEffect(() => {
    load();
  }, [load]);

  async function reload() {
    await Promise.all([load(), refresh()]);
  }

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
    await reload();
  }

  /**
   * Send the interview invitations for an approved shortlist.
   *
   * No candidate ids: the endpoint takes everyone on that approved shortlist,
   * checks each against the approval snapshot, and skips anyone already
   * invited under it.
   */
  async function sendInvites(shortlistId: string): Promise<string> {
    const res = await fetch(`/api/${tenant}/shortlists/${shortlistId}/send-invites`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "The invitations could not be sent");
    return describeSend(data.sent ?? []);
  }

  async function approve(shortlist: Shortlist) {
    setApproving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/shortlists/${shortlist.id}/approve`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Failed to approve shortlist");
        return;
      }

      // Approved. The invitations follow, through the gated endpoint. Only
      // admins may send outreach; a reviewer's approval stands and an admin
      // sends from "Previously approved".
      if (summary?.permissions.canSendInvites) {
        try {
          setMessage(`Shortlist approved. ${await sendInvites(shortlist.id)}`);
        } catch (e) {
          setError(
            `Shortlist approved, but the invitations were not sent: ${
              e instanceof Error ? e.message : "unknown error"
            }. Send them from Previously approved below.`
          );
        }
      } else {
        setMessage("Shortlist approved. An admin sends the invitations from Previously approved below.");
      }
    } finally {
      setApproving(false);
      await reload();
    }
  }

  async function retryInvites(shortlistId: string) {
    setSending(shortlistId);
    setError(null);
    setMessage(null);
    try {
      setMessage(await sendInvites(shortlistId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The invitations could not be sent");
    } finally {
      setSending(null);
      await reload();
    }
  }

  if (summaryError) return <JobShellError />;

  const all = shortlists ?? [];
  const pending = all.find((s) => s.status === "draft" || s.status === "awaiting_approval") ?? null;
  const pendingItems = (pending?.items ?? []).filter(isActive);
  const removedItems = (pending?.items ?? []).filter((item) => !isActive(item));
  const approved = all.filter((s) => s.status === "approved");
  const perms = summary?.permissions;
  const threshold = summary?.config.scoreThreshold ?? 70;
  const callWindow = summary?.interview.callWindow ?? "any time the line is open";

  return (
    <div className="jm">
      <JobTabHeader
        title="Shortlist"
        intro="Approving the shortlist is what lets these candidates be interviewed. Until then, Pratibha refuses their call."
      />
      <JobTabs active="shortlist" />

      {error && <div className="notice notice-error">{error}</div>}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}

      {shortlists === null ? (
        <p className="muted">Loading…</p>
      ) : pendingItems.length > 0 && pending ? (
        // J41 — waiting for approval
        <section className="jm-card pending-card" aria-labelledby="pending-title">
          <div className="card-title-row">
            <h2 id="pending-title" className="card-title">
              Waiting for your approval · {plural(pendingItems.length, "candidate")}
            </h2>
            <span className="chip chip-amber">Not approved yet</span>
          </div>

          <ul className="pending-list">
            {pendingItems.map((item) => {
              const c = item.candidate;
              const latest = c.screenings?.[0];
              const who = nameOf(c);
              return (
                <li key={item.id} className="pending-row">
                  <div className="pending-row-head">
                    <Link href={`/${tenant}/candidates/${c.id}`} className="pending-name">
                      {who}
                    </Link>
                    {latest && (
                      <span className={`chip sm ${latest.score >= threshold ? "chip-green" : "chip-amber"}`}>
                        Score {latest.score}
                      </span>
                    )}
                    <div className="jm-spacer" />
                    {latest && (
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => setViewing({ who, screening: latest })}
                        aria-label={`Full screening for ${who}`}
                      >
                        Full screening
                      </button>
                    )}
                    {perms?.canEditShortlist && (
                      <button
                        type="button"
                        className="btn-link muted-link"
                        onClick={() => updateShortlist(item.candidateId, "remove")}
                        disabled={approving}
                        aria-label={`Remove ${who} from the shortlist`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <Evidence screening={latest} />
                  {!c.email && (
                    <p className="row-warning">No email address, so no invitation can be sent to them.</p>
                  )}
                  {!c.phoneE164 && (
                    <p className="row-warning">No phone number, so Pratibha cannot recognise their call yet.</p>
                  )}
                </li>
              );
            })}
          </ul>

          {/* J43 — the one primary action */}
          <div className="pending-actions">
            <button
              type="button"
              className="btn-ink"
              onClick={() => approve(pending)}
              disabled={approving || !perms?.canApproveShortlist}
              title={perms && !perms.canApproveShortlist ? "Only reviewers, admins and owners can approve" : undefined}
            >
              {approving ? "Approving…" : `Approve shortlist · ${plural(pendingItems.length, "candidate")}`}
            </button>
            <Link href={`/${tenant}/jobs/${id}/candidates`} className="link-strong">
              Add more from Candidates
            </Link>
          </div>

          {/* J44 — what approving will do, with live values */}
          <TransparencyStrip items={pendingItems} callWindow={callWindow} />
        </section>
      ) : approved.length > 0 ? (
        <div className="jm-card quiet-card">
          <p>
            Nobody is waiting for approval. Screening adds the candidates it suggests here.{" "}
            <Link href={`/${tenant}/jobs/${id}/candidates`}>Go to Candidates</Link>
          </p>
        </div>
      ) : (
        <div className="jm-card empty">
          <EmptyExplanation tenant={tenant} jobId={id} candidates={jobCandidates} threshold={threshold} />
        </div>
      )}

      {/* J45 — previously approved */}
      {approved.length > 0 && (
        <section aria-labelledby="approved-title">
          <h2 id="approved-title" className="section-title">
            Previously approved
          </h2>
          <ul className="approved-list">
            {approved.map((s) => (
              <ApprovedRow
                key={s.id}
                tenant={tenant}
                jobId={id}
                shortlist={s}
                canSend={Boolean(perms?.canSendInvites)}
                sending={sending === s.id}
                onSend={() => retryInvites(s.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {/* J46 — only when there is something in it */}
      {removedItems.length > 0 && (
        <section aria-labelledby="removed-title">
          <h2 id="removed-title" className="section-title">
            Removed from this shortlist
          </h2>
          <ul className="approved-list">
            {removedItems.map((item) => {
              const latest = item.candidate.screenings?.[0];
              const who = nameOf(item.candidate);
              return (
                <li key={item.id} className="approved-row">
                  <span className="approved-text">
                    <strong>{who}</strong>
                    {latest ? ` · score ${latest.score}` : ""}
                  </span>
                  <div className="jm-spacer" />
                  {perms?.canEditShortlist && (
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => updateShortlist(item.candidateId, "add")}
                      aria-label={`Add ${who} back to the shortlist`}
                    >
                      Add back
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {viewing && (
        <ScreeningDetail
          who={viewing.who}
          screening={viewing.screening}
          threshold={threshold}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

/**
 * J42 — the evidence for one candidate.
 *
 * The screening records which must haves it matched and which gaps it saw, so
 * those are the check marks: at most three, plus one caveat. Older screenings
 * without that structure fall back to sentences from the reason, shown as
 * plain lines rather than checks, because the screening never checked them.
 */
function Evidence({ screening }: { screening: Screening | undefined }) {
  if (!screening) return <p className="muted small">Not screened yet.</p>;
  const matched = asList(screening.matchedMustHaves).slice(0, 3);
  const caveat = asList(screening.gaps)[0];

  if (matched.length > 0) {
    return (
      <>
        <ul className="evidence">
          {matched.map((m, i) => (
            <li key={i}>
              <CheckIcon />
              <Markdown source={m} inline />
            </li>
          ))}
        </ul>
        {caveat && (
          <p className="caveat">
            One caveat: <Markdown source={caveat} inline />
          </p>
        )}
      </>
    );
  }

  const lines = sentencesOf(screening.reasonSummary).slice(0, 3);
  return (
    <>
      {lines.length > 0 && (
        <ul className="evidence derived" aria-label="From the screening summary">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {caveat && (
        <p className="caveat">
          One caveat: <Markdown source={caveat} inline />
        </p>
      )}
    </>
  );
}

/**
 * J44 — directly under the approve button, in live values: who the email goes
 * to, and when calls are accepted.
 */
function TransparencyStrip({ items, callWindow }: { items: ShortlistItem[]; callWindow: string }) {
  const withEmail = items.filter((item) => item.candidate.email);
  const missing = items.length - withEmail.length;
  const recipients =
    withEmail.length === 1
      ? `an invitation email goes to ${withEmail[0].candidate.email}`
      : `invitation emails go to ${plural(withEmail.length, "candidate")}`;

  return (
    <div className="strip" role="note">
      <span className="strip-text">
        {withEmail.length > 0
          ? `On approval, ${recipients} with Pratibha's number and a personal reference code. Calls are accepted ${callWindow}. Nobody is contacted before you approve.`
          : "Nobody here has an email address, so approving sends no invitation. Nobody is contacted before you approve."}
        {withEmail.length > 0 && missing > 0 && ` ${plural(missing, "candidate")} without an email address will not be invited.`}
      </span>
    </div>
  );
}

function ApprovedRow({
  tenant,
  jobId,
  shortlist,
  canSend,
  sending,
  onSend,
}: {
  tenant: string;
  jobId: string;
  shortlist: Shortlist;
  canSend: boolean;
  sending: boolean;
  onSend: () => void;
}) {
  const approval = shortlist.approvals?.[0];
  const members = (shortlist.items ?? []).filter((item) => item.finalState === "approved");
  const n = members.length;
  const interviewed = members.filter((m) => (m.candidate.interviewCalls ?? []).length > 0).length;
  const invited = members.filter((m) =>
    m.candidate.outreachEmails?.some((e) => e.approvalId === approval?.id && e.status === "sent")
  );
  const uninvited = members.filter(
    (m) => m.candidate.email && !invited.some((i) => i.candidateId === m.candidateId)
  ).length;

  let outcome: { label: string; tone: string };
  if (n === 0) outcome = { label: "No candidates", tone: "neutral" };
  else if (interviewed === n)
    outcome = { label: n === 1 ? "Interviewed" : n === 2 ? "Both interviewed" : `All ${n} interviewed`, tone: "green" };
  else if (interviewed > 0) outcome = { label: `${interviewed} of ${n} interviewed`, tone: "amber" };
  else if (invited.length === n)
    outcome = { label: n === 1 ? "Invited" : n === 2 ? "Both invited" : `All ${n} invited`, tone: "neutral" };
  else if (invited.length > 0) outcome = { label: `${invited.length} of ${n} invited`, tone: "amber" };
  else outcome = { label: "Not invited yet", tone: "clay" };

  const approver = approval?.approver?.name || approval?.approver?.email || "a teammate";

  return (
    <li className="approved-row">
      <span className="approved-text">
        {approval ? <Time value={approval.approvedAt} format="date" /> : "Approved"} · approved by {approver} ·{" "}
        {plural(n, "candidate")}
      </span>
      <span className={`chip sm chip-${outcome.tone}`}>{outcome.label}</span>
      <div className="jm-spacer" />
      {uninvited > 0 &&
        (canSend ? (
          <button type="button" className="btn-line sm" onClick={onSend} disabled={sending}>
            {sending ? "Sending…" : `Send ${uninvited === 1 ? "invitation" : "invitations"}`}
          </button>
        ) : (
          <span className="muted small">Invitations not sent yet. An admin can send them.</span>
        ))}
      {interviewed > 0 && (
        <Link href={`/${tenant}/jobs/${jobId}/interviews`} className="link-strong">
          See their reports <span aria-hidden="true">→</span>
        </Link>
      )}
    </li>
  );
}

/**
 * Why is there nobody to approve? The three answers need different actions,
 * and the same advice for all of them would be wrong for two.
 */
function EmptyExplanation({
  tenant,
  jobId,
  candidates,
  threshold,
}: {
  tenant: string;
  jobId: string;
  candidates: JobCandidate[];
  threshold: number;
}) {
  const screened = candidates.filter((c) => c.screenings?.some(Boolean));
  const topScore = screened.reduce((max, c) => Math.max(max, c.screenings?.[0]?.score ?? 0), 0);

  if (candidates.length === 0) {
    return (
      <>
        <h3>No candidates yet</h3>
        <p>Add CVs to this job, then screen them to build a shortlist.</p>
        <Link href={`/${tenant}/jobs/${jobId}/candidates`} className="btn-ink" style={{ marginTop: 16 }}>
          Add candidates
        </Link>
      </>
    );
  }

  if (screened.length === 0) {
    const n = candidates.length;
    return (
      <>
        <h3>Nothing screened yet</h3>
        <p>
          {plural(n, "candidate")} {n === 1 ? "is" : "are"} waiting. Screening is what scores them and puts anyone
          above the threshold on this shortlist.
        </p>
        <Link href={`/${tenant}/jobs/${jobId}/candidates`} className="btn-ink" style={{ marginTop: 16 }}>
          Screen candidates
        </Link>
      </>
    );
  }

  return (
    <>
      <h3>Everyone scored below the threshold</h3>
      <p>
        {screened.length === 1 ? "The screened candidate was" : `All ${screened.length} screened candidates were`} not
        suggested. The best score was {topScore}, and the threshold is {threshold}, so nobody reached the shortlist.
        Lower the job&apos;s threshold, or relax its must haves, and screen again.
      </p>
      <div className="jm-actions" style={{ justifyContent: "center", marginTop: 16 }}>
        <Link href={`/${tenant}/jobs/${jobId}/edit`} className="btn-ink">
          Edit the job
        </Link>
        <Link href={`/${tenant}/jobs/${jobId}/candidates`} className="btn-line">
          Review candidates
        </Link>
      </div>
    </>
  );
}

/**
 * The endpoint reports an outcome per candidate and several are not failures:
 * no email address, or an invite that already went out. Saying "sent 3" when
 * two were skipped would leave the recruiter believing five people were
 * contacted.
 */
function describeSend(sent: SendResult[]): string {
  const count = (predicate: (s: SendResult) => boolean) => sent.filter(predicate).length;

  const ok = count((s) => s.status === "sent");
  const noEmail = count((s) => s.status === "skipped_no_email");
  const already = count((s) => s.status === "skipped_already_invited");
  const failed = count((s) => s.status.startsWith("failed"));

  const parts: string[] = [];
  if (ok) parts.push(`${plural(ok, "invitation")} sent`);
  if (already) parts.push(`${already} already invited, left alone`);
  if (noEmail) parts.push(`${noEmail} skipped with no email address`);

  if (failed) {
    // The provider's reason is the actionable part — an unverified sending
    // domain reads as "failed to send" otherwise.
    const reason = sent.find((s) => s.status.startsWith("failed"))?.status.replace(/^failed: /, "");
    parts.push(`${failed} failed to send${reason ? ` (${reason})` : ""}`);
  }

  return parts.length ? `${parts.join(". ")}.` : "Nothing to send.";
}
