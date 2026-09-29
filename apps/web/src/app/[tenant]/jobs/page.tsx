"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ActionMenu, { type ActionMenuItem } from "@/components/ActionMenu";
import { useArchiveJob } from "@/components/JobActions";
import {
  attentionText,
  PublishChip,
  type Attention,
  type JobCounts,
  type PublishInfo,
} from "@/components/JobShell";
import { copyText, useToast } from "@/components/Toast";
import { daysBetween, plural, timeAgo } from "@/lib/format";
import Time from "@/components/Time";

interface CardJob {
  id: string;
  title: string;
  slug: string;
  status: string;
  location?: string | null;
  createdAt: string;
  deletedAt?: string | null;
  counts: JobCounts;
  publish: PublishInfo;
  attention: Attention | null;
}

type View = "open" | "archived";
type Sort = "newest" | "applications" | "longest";

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "applications", label: "Most applications" },
  { value: "longest", label: "Longest open" },
];

/** When a role went public, or was created if it never has. */
const openSince = (j: CardJob) => j.publish.firstPublishedAt ?? j.createdAt;

/**
 * The Jobs list: one card per role, carrying the state of hiring for it.
 *
 * Fetched in the browser rather than rendered on the server, so coming back
 * here after editing a JD shows the new "Live · edited" state straight away
 * instead of a cached render.
 */
export default function JobsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [view, setView] = useState<View>("open");
  const [jobs, setJobs] = useState<CardJob[] | null>(null);
  const [tabs, setTabs] = useState<{ open: number; archived: number } | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/${tenant}/jobs?insights=1${view === "archived" ? "&archived=1" : ""}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not load your jobs");
      setJobs(data.jobs ?? []);
      setTabs(data.tabs ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your jobs");
    }
  }, [tenant, view]);

  useEffect(() => {
    setJobs(null);
    load();
  }, [load]);

  // Work done in another browser tab (a JD edited, a shortlist approved)
  // should be reflected when the person comes back.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRole(d?.user?.role ?? null))
      .catch(() => {});
  }, []);

  const isAdmin = role === "admin" || role === "owner";

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (jobs ?? []).filter((j) => !q || j.title.toLowerCase().includes(q));
    const by: Record<Sort, (a: CardJob, b: CardJob) => number> = {
      newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
      applications: (a, b) => b.counts.applications - a.counts.applications || b.createdAt.localeCompare(a.createdAt),
      longest: (a, b) => openSince(a).localeCompare(openSince(b)),
    };
    return [...list].sort(by[sort]);
  }, [jobs, query, sort]);

  const noJobsAtAll = tabs !== null && tabs.open === 0 && tabs.archived === 0;

  return (
    <div className="jm jobs-page">
      <div className="job-head">
        <div className="job-head-row">
          <div className="job-head-text">
            <h1>Jobs</h1>
            <p className="job-intro">Roles you are hiring for. Applications are filed against these.</p>
          </div>
          <div className="job-head-actions">
            <Link href={`/${tenant}/jobs/new`} className="btn-ink">
              New job
            </Link>
          </div>
        </div>
      </div>

      {error && <div className="notice notice-error">{error}</div>}

      {noJobsAtAll ? (
        <div className="jm-card empty">
          <h3>No jobs yet</h3>
          <p>
            Create a job first. Applications need a role to be filed against before a mailbox can import them.
          </p>
          <Link href={`/${tenant}/jobs/new`} className="btn-ink" style={{ marginTop: 16 }}>
            Create your first job
          </Link>
        </div>
      ) : (
        <>
          <div className="jm-toolbar">
            <div className="seg" role="group" aria-label="Which roles">
              <button type="button" aria-pressed={view === "open"} onClick={() => setView("open")}>
                Open · {tabs?.open ?? "…"}
              </button>
              <button type="button" aria-pressed={view === "archived"} onClick={() => setView("archived")}>
                Archived · {tabs?.archived ?? "…"}
              </button>
            </div>
            <input
              type="search"
              className="jm-search"
              placeholder="Search roles"
              aria-label="Search roles"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="jm-spacer" />
            <label className="jm-select">
              <span className="visually-hidden">Sort roles</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {jobs === null ? (
            <p className="muted">Loading…</p>
          ) : shown.length === 0 ? (
            <div className="jm-card empty">
              <p>
                {query.trim()
                  ? `No ${view === "archived" ? "archived " : ""}roles match “${query.trim()}”.`
                  : view === "archived"
                    ? "No archived roles."
                    : "No open roles. Archived ones are under the Archived tab."}
              </p>
            </div>
          ) : (
            <div className="jobs-grid">
              {shown.map((job) => (
                <JobCard
                  key={job.id}
                  tenant={tenant}
                  job={job}
                  canEdit={isAdmin}
                  canArchive={isAdmin}
                  onArchived={() => {
                    setJobs((prev) => (prev ?? []).filter((j) => j.id !== job.id));
                    setTabs((t) => (t ? { open: t.open - 1, archived: t.archived + 1 } : t));
                    toast.show(`${job.title} archived`);
                  }}
                  onCopied={(ok) => toast.show(ok ? "Job page link copied" : "Could not copy the link")}
                />
              ))}
            </div>
          )}
        </>
      )}
      {toast.node}
    </div>
  );
}

