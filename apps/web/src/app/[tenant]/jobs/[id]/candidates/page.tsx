"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AddCandidates from "@/components/AddCandidates";
import ActionMenu, { type ActionMenuItem } from "@/components/ActionMenu";
import Dialog from "@/components/Dialog";
import EmailCandidate from "@/components/EmailCandidate";
import ScreeningDetail from "@/components/ScreeningDetail";
import { CandidateStatusBadge } from "@/components/CandidateStatus";
import { JobShellError, JobTabHeader, JobTabs, useJobSummary, verdictLabel } from "@/components/JobShell";
import { firstLine } from "@/components/Markdown";
import { useToast } from "@/components/Toast";
import { plural, timeAgo } from "@/lib/format";
import { CANDIDATE_STATUSES, CANDIDATE_STATUS_LABELS, type CandidateStatus } from "@pratibha/shared";

interface Screening {
  id: string;
  score: number;
  verdict: string;
  reasonSummary: string;
  matchedMustHaves: string[] | null;
  gaps: string[] | null;
  failed?: boolean;
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
  noPhone?: boolean;
  parseFailed?: boolean;
  cvParsed?: Record<string, unknown> | null;
  createdAt: string;
  status: CandidateStatus;
  screenings: Screening[];
  shortlistItems: Array<{
    id: string;
    finalState: string | null;
    removedBy?: string | null;
    shortlist: { id: string; status: string };
  }>;
  interviewCalls?: Array<{ id: string; assessmentReport: { id: string } | null }>;
}

type Sort = "score" | "newest" | "name";

const nameOf = (c: Candidate) => c.name || c.email || "Unnamed candidate";

/**
 * A job's candidates.
 *
 * One primary action per row, chosen by where the candidate stands, and
 * everything else in the row's three-dot menu — so the table fits a 1280px
 * screen without scrolling sideways.
 */
