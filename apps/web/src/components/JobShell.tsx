"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { plural } from "@/lib/format";
import Time from "@/components/Time";

// ---------------------------------------------------------------------------
// Types — the shape of GET /api/[tenant]/jobs/[id]/summary
// ---------------------------------------------------------------------------

export type PublishState = "live" | "live_edited" | "draft" | "archived";

export interface JobCounts {
  applications: number;
  screened: number;
  shortlisted: number;
  awaitingApproval: number;
  interviewed: number;
  recommended: number;
  missingPhone: number;
}

export interface PublishInfo {
  state: PublishState;
  publishedAt: string | null;
  firstPublishedAt: string | null;
  jdChangedAt: string | null;
  latestVersion: { id: string; version: number; approved: boolean; createdAt: string } | null;
}

export interface Attention {
  kind: "approval" | "republish" | "missing_phone" | "not_published";
  count?: number;
  date?: string | null;
  action: string;
  tab: string;
}

export type Permission =
  | "canEdit"
  | "canArchive"
  | "canPublish"
  | "canApproveJd"
  | "canApproveShortlist"
  | "canEditShortlist"
  | "canSendInvites"
  | "canScreen"
  | "canChangeStatus"
  | "canUpdateCandidate"
  | "canAddCandidates"
  | "canEditInterview";

export interface JobSummary {
  job: {
    id: string;
    title: string;
    slug: string;
    status: string;
    location: string | null;
    salaryBand: string | null;
    experienceRange: string | null;
    mustHaves: string[];
    goodToHaves: string[];
    screeningThreshold: number | null;
    createdAt: string;
  };
  counts: JobCounts;
  publish: PublishInfo;
  attention: Attention | null;
  interview: {
    durationMinutes: number;
    difficulty: string;
    focusAreas: string[];
    languages: string[];
    callWindow: string;
    source: "job" | "workspace" | "default";
  };
  jd: {
    id: string;
    version: number;
    bodyMd: string;
    generatedBy: string;
    approvedAt: string | null;
    createdAt: string;
  } | null;
  jdVersionCount: number;
  config: { scoreThreshold: number; scoreGapThreshold: number; portalPosts: boolean };
  permissions: Record<Permission, boolean>;
}

// ---------------------------------------------------------------------------
// Provider — mounted by jobs/[id]/layout.tsx so it survives tab switches
// ---------------------------------------------------------------------------

interface Ctx {
  tenant: string;
  jobId: string;
  summary: JobSummary | null;
  error: string | null;
  /** Re-read the counts and state, after anything that changes them. */
  refresh: () => Promise<void>;
  subscribe: () => void;
}

const SummaryContext = createContext<Ctx | null>(null);