function JobCard({
  tenant,
  job,
  canEdit,
  canArchive,
  onArchived,
  onCopied,
}: {
  tenant: string;
  job: CardJob;
  canEdit: boolean;
  canArchive: boolean;
  onArchived: () => void;
  onCopied: (ok: boolean) => void;
}) {
  const router = useRouter();
  const base = `/${tenant}/jobs/${job.id}`;
  const archived = job.publish.state === "archived";
  const isPublic = job.publish.state === "live" || job.publish.state === "live_edited";
  const archive = useArchiveJob({
    tenant,
    jobId: job.id,
    title: job.title,
    candidateCount: job.counts.applications,
    onArchived,
  });

  const since = archived
    ? null
    : job.publish.firstPublishedAt
      ? `Open ${plural(daysBetween(job.publish.firstPublishedAt), "day")}`
      : `Created ${timeAgo(job.createdAt)}`;

  const menu: ActionMenuItem[] = [
    {
      label: "Copy job page link",
      disabled: !isPublic,
      hint: "Not published yet",
      onSelect: async () => onCopied(await copyText(`${window.location.origin}/j/${job.slug}`)),
    },
    ...(canArchive ? [{ label: "Archive", danger: true, onSelect: archive.request }] : []),
  ];

  return (
    <article
      className={`job-card${archived ? " is-archived" : ""}`}
      // The whole card opens the job for a pointer; keyboard users get the
      // title link, which is the same destination.
      onClick={(e) => {
        if (archived) return;
        const t = e.target as HTMLElement;
        // Controls, the menu and the archive dialog handle their own clicks.
        if (t.closest("a, button, input, select, [role='menu'], .modal-backdrop")) return;
        router.push(base);
      }}
    >
      <div className="job-card-top">
        {archived ? (
          <h2 className="job-card-title">{job.title}</h2>
        ) : (
          <h2 className="job-card-title">
            <Link href={base}>{job.title}</Link>
          </h2>
        )}
        <PublishChip state={job.publish.state} />
      </div>

      <div className="job-card-meta">
        {job.location || "Location not set"}
        {since && ` · ${since}`}
        {archived && job.deletedAt && (
          <>
            {" · Archived "}
            <Time value={job.deletedAt} format="date" />
          </>
        )}
      </div>

      <dl className="job-card-stats">
        <div>
          <dt>Applications</dt>
          <dd>{job.counts.applications}</dd>
        </div>
        <div>
          <dt>Screened</dt>
          <dd>{job.counts.screened}</dd>
        </div>
        <div>
          <dt>Interviewed</dt>
          <dd>{job.counts.interviewed}</dd>
        </div>
      </dl>

      {job.attention && (
        <div className="strip strip-card">
          <span className="strip-text">{attentionText(job.attention)}</span>
          <Link href={`${base}/${job.attention.tab}`} className="strip-link">
            {job.attention.action}
          </Link>
        </div>
      )}

      {!archived && (
        <div className="job-card-foot">
          <Link href={`${base}/candidates`} className="link-strong">
            View candidates <span aria-hidden="true">→</span>
          </Link>
          {canEdit && (
            <Link href={`${base}/edit`} className="link-quiet">
              Edit
            </Link>
          )}
          <div className="jm-spacer" />
          <ActionMenu label={`More actions for ${job.title}`} items={menu} />
        </div>
      )}
      {archive.dialog}
    </article>
  );
}
