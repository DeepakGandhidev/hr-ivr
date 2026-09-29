"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { JobShellError, JobTabHeader, JobTabs, PublishChip, useJobSummary } from "@/components/JobShell";
import { markdownToPlain } from "@/components/Markdown";
import Time from "@/components/Time";
import { copyText, useToast } from "@/components/Toast";

interface JobPost {
  id: string;
  channel: string;
  status: string;
  postedAt?: string | null;
  externalRef?: string | null;
}

interface JobDescription {
  id: string;
  version: number;
  bodyMd: string;
  approvedAt?: string | null;
}

interface Job {
  id: string;
  title: string;
  status: string;
  slug?: string | null;
  location?: string | null;
  salaryBand?: string | null;
  experienceRange?: string | null;
  mustHaves?: string[];
  posts?: JobPost[];
  descriptions?: JobDescription[];
  _count?: { descriptions?: number };
}

type Portal = "naukri" | "linkedin";

const PORTALS: Array<{ key: Portal; name: string; description: string }> = [
  { key: "naukri", name: "Naukri", description: "A post formatted for Naukri, ready to paste from your own account" },
  {
    key: "linkedin",
    name: "LinkedIn",
    description: "A post formatted for LinkedIn, ready to paste from your company page",
  },
];

const DISCLOSURE = "The first round is a short telephonic interview with Pratibha, an AI recruiter.";

