"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import MarkdownEditor from "@/components/MarkdownEditor";

interface JobVersion {
  id: string;
  version: number;
  title: string;
  changeNote?: string | null;
  createdAt: string;
  author?: { name?: string | null; email: string } | null;
}

interface JobDescription {
  id: string;
  version: number;
  bodyMd: string;
  createdAt: string;
}

interface JobPost {
  id: string;
  channel: string;
  status: string;
  postedAt?: string | null;
}

interface Job {
  id: string;
  title: string;
  location?: string | null;
  salaryBand?: string | null;
  experienceRange?: string | null;
  mustHaves: string[];
  goodToHaves: string[];
  versions?: JobVersion[];
  posts?: JobPost[];
  descriptions?: JobDescription[];
}

const asList = (value: string) =>
  value.split("\n").map((line) => line.trim()).filter(Boolean);

export default function EditJobPage({ params }: { params: { tenant: string; id: string } }) {
  const router = useRouter();
  const { tenant, id } = params;

  const [job, setJob] = useState<Job | null>(null);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [salaryBand, setSalaryBand] = useState("");
  const [experienceRange, setExperienceRange] = useState("");
  const [mustHaves, setMustHaves] = useState("");
  const [goodToHaves, setGoodToHaves] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  // The JD as it was when the form loaded, so the warning about re-publishing
  // can say whether the description specifically changed.
  const [originalBody, setOriginalBody] = useState("");
  const [viewingJd, setViewingJd] = useState<JobDescription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/${tenant}/jobs/${id}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Could not load this job");
      return;
    }
    const loaded: Job = data.job;
    setTitle(loaded.title ?? "");
    setLocation(loaded.location ?? "");
    setSalaryBand(loaded.salaryBand ?? "");
    setExperienceRange(loaded.experienceRange ?? "");
    setMustHaves((loaded.mustHaves ?? []).join("\n"));
    setGoodToHaves((loaded.goodToHaves ?? []).join("\n"));

    // Descriptions come from their own endpoint rather than from the job
    // payload: that one is filtered to approved versions only, because the
    // publish screen needs to distinguish "none written" from "not approved".
    // Editing has to start from the newest version whether or not it has been
    // approved, or an unapproved draft would silently be edited away.
    const jdRes = await fetch(`/api/${tenant}/jobs/${id}/descriptions`);
    const jdData = await jdRes.json().catch(() => ({}));
    const descriptions: JobDescription[] = jdRes.ok ? jdData.descriptions ?? [] : [];

    setJob({ ...loaded, descriptions });
    const currentJd = descriptions[0]?.bodyMd ?? "";
    setBodyMd(currentJd);
    setOriginalBody(currentJd);
  }, [tenant, id]);

  useEffect(() => {
    load();
  }, [load]);

  // A posted role is live on a careers page. Editing here does not update it,
  // and a user who does not know that will assume applicants are seeing the
  // corrected salary band when they are not.
  const livePosts = (job?.posts ?? []).filter((p) => p.status === "posted");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/${tenant}/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          location: location || null,
          salaryBand: salaryBand || null,
          experienceRange: experienceRange || null,
          mustHaves: asList(mustHaves),
          goodToHaves: asList(goodToHaves),
          bodyMd,
          ...(changeNote.trim() ? { changeNote: changeNote.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Could not save this job");
        return;
      }
      router.refresh();
      router.push(`/${tenant}/jobs/${id}`);
    } finally {
      setSaving(false);
    }
  }

  if (!job) {
    return (
      <div className="card empty">
        {error ? <p className="notice notice-error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <Link href={`/${tenant}/jobs/${id}`} className="subtle">&larr; {job.title}</Link>
        <h1 style={{ marginTop: 6 }}>Edit role</h1>
        <p className="muted">
          Saving keeps the previous version. Nothing is overwritten.
        </p>
      </div>

      {livePosts.length > 0 && (
        <div className="notice notice-info" style={{ marginBottom: 16 }}>
          <strong>This role is published.</strong> It is live on{" "}
          {livePosts.map((p) => p.channel).join(", ")}. Editing here does not update the live
          posting — you will need to publish again for applicants to see these changes.
          {bodyMd !== originalBody && (
            // Called out separately because the description is the part
            // applicants actually read: a stale salary band is wrong, a stale
            // JD is the whole advert.
            <> <strong>The job description has changed</strong>, so the published
            advert still shows the old text.</>
          )}
        </div>
      )}

      <form onSubmit={save} className="card stack">
        <label>
          <div className="subtle">Title</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
          <label>
            <div className="subtle">Location</div>
            <input value={location} onChange={(e) => setLocation(e.target.value)} />
          </label>
          <label>
            <div className="subtle">Salary band</div>
            <input value={salaryBand} onChange={(e) => setSalaryBand(e.target.value)} />
          </label>
          <label>
            <div className="subtle">Experience</div>
            <input value={experienceRange} onChange={(e) => setExperienceRange(e.target.value)} />
          </label>
        </div>

        <label>
          <div className="subtle">Must have — one per line</div>
          <textarea rows={5} value={mustHaves} onChange={(e) => setMustHaves(e.target.value)} />
        </label>

        <label>
          <div className="subtle">Good to have — one per line</div>
          <textarea rows={4} value={goodToHaves} onChange={(e) => setGoodToHaves(e.target.value)} />
        </label>

        <label>
          <span>Job description</span>
          <span className="subtle" style={{ display: "block", marginBottom: 6 }}>
            The text candidates read, and the text Pratibha screens against.
            Saving records a new description version; earlier ones stay readable
            below.
          </span>
          <MarkdownEditor
            value={bodyMd}
            onChange={setBodyMd}
            disabled={saving}
            label="Job description body"
          />
        </label>

        <label>
          <div className="subtle">What changed? (optional, saved with the version)</div>
          <input
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
            placeholder="Corrected the salary band"
          />
        </label>

        {error && <div className="notice notice-error">{error}</div>}

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Link href={`/${tenant}/jobs/${id}`} className="btn">Cancel</Link>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Saving…" : "Save new version"}
          </button>
        </div>
      </form>

      {(job.descriptions?.length ?? 0) > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Job description versions</h3>
          <div className="stack" style={{ gap: 10 }}>
            {job.descriptions!.map((d, i) => (
              <div key={d.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <strong>v{d.version}</strong>
                  {i === 0 && <span className="badge badge-accent" style={{ marginLeft: 8 }}>current</span>}
                  <div className="subtle">
                    {d.bodyMd.slice(0, 90).replace(/\s+/g, " ")}
                    {d.bodyMd.length > 90 ? "…" : ""}
                  </div>
                </div>
                <div className="subtle" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {new Date(d.createdAt).toLocaleDateString()}
                  <br />
                  <button type="button" className="sm ghost" onClick={() => setViewingJd(d)}>
                    View
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewingJd && (
        <div className="modal-backdrop" onClick={() => setViewingJd(null)} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Job description version ${viewingJd.version}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row" style={{ marginBottom: 10 }}>
              <strong>Description v{viewingJd.version}</strong>
              <span className="subtle" style={{ marginLeft: 8 }}>
                {new Date(viewingJd.createdAt).toLocaleString()}
              </span>
              <button
                className="ghost sm"
                style={{ marginLeft: "auto" }}
                onClick={() => setViewingJd(null)}
              >
                Close
              </button>
            </div>
            <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{viewingJd.bodyMd}</div>
          </div>
        </div>
      )}

      {(job.versions?.length ?? 0) > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Version history</h3>
          <div className="stack" style={{ gap: 10 }}>
            {job.versions!.map((v) => (
              <div key={v.id} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <strong>v{v.version}</strong> · {v.title}
                  {v.changeNote && <div className="subtle">{v.changeNote}</div>}
                </div>
                <div className="subtle" style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {new Date(v.createdAt).toLocaleDateString()}
                  <br />
                  {v.author?.name || v.author?.email || "—"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
