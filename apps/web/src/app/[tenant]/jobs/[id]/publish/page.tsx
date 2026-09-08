"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface JobPost {
  id: string;
  channel: string;
  status: string;
  includesPratibhaNumber: boolean;
}

interface JobDescription {
  id: string;
  version: number;
  approvedAt?: string | null;
}

interface Job {
  id: string;
  title: string;
  status: string;
  slug?: string | null;
  posts?: JobPost[];
  descriptions?: JobDescription[];
  _count?: { descriptions?: number };
}

export default function PublishPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/${tenant}/jobs/${id}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setJob(data.job ?? null))
      .catch(() => setError("Failed to load job"));
  }, [tenant, id]);

  async function publishCareers() {
    setLoading(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/jobs/${id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setError(data.message || "Failed to publish job");
      return;
    }
    setMessage("Published. The role is now open and visible on your careers page.");
    // Merge rather than replace: the GET response carries fields the publish
    // response does not, and dropping them blanked the page.
    setJob((prev) => ({ ...prev, ...data.job }));
  }

  if (!job && !error) return <p className="muted">Loading…</p>;

  // Defensive: these arrays are absent on some responses, and reading .find on
  // undefined is what crashed this page immediately after a successful publish.
  const posts = job?.posts ?? [];
  const careersPost = posts.find((p) => p.channel === "careers_page");
  const isPublished = careersPost?.status === "posted";

  const approvedJd = (job?.descriptions ?? []).find((d) => d.approvedAt);
  // descriptions[] is filtered to approved versions, so an unapproved draft
  // only shows up in the count.
  const hasDescriptions = (job?._count?.descriptions ?? 0) > 0;
  const canPublish = Boolean(approvedJd);

  const publicUrl =
    job?.slug && typeof window !== "undefined" ? `${window.location.origin}/j/${job.slug}` : "";

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <Link href={`/${tenant}/jobs/${id}`} className="subtle">&larr; {job?.title ?? "Job"}</Link>
        <h1 style={{ marginTop: 6 }}>Publish</h1>
        <p className="muted">Make this role public so candidates can find and apply to it.</p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      {/* Publishing requires an approved description. Saying so up front beats
          letting someone press a button that can only fail. */}
      {!canPublish && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Before you can publish</h3>
          <p className="muted">
            {hasDescriptions
              ? "This job has a description, but nobody has approved it yet. Approval is what makes a version publishable."
              : "This job has no description yet. Write or generate one, then approve it."}
          </p>
          <Link href={`/${tenant}/jobs/${id}/jd`} className="btn btn-primary" style={{ marginTop: 6 }}>
            {hasDescriptions ? "Review and approve the JD" : "Open JD Studio"}
          </Link>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>Careers page</h3>
            <div className="subtle">
              {isPublished ? "Live and accepting applications" : "Not published yet"}
            </div>
          </div>
          <span className={`badge ${isPublished ? "badge-success" : "badge-neutral"}`}>
            {isPublished ? "Live" : "Draft"}
          </span>
        </div>

        {isPublished && publicUrl && (
          <div style={{ marginTop: 14 }}>
            <div className="subtle" style={{ marginBottom: 6 }}>Public link</div>
            <code style={{ display: "block", padding: 9, wordBreak: "break-all" }}>{publicUrl}</code>
            <a href={publicUrl} target="_blank" rel="noreferrer" className="btn" style={{ marginTop: 10 }}>
              Open preview
            </a>
          </div>
        )}

        {!isPublished && (
          <button
            onClick={publishCareers}
            disabled={loading || !canPublish}
            className="primary"
            style={{ marginTop: 14 }}
            title={canPublish ? undefined : "Approve a job description first"}
          >
            {loading ? "Publishing…" : "Publish to careers page"}
          </button>
        )}
      </div>

      <div className="card">
        <h3>Channels</h3>
        {posts.length === 0 ? (
          <p className="muted">Not posted anywhere yet.</p>
        ) : (
          posts.map((post) => (
            <div
              key={post.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={{ textTransform: "capitalize" }}>{post.channel.replace(/_/g, " ")}</span>
              <span className={`badge ${post.status === "posted" ? "badge-success" : "badge-neutral"}`}>
                {post.status}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