export function JobSummaryProvider({
  tenant,
  jobId,
  children,
}: {
  tenant: string;
  jobId: string;
  children: ReactNode;
}) {
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  const pathname = usePathname();
  const inFlight = useRef(0);

  const refresh = useCallback(async () => {
    const ticket = ++inFlight.current;
    try {
      const res = await fetch(`/api/${tenant}/jobs/${jobId}/summary`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      // A slower, older response must not overwrite a newer one.
      if (ticket !== inFlight.current) return;
      if (!res.ok) {
        setError(data.message || "Could not load this job");
        return;
      }
      setError(null);
      setSummary(data as JobSummary);
    } catch {
      if (ticket === inFlight.current) setError("Could not load this job");
    }
  }, [tenant, jobId]);

  const subscribe = useCallback(() => setWanted(true), []);

  // Fetched only once something on the page reads it (the edit page shares
  // this layout and does not), and again on every tab switch so counts changed
  // on one tab are right on the next.
  useEffect(() => {
    if (wanted) refresh();
  }, [wanted, pathname, refresh]);

  // Coming back to the browser tab should not show stale counts either.
  useEffect(() => {
    if (!wanted) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [wanted, refresh]);

  return (
    <SummaryContext.Provider value={{ tenant, jobId, summary, error, refresh, subscribe }}>
      {children}
    </SummaryContext.Provider>
  );
}

export function useJobSummary() {
  const ctx = useContext(SummaryContext);
  if (!ctx) throw new Error("useJobSummary must be used inside JobSummaryProvider");
  const { subscribe } = ctx;
  useEffect(() => {
    subscribe();
  }, [subscribe]);
  return ctx;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const CHIP: Record<PublishState, { label: string; tone: string }> = {
  live: { label: "Live", tone: "green" },
  live_edited: { label: "Live · edited", tone: "amber" },
  draft: { label: "Draft", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export function PublishChip({ state }: { state: PublishState }) {
  const c = CHIP[state];
  return <span className={`chip chip-${c.tone}`}>{c.label}</span>;
}

/** Screening verdicts, as people read them. The stored enums are unchanged. */
export function verdictLabel(verdict: string | null | undefined): string {
  if (verdict === "shortlist") return "Suggested";
  if (verdict === "archive") return "Not suggested";
  return "Not screened";
}

/** Interview recommendations, as people read them. Stored values unchanged. */
export function recommendationChip(recommendation: string | null | undefined): { label: string; tone: string } {
  if (recommendation === "no") return { label: "Do not pursue", tone: "clay" };
  if (recommendation === "maybe") return { label: "Maybe", tone: "amber" };
  if (recommendation === "yes" || recommendation === "strong_yes" || recommendation === "advance") {
    return { label: "Advance", tone: "green" };
  }
  return { label: "Not recorded", tone: "neutral" };
}

// ---------------------------------------------------------------------------
// Attention copy — shipped verbatim from the change request's appendix
// ---------------------------------------------------------------------------

export function attentionText(a: Attention): ReactNode {
  const n = a.count ?? 0;
  switch (a.kind) {
    case "approval":
      return approvalStripText(n);
    case "republish":
      return (
        <>
          The JD changed on <Time value={a.date ?? null} format="date" />. The public page shows the older version.
        </>
      );
    case "missing_phone":
      return `${plural(n, "CV")} arrived without a phone number.`;
    case "not_published":
      return "Not on your job page yet.";
  }
}

export function approvalStripText(n: number): string {
  return `${plural(n, "shortlisted CV")} ${n === 1 ? "is" : "are"} waiting for your approval. Nobody is contacted until you say so.`;
}

// ---------------------------------------------------------------------------
// Header and tabs
// ---------------------------------------------------------------------------

export type JobTab = "studio" | "candidates" | "shortlist" | "publish" | "interviews";

export function JobTabs({ active }: { active: JobTab }) {
  const { tenant, jobId, summary } = useJobSummary();
  const c = summary?.counts;
  const base = `/${tenant}/jobs/${jobId}`;
  const tabs: Array<{ key: JobTab; label: string; href: string; count?: number; countLabel?: string }> = [
    { key: "studio", label: "JD Studio", href: base },
    { key: "candidates", label: "Candidates", href: `${base}/candidates`, count: c?.applications, countLabel: "candidates" },
    {
      key: "shortlist",
      label: "Shortlist",
      href: `${base}/shortlist`,
      count: c?.awaitingApproval,
      countLabel: "waiting for approval",
    },
    { key: "publish", label: "Publish", href: `${base}/publish` },
    { key: "interviews", label: "Interviews", href: `${base}/interviews`, count: c?.interviewed, countLabel: "interviewed" },
  ];

  return (
    <nav className="job-tabs" aria-label="Job sections">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className="job-tab"
          aria-current={active === t.key ? "page" : undefined}
          aria-label={t.count !== undefined ? `${t.label}, ${t.count} ${t.countLabel}` : undefined}
        >
          {t.label}
          {t.count !== undefined && <span aria-hidden="true"> · {t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The top of every job tab except the hub: a way back to the job, the tab's
 * own heading and intro, and the tab's actions on the right.
 */
export function JobTabHeader({
  title,
  intro,
  actions,
}: {
  title: string;
  intro?: ReactNode;
  actions?: ReactNode;
}) {
  const { tenant, jobId, summary } = useJobSummary();
  return (
    <div className="job-head">
      <Link href={`/${tenant}/jobs/${jobId}`} className="job-back">
        <span aria-hidden="true">←</span> {summary?.job.title ?? "Job"}
      </Link>
      <div className="job-head-row">
        <div className="job-head-text">
          <h1>{title}</h1>
          {intro && <p className="job-intro">{intro}</p>}
        </div>
        {actions && <div className="job-head-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Shown instead of a tab when the job cannot be loaded. */
export function JobShellError() {
  const { tenant, error } = useJobSummary();
  if (!error) return null;
  return (
    <div className="jm-card empty">
      <h3>Job not found</h3>
      <p>{error}. It may have been archived, or belong to another workspace.</p>
      <Link href={`/${tenant}/jobs`} className="btn-line" style={{ marginTop: 16 }}>
        Back to jobs
      </Link>
    </div>
  );
}
