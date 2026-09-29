"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import MarkdownEditor from "@/components/MarkdownEditor";
import { JobShellError, JobTabHeader, JobTabs, useJobSummary } from "@/components/JobShell";
import Time from "@/components/Time";

interface JobDescription {
  id: string;
  version: number;
  bodyMd: string;
  generatedBy: string;
  approvedAt?: string | null;
  createdAt: string;
}

const origin = (d: JobDescription) => (d.generatedBy === "ai" ? "AI drafted" : "written by hand");

/**
 * JD Studio: draft, save and approve versions of the job description.
 *
 * Reached from the hub's History link. The JD opens rendered, so nobody sees
 * markdown syntax unless they choose to edit it.
 */
export default function JdStudioPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const { summary, error: summaryError, refresh } = useJobSummary();
  const [versions, setVersions] = useState<JobDescription[]>([]);
  const [body, setBody] = useState("");
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/${tenant}/jobs/${id}/descriptions`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const list: JobDescription[] = data.descriptions ?? [];
        setVersions(list);
        const approved = list.find((v) => v.approvedAt) ?? list[0];
        if (approved) {
          setBody(approved.bodyMd);
          setSelectedVersion(approved.version);
        }
      })
      .catch(() => setError("Failed to load JD versions"));
  }, [tenant, id]);

  async function generateJd() {
    setGenerating(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/jobs/${id}/generate-jd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    const data = await res.json().catch(() => ({}));
    setGenerating(false);
    if (!res.ok) {
      setError(data.message || "Failed to generate JD");
      return;
    }
    const draft: JobDescription = data.description;
    setBody(draft.bodyMd);
    setVersions((prev) => [draft, ...prev]);
    setSelectedVersion(draft.version);
    setMessage(`Generated draft version ${draft.version}. Review it, edit if needed, then approve.`);
    await refresh();
  }

  async function saveVersion() {
    // bodyMd is required server-side; without this the user got the raw
    // "Invalid job description payload" for the obvious mistake of an empty box.
    if (!body.trim()) {
      setError("Write or generate a description before saving.");
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/jobs/${id}/descriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bodyMd: body, generatedBy: "human" }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setError(data.message || "Failed to save JD");
      return;
    }
    const saved: JobDescription = data.description;
    setMessage(`Saved version ${saved.version}.`);
    setVersions((prev) => [saved, ...prev]);
    setSelectedVersion(saved.version);
    // A saved version flips a published role to "Live · edited".
    await refresh();
  }

  async function approveLatest() {
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/jobs/${id}/approve-jd`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Failed to approve JD");
      return;
    }
    const approved: JobDescription = data.description;
    setMessage(
      summary?.publish.state === "draft"
        ? `Approved version ${approved.version}.`
        : `Approved version ${approved.version}. Republish from the Publish tab to put it on your job page.`
    );
    setVersions((prev) => prev.map((v) => (v.id === approved.id ? { ...v, approvedAt: approved.approvedAt } : v)));
    await refresh();
  }

  if (summaryError) return <JobShellError />;

  const hasApproved = versions.some((v) => v.approvedAt);
  const pending = versions.filter((v) => !v.approvedAt);
  const canEdit = summary?.permissions.canEdit ?? false;
  const canApprove = summary?.permissions.canApproveJd ?? false;

  return (
    <div className="jm">
      <JobTabHeader
        title="JD Studio"
        intro="Write or generate the description, save it as a version, then approve it. Only an approved version can be published."
      />
      <JobTabs active="studio" />

      {/* The three steps are not discoverable from three same-looking buttons,
          and a job cannot be published until the last one is done. */}
      <ol className="jd-steps" aria-label="Steps to publish">
        <li className={versions.length > 0 ? "done" : undefined}>
          1. Draft{versions.length > 0 && <span className="visually-hidden"> (done)</span>}
        </li>
        <li className={hasApproved ? "done" : undefined}>
          2. Approve{hasApproved && <span className="visually-hidden"> (done)</span>}
        </li>
        <li>3. Publish</li>
        {hasApproved && (
          <li className="jd-steps-link">
            <Link href={`/${tenant}/jobs/${id}/publish`} className="link-strong">
              Go to publish <span aria-hidden="true">→</span>
            </Link>
          </li>
        )}
      </ol>

      {error && <div className="notice notice-error">{error}</div>}
      {message && (
        <div className="notice notice-success" role="status">
          {message}
        </div>
      )}

      <section className="jm-card stack">
        <div>
          <label htmlFor="jd-notes">Extra notes for the AI draft (optional)</label>
          <input
            id="jd-notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. emphasise fintech domain, remote friendly"
          />
        </div>
        <div>
          <div className="field-label">
            Job description{selectedVersion !== null ? ` · version ${selectedVersion}` : ""}
          </div>
          <MarkdownEditor
            // Remount per version so each one opens on its rendered view.
            key={selectedVersion ?? "new"}
            value={body}
            onChange={setBody}
            rows={16}
            label="Job description body"
            initialPreview={Boolean(body.trim())}
          />
        </div>
        <div className="jm-actions">
          {canEdit && (
            <>
              <button type="button" onClick={generateJd} disabled={generating} className="btn-line">
                {generating ? "Generating…" : "Generate with AI"}
              </button>
              <button type="button" onClick={saveVersion} disabled={loading || !body.trim()} className="btn-ink">
                {loading ? "Saving…" : "Save new version"}
              </button>
            </>
          )}
          {canApprove && (
            <button
              type="button"
              className="btn-line"
              onClick={approveLatest}
              disabled={pending.length === 0}
              title={pending.length === 0 ? "Every saved version is already approved" : undefined}
            >
              {pending.length === 0 ? "Nothing pending to approve" : `Approve version ${pending[0].version}`}
            </button>
          )}
        </div>
      </section>

      <section className="jm-card" id="history" aria-labelledby="history-title">
        <h2 id="history-title" className="card-title">
          Version history
        </h2>
        {versions.length === 0 ? (
          <p className="muted">No versions yet. Generate one with AI, or write it above and save.</p>
        ) : (
          <ul className="version-list">
            {versions.map((v) => (
              <li key={v.id}>
                <span>
                  <strong>Version {v.version}</strong>{" "}
                  <span className="muted">
                    · {origin(v)} · <Time value={v.createdAt} />
                  </span>
                </span>
                <span className={`chip sm ${v.approvedAt ? "chip-green" : "chip-amber"}`}>
                  {v.approvedAt ? "Approved" : "Pending"}
                </span>
                <button
                  type="button"
                  className="btn-link"
                  aria-label={`Load version ${v.version}`}
                  aria-pressed={selectedVersion === v.version}
                  onClick={() => {
                    setBody(v.bodyMd);
                    setSelectedVersion(v.version);
                  }}
                >
                  {selectedVersion === v.version ? "Showing" : "Load"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
