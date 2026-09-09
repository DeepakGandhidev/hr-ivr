"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface JobDescription {
  id: string;
  version: number;
  bodyMd: string;
  generatedBy: string;
  approvedAt?: string | null;
  createdAt: string;
}

export default function JdStudioPage({ params }: { params: { tenant: string; id: string } }) {
  const router = useRouter();
  const { tenant, id } = params;
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
    setMessage(`Generated draft version ${draft.version} — review, edit, then approve.`);
    router.refresh();
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
    setMessage(`Saved version ${saved.version}`);
    setVersions((prev) => [saved, ...prev]);
    setSelectedVersion(saved.version);
    router.refresh();
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
    setMessage(`Approved version ${approved.version}`);
    setVersions((prev) =>
      prev.map((v) => (v.id === approved.id ? { ...v, approvedAt: approved.approvedAt } : v))
    );
    router.refresh();
  }

  const hasApproved = versions.some((v) => v.approvedAt);
  const pending = versions.filter((v) => !v.approvedAt);

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="page-head">
        <Link href={`/${tenant}/jobs/${id}`} className="subtle">&larr; Back to job</Link>
        <h1 style={{ marginTop: 6 }}>JD Studio</h1>
        <p className="muted">
          Write or generate the description, save it as a version, then approve
          it. Only an approved version can be published.
        </p>
      </div>

      {/* The three steps are not discoverable from three same-looking buttons,
          and a job cannot be published until the last one is done. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 18 }}>
          <span className={`badge ${versions.length > 0 ? "badge-success" : "badge-neutral"}`}>
            1. Draft {versions.length > 0 ? "\u2713" : ""}
          </span>
          <span className={`badge ${hasApproved ? "badge-success" : "badge-neutral"}`}>
            2. Approve {hasApproved ? "\u2713" : ""}
          </span>
          <span className="badge badge-neutral">3. Publish</span>
          {hasApproved && (
            <Link href={`/${tenant}/jobs/${id}/publish`} style={{ marginLeft: "auto" }}>
              Go to publish &rarr;
            </Link>
          )}
        </div>
      </div>
      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}
      <div style={{ marginBottom: 16 }}>
        <label htmlFor="jd-notes">Extra notes for the AI draft (optional)</label>
        <input
          id="jd-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. emphasise fintech domain, remote-friendly"
          
        />
      </div>
      <div style={{ marginBottom: 16 }}>
        <label htmlFor="jd-body">JD body (Markdown)</label>
        <textarea
          id="jd-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={16}
          style={{ fontFamily: "var(--mono)" }}
        />
      </div>
      <div className="row" style={{ marginBottom: 24 }}>
        <button onClick={generateJd} disabled={generating} className="primary">
          {generating ? "Generating..." : "Generate with AI"}
        </button>
        <button onClick={saveVersion} disabled={loading || !body.trim()} className="primary">
          {loading ? "Saving…" : "Save new version"}
        </button>
        <button
          onClick={approveLatest}
          disabled={pending.length === 0}
          title={pending.length === 0 ? "Every saved version is already approved" : undefined}
        >
          {pending.length === 0
            ? "Nothing pending to approve"
            : `Approve version ${pending[0].version}`}
        </button>
      </div>

      <h3>Version history</h3>
      {versions.length === 0 ? (
        <p className="muted">No versions yet. Generate one with AI, or write it above and save.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {versions.map((v) => (
            <li key={v.id} className="card" style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>
                  Version {v.version} <span className="subtle">· {v.generatedBy}</span>{" "}
                  <span className={`badge ${v.approvedAt ? "badge-success" : "badge-warning"}`}>
                    {v.approvedAt ? "approved" : "pending"}
                  </span>
                </span>
                <button className="sm" onClick={() => { setBody(v.bodyMd); setSelectedVersion(v.version); }}>
                  Load
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