/** The JD as plain text that survives a paste into a portal's text box. */
function postBody(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const bullet = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/.test(line);
      const text = markdownToPlain(line);
      return bullet && text ? `• ${text}` : text;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildPost(portal: Portal, job: Job, jd: JobDescription, url: string): string {
  const facts = [
    job.location,
    job.experienceRange && `Experience: ${job.experienceRange}`,
    job.salaryBand && `Salary: ${job.salaryBand}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const body = postBody(jd.bodyMd);

  if (portal === "naukri") {
    return [job.title, ...(facts ? [facts] : []), "", body, "", `How to apply: ${url}`, DISCLOSURE].join("\n");
  }
  const tag = job.title.replace(/[^A-Za-z0-9]+/g, "");
  return [
    `We're hiring: ${job.title}${job.location ? ` (${job.location})` : ""}`,
    "",
    body,
    "",
    `Apply here: ${url}`,
    DISCLOSURE,
    "",
    `#hiring #${tag}`,
  ].join("\n");
}

/**
 * Where the role is public.
 *
 * The careers page is the source of truth, so it gets the status card; portals
 * are copy-and-paste, so they get a row each and a reminder when the JD moves
 * on without them.
 */
export default function PublishPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const { summary, error: summaryError, refresh } = useJobSummary();
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/${tenant}/jobs/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to load job");
      setJob(data.job ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load job");
    }
  }, [tenant, id]);

  useEffect(() => {
    load();
    setOrigin(window.location.origin);
  }, [load]);

  async function publish() {
    setBusy("publish");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/jobs/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to publish job");
      setMessage(
        summary?.publish.state === "draft"
          ? "Published. The role is open and on your job page."
          : "Republished. Your job page now shows the latest approved JD."
      );
      await Promise.all([load(), refresh()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to publish job");
    } finally {
      setBusy(null);
    }
  }

  /**
   * The newest version is not approved yet. Approving it is a recorded,
   * explicit step (who and when, as in JD Studio); republishing follows only
   * if it succeeds.
   */
  async function approveAndRepublish() {
    setBusy("publish");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/${tenant}/jobs/${id}/approve-jd`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not approve the new version");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve the new version");
      setBusy(null);
      return;
    }
    await publish();
  }

  async function copyPost(portal: Portal, name: string) {
    if (!job || !approvedJd) return;
    setBusy(portal);
    setError(null);
    try {
      const ok = await copyText(buildPost(portal, job, approvedJd, publicUrl));
      if (!ok) throw new Error("Your browser blocked the clipboard. Try again.");
      const res = await fetch(`/api/${tenant}/jobs/${id}/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: portal }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Copied, but the posted date could not be saved");
      toast.show(`${name} post copied. Paste it into ${name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy the post");
    } finally {
      setBusy(null);
    }
  }

  if (summaryError) return <JobShellError />;

  const publishInfo = summary?.publish;
  const perms = summary?.permissions;
  const approvedJd = (job?.descriptions ?? []).find((d) => d.approvedAt) ?? null;
  const hasDescriptions = (job?._count?.descriptions ?? 0) > 0;
  const state = publishInfo?.state ?? "draft";
  const isPublic = state === "live" || state === "live_edited";
  const publicUrl = job?.slug && origin ? `${origin}/j/${job.slug}` : "";
  const latest = publishInfo?.latestVersion ?? null;
  const posts = (job?.posts ?? []).filter((p) => p.channel !== "careers_page");
  const whatsapp = publicUrl
    ? `https://wa.me/?text=${encodeURIComponent(`${job?.title ?? "We're hiring"} – apply here: ${publicUrl}`)}`
    : "";

  return (
    <div className="jm">
      <JobTabHeader title="Publish" intro="Make this role public so candidates can find and apply to it." />
      <JobTabs active="publish" />

      {error && <div className="notice notice-error">{error}</div>}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}

      {!job || !summary ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {/* Publishing needs an approved description. Saying so up front beats
              a button that can only fail. */}
          {!approvedJd && (
            <section className="jm-card">
              <h2 className="card-title">Before you can publish</h2>
              <p className="muted">
                {hasDescriptions
                  ? "This job has a description, but nobody has approved it yet. Approval is what makes a version publishable."
                  : "This job has no description yet. Write or generate one, then approve it."}
              </p>
              <Link href={`/${tenant}/jobs/${id}/jd`} className="btn-ink">
                {hasDescriptions ? "Review and approve the JD" : "Open JD Studio"}
              </Link>
            </section>
          )}

          {/* J50 — one status card */}
          <section className="jm-card publish-card" aria-labelledby="page-title">
            <div className="card-title-row">
              <h2 id="page-title" className="card-title">
                Your public job page
              </h2>
              <PublishChip state={state} />
            </div>

            {state === "draft" && (
              <div className="publish-status">
                <span className="muted">Not published yet.</span>
                {perms?.canPublish && (
                  <button
                    type="button"
                    className="btn-ink"
                    onClick={publish}
                    disabled={busy !== null || !approvedJd}
                    title={approvedJd ? undefined : "Approve a job description first"}
                  >
                    {busy === "publish" ? "Publishing…" : "Publish to your job page"}
                  </button>
                )}
              </div>
            )}

            {state === "live" && publishInfo?.publishedAt && (
              <p className="publish-status muted">
                Published <Time value={publishInfo.publishedAt} format="date" /> · up to date
              </p>
            )}

            {/* J51 — the JD moved on after publishing */}
            {state === "live_edited" && (
              <div className="strip strip-amber">
                <span className="strip-text">
                  The JD changed on <Time value={publishInfo?.jdChangedAt ?? null} format="date" />. The public page
                  shows the older version.
                </span>
                {perms?.canPublish &&
                  (latest && !latest.approved ? (
                    perms.canApproveJd ? (
                      <span className="strip-actions">
                        <Link href={`/${tenant}/jobs/${id}/jd`} className="strip-link">
                          Review changes
                        </Link>
                        <button type="button" className="btn-ink sm" onClick={approveAndRepublish} disabled={busy !== null}>
                          {busy === "publish" ? "Republishing…" : `Approve version ${latest.version} and republish`}
                        </button>
                      </span>
                    ) : (
                      <span className="muted small">Version {latest.version} needs approval before it can go live.</span>
                    )
                  ) : (
                    <button type="button" className="btn-ink sm" onClick={publish} disabled={busy !== null}>
                      {busy === "publish" ? "Republishing…" : "Republish"}
                    </button>
                  ))}
              </div>
            )}

            {isPublic && publicUrl && (
              <>
                <div className="link-field">
                  <span className="link-url" title={publicUrl}>
                    {publicUrl}
                  </span>
                  <div className="link-actions">
                    <button
                      type="button"
                      className="btn-line sm"
                      onClick={async () =>
                        toast.show((await copyText(publicUrl)) ? "Link copied" : "Could not copy the link")
                      }
                    >
                      Copy link
                    </button>
                    <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="btn-line sm">
                      Share on WhatsApp<span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                    <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="link-strong">
                      Preview <span aria-hidden="true">↗</span>
                      <span className="visually-hidden"> (opens in a new tab)</span>
                    </a>
                  </div>
                </div>
                {/* J52 — the public page carries this disclosure above its call to apply. */}
                <p className="disclosure">
                  The page tells candidates that the first round is a short telephonic interview with Pratibha, an AI
                  recruiter, so nothing comes as a surprise.
                </p>
              </>
            )}
          </section>

          {/* J53 — job portals */}
          <section className="jm-card" aria-labelledby="portals-title">
            <h2 id="portals-title" className="card-title">
              Job portals
            </h2>
            {!summary.config.portalPosts ? (
              <p className="muted">
                Job portal posts are not included in your plan.{" "}
                <Link href={`/${tenant}/settings/subscription`}>See plans</Link>
              </p>
            ) : (
              <>
                <ul className="portal-list">
                  {PORTALS.map((p) => {
                    const post = posts.find((x) => x.channel === p.key && x.status === "posted");
                    const stale =
                      post?.postedAt && latest ? new Date(latest.createdAt) > new Date(post.postedAt) : false;
                    const disabledReason = !approvedJd
                      ? "Approve a job description first"
                      : !isPublic
                        ? "Publish your job page first, so the post can link to it"
                        : !perms?.canPublish
                          ? "Only admins can post this role"
                          : undefined;
                    return (
                      <li key={p.key} className="portal-row">
                        <div className="portal-text">
                          <div className="portal-name">{p.name}</div>
                          <div className="muted small">{p.description}</div>
                        </div>
                        {post?.postedAt ? (
                          <span className={`chip sm ${stale ? "chip-amber" : "chip-green"}`}>
                            Posted <Time value={post.postedAt} format="daymonth" />
                            {stale && " · JD changed since"}
                          </span>
                        ) : (
                          <span className="chip sm chip-neutral">Not posted yet</span>
                        )}
                        <button
                          type="button"
                          className="btn-line sm"
                          onClick={() => copyPost(p.key, p.name)}
                          disabled={busy !== null || Boolean(disabledReason)}
                          title={disabledReason}
                          aria-label={`Copy the ${p.name} post`}
                        >
                          {busy === p.key ? "Copying…" : stale ? "Copy updated post" : "Copy post"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <p className="card-note">
                  Portals never update themselves. If you edit the JD, copy and paste the post again, and Pratibha will
                  remind you here.
                </p>
              </>
            )}
          </section>
        </>
      )}
      {toast.node}
    </div>
  );
}