export default function CandidatesPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const missingPhoneOnly = searchParams.get("missing") === "phone";
  const { summary, error: summaryError, refresh } = useJobSummary();
  const toast = useToast();

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<CandidateStatus | "all">("all");
  const [sort, setSort] = useState<Sort>("score");

  // Dialogs
  const [emailing, setEmailing] = useState<Candidate | null>(null);
  const [viewing, setViewing] = useState<{ candidate: Candidate; screening: Screening } | null>(null);
  const [staging, setStaging] = useState<Candidate | null>(null);
  const [moving, setMoving] = useState<Candidate | null>(null);
  const [phoning, setPhoning] = useState<Candidate | null>(null);

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

  // The move target list. Failures are silent: this only powers a dialog, and
  // an error banner here would look like the candidate list itself had failed.
  useEffect(() => {
    fetch(`/api/${tenant}/jobs`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setJobs(d.jobs ?? []))
      .catch(() => {});
  }, [tenant]);

  /** Re-read the rows and the tab counts after anything that changes them. */
  async function reload() {
    await Promise.all([load(), refresh()]);
  }

  /**
   * Add or remove one candidate from this job's draft shortlist.
   *
   * The draft shortlist only. This sends nothing to the candidate: outreach
   * needs an approval, which is a separate deliberate step on the Shortlist tab.
   */
  async function toggleShortlist(candidate: Candidate, add: boolean) {
    setBusy(candidate.id);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/shortlists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id, action: add ? "add" : "remove" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not update the shortlist");
      await reload();
      toast.show(
        add
          ? `${nameOf(candidate)} added to the shortlist. Nothing has been sent to them.`
          : `${nameOf(candidate)} removed from the shortlist.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the shortlist");
    } finally {
      setBusy(null);
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

  async function screenCandidate(candidate: Candidate) {
    setBusy(candidate.id);
    setError(null);
    setMessage(null);
    const ok = await screenOne(candidate.id);
    setBusy(null);
    if (ok) {
      await reload();
      toast.show(`${nameOf(candidate)} screened.`);
    }
  }

  async function screenAll() {
    const pending = candidates.filter((c) => (c.screenings?.length ?? 0) === 0);
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
    await reload();
    setMessage(`Screened ${done} of ${pending.length}.`);
  }

  const threshold = summary?.config.scoreThreshold ?? 70;
  // Suggested is the score against today's threshold (the job's own, or the
  // platform setting), not the verdict stored when the CV was screened, so a
  // threshold change in the admin panel moves the chips without re-screening.
  const suggested = (s: { score: number; failed?: boolean } | null | undefined) => Boolean(s && !s.failed && s.score >= threshold);
  const perms = summary?.permissions;
  const waiting = summary?.counts.awaitingApproval ?? 0;

  const unscreened = candidates.filter((c) => (c.screenings?.length ?? 0) === 0);
  const lastNewCv = candidates.reduce<string | null>(
    (latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest),
    null
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = candidates.filter((c) => {
      if (missingPhoneOnly && c.phoneE164) return false;
      if (stage !== "all" && c.status !== stage) return false;
      if (!q) return true;
      return [c.name, c.email, c.phoneE164].some((v) => v?.toLowerCase().includes(q));
    });
    const score = (c: Candidate) => c.screenings?.[0]?.score ?? -1;
    const compare: Record<Sort, (a: Candidate, b: Candidate) => number> = {
      score: (a, b) => score(b) - score(a) || b.createdAt.localeCompare(a.createdAt),
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => nameOf(a).localeCompare(nameOf(b)),
    };
    return [...rows].sort(compare[sort]);
  }, [candidates, query, stage, sort, missingPhoneOnly]);

  if (summaryError) return <JobShellError />;

  const otherJobs = jobs.filter((j) => j.id !== id);

  return (
    <div className="jm">
      <JobTabHeader
        title="Candidates"
        intro="Screening scores each CV against the job's must haves. Anyone it suggests moves to the Shortlist tab for your approval."
        actions={perms?.canAddCandidates ? <AddCandidates tenant={tenant} jobId={id} onAdded={reload} /> : undefined}
      />
      <JobTabs active="candidates" />

      {error && <div className="notice notice-error">{error}</div>}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}

      {/* J33 — toolbar */}
      <div className="jm-toolbar">
        <input
          type="search"
          className="jm-search"
          placeholder="Search candidates"
          aria-label="Search candidates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="jm-select">
          <span className="jm-select-label">Stage</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as CandidateStatus | "all")}>
            <option value="all">All</option>
            {CANDIDATE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CANDIDATE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="jm-select">
          <span className="jm-select-label">Sort</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="score">Score</option>
            <option value="newest">Newest</option>
            <option value="name">Name</option>
          </select>
        </label>
        <div className="jm-spacer" />
        {waiting > 0 && (
          <Link href={`/${tenant}/jobs/${id}/shortlist`} className="saffron-link">
            {waiting} waiting for approval <span aria-hidden="true">→</span> Go to shortlist
          </Link>
        )}
      </div>

      {/* J34 — quiet status, or the one bulk action when there is work */}
      {candidates.length > 0 && (
        <div className="status-line">
          {bulk ? (
            <span role="status">
              Screening {bulk.done} of {bulk.total}…
            </span>
          ) : unscreened.length === 0 ? (
            <span>
              All {candidates.length} screened
              {lastNewCv && ` · last new CV ${timeAgo(lastNewCv)}`}
            </span>
          ) : (
            <>
              {perms?.canScreen && (
                <button type="button" className="btn-ink sm" onClick={screenAll}>
                  Screen {unscreened.length} unscreened
                </button>
              )}
              <span>
                {candidates.length - unscreened.length} of {plural(candidates.length, "candidate")} screened
                {lastNewCv && ` · last new CV ${timeAgo(lastNewCv)}`}
              </span>
            </>
          )}
        </div>
      )}

      {missingPhoneOnly && (
        <div className="notice notice-info filter-note">
          <span>
            Showing candidates whose CV arrived without a phone number. Pratibha recognises candidates by their number
            when they call, so add one from the row&apos;s menu.
          </span>
          <button type="button" className="btn-link" onClick={() => router.replace(pathname)}>
            Show everyone
          </button>
        </div>
      )}

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : candidates.length === 0 ? (
        <div className="jm-card empty">
          <h3>No candidates yet</h3>
          <p>
            Add CVs, one or a whole folder at a time, or connect a mailbox and applications will be imported and
            parsed automatically as they arrive.
          </p>
          <Link href={`/${tenant}/settings/email`} className="btn-line" style={{ marginTop: 16 }}>
            Connect a mailbox
          </Link>
        </div>
      ) : shown.length === 0 ? (
        <div className="jm-card empty">
          <p>No candidates match these filters.</p>
        </div>
      ) : (
        <div className="jm-card flush">
          <table className="rtable cand-table">
            <caption className="visually-hidden">Candidates for {summary?.job.title ?? "this job"}</caption>
            <colgroup>
              <col className="c-name" />
              <col className="c-score" />
              <col className="c-screen" />
              <col className="c-stage" />
              <col />
              <col className="c-actions" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Score</th>
                <th scope="col">Screening</th>
                <th scope="col">Stage</th>
                <th scope="col">Why</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((candidate) => {
                const latest = candidate.screenings?.[0];
                const who = nameOf(candidate);
                // Removal is recorded rather than deleted, so a row's presence
                // is not the answer on its own.
                const activeItems = candidate.shortlistItems.filter(
                  (item) => item.finalState !== "removed" && !item.removedBy
                );
                const onShortlist = activeItems.length > 0;
                const approved = activeItems.some(
                  (item) => item.finalState === "approved" && item.shortlist.status === "approved"
                );
                const report = candidate.interviewCalls?.find((c) => c.assessmentReport)?.assessmentReport ?? null;
                const rowBusy = busy === candidate.id || Boolean(bulk);
                const noPhone = !candidate.phoneE164;

                // J32 — one primary per row, by state.
                let primary: React.ReactNode = null;
                if (report) {
                  primary = (
                    <Link
                      href={`/${tenant}/jobs/${id}/interviews?report=${report.id}`}
                      className="btn-line sm"
                      aria-label={`View interview report for ${who}`}
                    >
                      View report
                    </Link>
                  );
                } else if (!latest) {
                  if (perms?.canScreen) {
                    primary = (
                      <button
                        type="button"
                        className="btn-line sm"
                        disabled={rowBusy}
                        onClick={() => screenCandidate(candidate)}
                        aria-label={`Screen ${who}`}
                      >
                        {busy === candidate.id ? "Screening…" : "Screen"}
                      </button>
                    );
                  }
                } else if (onShortlist) {
                  primary = <span className="row-state">{approved ? "Approved" : "On shortlist"}</span>;
                } else if (suggested(latest) && perms?.canEditShortlist) {
                  primary = (
                    <button
                      type="button"
                      className="btn-ink sm"
                      disabled={rowBusy}
                      onClick={() => toggleShortlist(candidate, true)}
                      aria-label={`Shortlist ${who}`}
                    >
                      {busy === candidate.id ? "…" : "Shortlist"}
                    </button>
                  );
                }

                const menu: ActionMenuItem[] = [
                  ...(latest
                    ? [{ label: "View screening", onSelect: () => setViewing({ candidate, screening: latest }) }]
                    : []),
                  {
                    label: "Email",
                    disabled: !candidate.email || rowBusy,
                    hint: candidate.email ? undefined : "No email address on file",
                    onSelect: () => setEmailing(candidate),
                  },
                  ...(perms?.canScreen
                    ? [
                        {
                          label: latest ? "Screen again" : "Screen",
                          disabled: rowBusy,
                          onSelect: () => screenCandidate(candidate),
                        },
                      ]
                    : []),
                  ...(perms?.canEditShortlist && latest && !onShortlist && !suggested(latest)
                    ? [{ label: "Add to shortlist", onSelect: () => toggleShortlist(candidate, true) }]
                    : []),
                  ...(perms?.canEditShortlist && onShortlist && !approved
                    ? [{ label: "Remove from shortlist", onSelect: () => toggleShortlist(candidate, false) }]
                    : []),
                  ...(perms?.canChangeStatus ? [{ label: "Move to stage", onSelect: () => setStaging(candidate) }] : []),
                  ...(perms?.canUpdateCandidate && otherJobs.length > 0
                    ? [{ label: "Move to another job", onSelect: () => setMoving(candidate) }]
                    : []),
                  ...(perms?.canUpdateCandidate && noPhone
                    ? [{ label: "Add phone number", onSelect: () => setPhoning(candidate) }]
                    : []),
                  { label: "Open candidate page", href: `/${tenant}/candidates/${candidate.id}` },
                ];

                return (
                  <tr key={candidate.id}>
                    <td data-label="Candidate">
                      <div className="cell-name">
                        <Link href={`/${tenant}/candidates/${candidate.id}`}>
                          {candidate.name || <span className="text-danger">Could not parse</span>}
                        </Link>
                      </div>
                      <div className="cell-sub">{candidate.email || "No email"}</div>
                      {(noPhone || candidate.routedBy === "fallback") && (
                        <div className="cell-flags">
                          {noPhone && <span className="chip sm chip-clay">No phone</span>}
                          {candidate.routedBy === "fallback" && (
                            // The router could not match this application to a
                            // job and filed it here as a last resort.
                            <span className="chip sm chip-amber">Filed here as fallback</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td data-label="Score">
                      {latest ? (
                        <div className="score-cell">
                          <span className="score-n">{latest.score}</span>
                          <span className="score-bar" aria-hidden="true">
                            <i
                              className={latest.score >= threshold ? "ok" : "warn"}
                              style={{ width: `${Math.max(2, Math.min(100, latest.score))}%` }}
                            />
                          </span>
                        </div>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="Screening">
                      {latest?.failed ? (
                        <span className="chip chip-clay">Screening failed</span>
                      ) : (
                        <span
                          className={`chip ${
                            suggested(latest) ? "chip-green" : "chip-neutral"
                          }`}
                        >
                          {verdictLabel(latest ? (suggested(latest) ? "shortlist" : "archive") : null)}
                        </span>
                      )}
                    </td>
                    <td data-label="Stage">
                      <CandidateStatusBadge status={candidate.status} />
                    </td>
                    <td data-label="Why">
                      {latest ? (
                        <div className="why-cell">
                          <span className="why-text" title={firstLine(latest.reasonSummary)}>
                            {firstLine(latest.reasonSummary) || "No reason recorded."}
                          </span>
                          <button
                            type="button"
                            className="btn-link"
                            onClick={() => setViewing({ candidate, screening: latest })}
                            aria-label={`View the full screening for ${who}`}
                          >
                            View
                          </button>
                        </div>
                      ) : (
                        <span className="muted">Not screened yet</span>
                      )}
                    </td>
                    <td data-label="Actions" className="cell-actions">
                      <div className="row-actions">
                        {primary}
                        <ActionMenu label={`More actions for ${who}`} items={menu} size="sm" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shown.length !== candidates.length && candidates.length > 0 && (
        <p className="table-foot">
          Showing {shown.length} of {plural(candidates.length, "candidate")}
        </p>
      )}

      {viewing && (
        <ScreeningDetail
          who={nameOf(viewing.candidate)}
          screening={viewing.screening}
          threshold={threshold}
          onClose={() => setViewing(null)}
        />
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

      {staging && (
        <MoveStageDialog
          tenant={tenant}
          candidate={staging}
          onClose={() => setStaging(null)}
          onDone={async (label) => {
            setStaging(null);
            await reload();
            toast.show(`${nameOf(staging)} moved to ${label}.`);
          }}
        />
      )}

      {moving && (
        <MoveJobDialog
          tenant={tenant}
          candidate={moving}
          jobs={otherJobs}
          onClose={() => setMoving(null)}
          onDone={async (text) => {
            setMoving(null);
            await reload();
            router.refresh();
            setMessage(text);
          }}
        />
      )}

      {phoning && (
        <PhoneDialog
          tenant={tenant}
          candidate={phoning}
          onClose={() => setPhoning(null)}
          onDone={async (phone) => {
            setPhoning(null);
            await reload();
            toast.show(`Saved ${phone} for ${nameOf(phoning)}.`);
          }}
        />
      )}

      {toast.node}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row dialogs
// ---------------------------------------------------------------------------

async function send(url: string, method: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/** Pipeline stage, set by hand. Recorded with who and when, as on the candidate page. */
function MoveStageDialog({
  tenant,
  candidate,
  onClose,
  onDone,
}: {
  tenant: string;
  candidate: Candidate;
  onClose: () => void;
  onDone: (label: string) => void;
}) {
  const [status, setStatus] = useState<CandidateStatus>(candidate.status);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (status === candidate.status) return onClose();
    setBusy(true);
    setError(null);
    const { ok, data } = await send(`/api/${tenant}/candidates/${candidate.id}/status`, "PATCH", {
      status,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    setBusy(false);
    if (!ok) return setError(String(data.message ?? "Could not change the stage"));
    onDone(CANDIDATE_STATUS_LABELS[status]);
  }

  return (
    <Dialog title={`Move ${nameOf(candidate)} to a stage`} onClose={onClose} busy={busy}>
      <form onSubmit={save} className="stack">
        <div>
          <label htmlFor="stage-select">Stage</label>
          <select id="stage-select" value={status} onChange={(e) => setStatus(e.target.value as CandidateStatus)}>
            {CANDIDATE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {CANDIDATE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="stage-reason">Why (optional, shown on their timeline)</label>
          <input id="stage-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="muted small">
          Moving someone to Shortlisted here does not approve them or contact them. Approval happens on the Shortlist
          tab.
        </p>
        {error && <div className="notice notice-error">{error}</div>}
        <div className="jm-dialog-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-ink" disabled={busy}>
            {busy ? "Saving…" : "Move"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function MoveJobDialog({
  tenant,
  candidate,
  jobs,
  onClose,
  onDone,
}: {
  tenant: string;
  candidate: Candidate;
  jobs: Job[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [jobId, setJobId] = useState(jobs[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!jobId) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await send(`/api/${tenant}/candidates/${candidate.id}`, "PATCH", { jobId });
    setBusy(false);
    if (!ok) return setError(String(data.message ?? "Could not move this candidate"));
    onDone(
      `Moved to ${data.movedTo}.` +
        (data.discardedScreenings ? " Their previous score was cleared; screen them again for the new role." : "")
    );
  }

  return (
    <Dialog title={`Move ${nameOf(candidate)} to another job`} onClose={onClose} busy={busy}>
      <form onSubmit={save} className="stack">
        <div>
          <label htmlFor="move-job">Job</label>
          <select id="move-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
              </option>
            ))}
          </select>
        </div>
        <p className="muted small">
          Their screening and shortlist place for this role are cleared, because they were judged against this
          role&apos;s requirements.
        </p>
        {error && <div className="notice notice-error">{error}</div>}
        <div className="jm-dialog-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-ink" disabled={busy || !jobId}>
            {busy ? "Moving…" : "Move"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function PhoneDialog({
  tenant,
  candidate,
  onClose,
  onDone,
}: {
  tenant: string;
  candidate: Candidate;
  onClose: () => void;
  onDone: (phone: string) => void;
}) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, data } = await send(`/api/${tenant}/candidates/${candidate.id}/phone`, "PATCH", { phone });
    setBusy(false);
    if (!ok) return setError(String(data.message ?? "Could not save the number"));
    const saved = (data.candidate as { phoneE164?: string } | undefined)?.phoneE164 ?? phone;
    onDone(saved);
  }

  return (
    <Dialog title={`Add a phone number for ${nameOf(candidate)}`} onClose={onClose} busy={busy}>
      <form onSubmit={save} className="stack">
        <div>
          <label htmlFor="cand-phone">Phone number</label>
          <input
            id="cand-phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>
        <p className="muted small">
          Pratibha recognises candidates by this number when they call. Adding it contacts nobody.
        </p>
        {error && <div className="notice notice-error">{error}</div>}
        <div className="jm-dialog-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-ink" disabled={busy || !phone.trim()}>
            {busy ? "Saving…" : "Save number"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
