"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ActionMenu, { type ActionMenuItem } from "@/components/ActionMenu";
import { useArchiveJob } from "@/components/JobActions";
import {
  approvalStripText,
  JobShellError,
  JobTabs,
  PublishChip,
  useJobSummary,
} from "@/components/JobShell";
import Markdown from "@/components/Markdown";
import Time from "@/components/Time";
import { copyText, useToast } from "@/components/Toast";
import { daysBetween, plural } from "@/lib/format";

const DIFFICULTY: Record<string, string> = {
  easy: "Easy",
  moderate: "Moderate",
  hard: "Hard",
  expert: "Expert",
};

/**
 * Stored requirements, one chip per line. A requirement pasted in as several
 * lines is several requirements; each wraps inside its own chip rather than
 * becoming one giant chip that overlaps its neighbours.
 */
function requirementLines(list: unknown): string[] {
  const items = Array.isArray(list) ? list.map(String) : [];
  return items
    .flatMap((item) => item.split(/\r?\n+/))
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The job hub — the JD Studio tab.
 *
 * Everything a recruiter needs to know about one role before opening a tab:
 * what is waiting on them, how far hiring has got, what the role is, how
 * Pratibha interviews for it, and the JD itself.
 */
export default function JobHubPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const router = useRouter();
  const { summary, error } = useJobSummary();
  const toast = useToast();

  const archive = useArchiveJob({
    tenant,
    jobId: id,
    title: summary?.job.title ?? "this job",
    candidateCount: summary?.counts.applications ?? 0,
    onArchived: () => {
      router.push(`/${tenant}/jobs`);
      router.refresh();
    },
  });

  if (error) return <JobShellError />;

  if (!summary) {
    return (
      <div className="jm">
        <div className="job-head">
          <Link href={`/${tenant}/jobs`} className="job-back">
            <span aria-hidden="true">←</span> Jobs
          </Link>
          <div className="job-head-row">
            <div className="skeleton skeleton-title" aria-hidden="true" />
          </div>
        </div>
        <JobTabs active="studio" />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  const { job, counts, publish, interview, jd, permissions } = summary;
  const base = `/${tenant}/jobs/${id}`;
  const isPublic = publish.state === "live" || publish.state === "live_edited";
  const publicPath = `/j/${job.slug}`;

  const menu: ActionMenuItem[] = [
    ...(isPublic
      ? [
          {
            label: "Copy job page link",
            onSelect: async () => {
              const ok = await copyText(`${window.location.origin}${publicPath}`);
              toast.show(ok ? "Job page link copied" : "Could not copy the link");
            },
          },
        ]
      : []),
    ...(permissions.canArchive ? [{ label: "Archive", danger: true, onSelect: archive.request }] : []),
  ];

  const must = requirementLines(job.mustHaves);
  const good = requirementLines(job.goodToHaves);

  return (
    <div className="jm">
      {/* J20 — header */}
      <div className="job-head">
        <Link href={`/${tenant}/jobs`} className="job-back">
          <span aria-hidden="true">←</span> Jobs
        </Link>
        <div className="job-head-row">
          <div className="job-head-title">
            <h1>{job.title}</h1>
            <PublishChip state={publish.state} />
          </div>
          <div className="job-head-actions">
            {isPublic && (
              <a href={publicPath} target="_blank" rel="noopener noreferrer" className="link-strong">
                View job page <span aria-hidden="true">↗</span>
                <span className="visually-hidden"> (opens in a new tab)</span>
              </a>
            )}
            {permissions.canEdit && (
              <Link href={`${base}/edit`} className="btn-line">
                Edit
              </Link>
            )}
            {menu.length > 0 && <ActionMenu label={`More actions for ${job.title}`} items={menu} />}
          </div>
        </div>
      </div>

      {/* J21 — tabs with live counts */}
      <JobTabs active="studio" />

      {/* J22 — approval strip */}
      {counts.awaitingApproval > 0 && (
        <div className="strip">
          <span className="strip-text">{approvalStripText(counts.awaitingApproval)}</span>
          <Link href={`${base}/shortlist`} className="strip-link">
            Review shortlist
          </Link>
        </div>
      )}

      {/* J23 — funnel strip, same definitions as the Overview's funnel */}
      <section className="jm-card funnel-strip" aria-label="Hiring funnel for this role">
        <ol>
          {[
            [counts.applications, "Applications"],
            [counts.screened, "Screened"],
            [counts.shortlisted, "Shortlisted"],
            [counts.interviewed, "Interviewed"],
            [counts.recommended, "Recommended"],
          ].map(([n, label], i) => (
            <li key={label as string}>
              {i > 0 && (
                <svg className="funnel-arrow" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <path d="M5 3 L9 7 L5 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              )}
              <span className="funnel-n">{n}</span>
              <span className="funnel-t">{label}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* J24 — role facts and interview setup */}
      <div className="facts-grid">
        <section className="jm-card" aria-labelledby="role-facts">
          <h2 id="role-facts" className="card-title">
            Role facts
          </h2>
          <dl className="facts">
            <div>
              <dt>Location</dt>
              <dd>{job.location || "Not set"}</dd>
            </div>
            <div>
              <dt>Salary band</dt>
              <dd>{job.salaryBand || "Not set"}</dd>
            </div>
            <div>
              <dt>Experience</dt>
              <dd>{job.experienceRange || "Not set"}</dd>
            </div>
            <div>
              <dt>Open since</dt>
              <dd>
                {publish.firstPublishedAt ? (
                  <>
                    <Time value={publish.firstPublishedAt} format="date" /> ·{" "}
                    {plural(daysBetween(publish.firstPublishedAt), "day")}
                  </>
                ) : (
                  "Not published yet"
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="jm-card" aria-labelledby="interview-setup">
          <div className="card-title-row">
            <h2 id="interview-setup" className="card-title">
              Interview setup for this role
            </h2>
            {permissions.canEditInterview && (
              <Link
                href={`/${tenant}/settings/protocols?job=${id}`}
                className="link-strong"
                aria-label={`Edit interview settings for ${job.title}`}
              >
                Edit <span aria-hidden="true">→</span>
              </Link>
            )}
          </div>
          <dl className="facts">
            <div>
              <dt>Length and difficulty</dt>
              <dd>
                {plural(interview.durationMinutes, "minute")} · {DIFFICULTY[interview.difficulty] ?? interview.difficulty}
              </dd>
            </div>
            <div>
              <dt>Call window</dt>
              <dd>{capitalise(interview.callWindow)}</dd>
            </div>
            <div>
              <dt>Focus areas</dt>
              <dd>{interview.focusAreas.length ? interview.focusAreas.join(", ") : "None set"}</dd>
            </div>
            <div>
              <dt>Languages</dt>
              <dd>{interview.languages.join(", ")}</dd>
            </div>
          </dl>
          {interview.source !== "job" && (
            <p className="card-note">
              {interview.source === "workspace"
                ? "Uses your workspace defaults. Edit to give this role its own."
                : "Uses Pratibha's defaults."}
            </p>
          )}
        </section>
      </div>

      {/* J25 — requirements */}
      <section className="jm-card" aria-labelledby="requirements">
        <h2 id="requirements" className="card-title">
          Requirements
        </h2>
        <p className="card-caption">Pratibha screens every CV against these</p>
        <div className="req-cols">
          <div>
            <h3 className="req-head">Must have</h3>
            {must.length ? (
              <ul className="req-list">
                {must.map((m, i) => (
                  <li key={`${i}-${m}`} className="req-chip req-must">
                    {m}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None set</p>
            )}
          </div>
          <div>
            <h3 className="req-head">Good to have</h3>
            {good.length ? (
              <ul className="req-list">
                {good.map((g, i) => (
                  <li key={`${i}-${g}`} className="req-chip">
                    {g}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None set</p>
            )}
          </div>
        </div>
      </section>

      {/* J26 — the JD */}
      <JdBlock
        tenant={tenant}
        jobId={id}
        jd={jd}
      />

      {archive.dialog}
      {toast.node}
    </div>
  );
}

function JdBlock({
  tenant,
  jobId,
  jd,
}: {
  tenant: string;
  jobId: string;
  jd: { version: number; bodyMd: string; generatedBy: string; approvedAt: string | null } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  const bodyId = useId();

  // Only a JD taller than the block gets the fade and the "read more" link.
  useEffect(() => {
    const el = body.current;
    if (el) setOverflows(el.scrollHeight > el.clientHeight + 4);
  }, [jd?.bodyMd]);

  return (
    <section className="jm-card" aria-labelledby="jd-title">
      <div className="card-title-row">
        <h2 id="jd-title" className="card-title">
          Job description
        </h2>
        {jd && (
          <span className="card-meta">
            Version {jd.version} · {jd.generatedBy === "ai" ? "AI drafted" : "written by hand"} ·{" "}
            {jd.approvedAt ? "approved" : "awaiting approval"}
          </span>
        )}
        <Link href={`/${tenant}/jobs/${jobId}/jd#history`} className="link-strong">
          History
        </Link>
      </div>

      {jd ? (
        <>
          <div
            id={bodyId}
            ref={body}
            className={`jd-block${expanded ? " is-open" : ""}${overflows && !expanded ? " has-fade" : ""}`}
          >
            <Markdown source={jd.bodyMd} />
          </div>
          {(overflows || expanded) && (
            <button
              type="button"
              className="btn-link"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show less" : "Read the full description"} <span aria-hidden="true">{expanded ? "↑" : "→"}</span>
            </button>
          )}
        </>
      ) : (
        <p className="muted">
          No description yet. <Link href={`/${tenant}/jobs/${jobId}/jd`}>Write or generate one</Link>.
        </p>
      )}
    </section>
  );
}
