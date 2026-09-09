"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function NewJobPage({ params }: { params: { tenant: string } }) {
  const router = useRouter();
  const { tenant } = params;
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [salaryBand, setSalaryBand] = useState("");
  const [experienceRange, setExperienceRange] = useState("");
  const [mustHaves, setMustHaves] = useState("");
  const [goodToHaves, setGoodToHaves] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const payload = {
      title,
      location,
      salaryBand,
      experienceRange,
      mustHaves: mustHaves.split("\n").map((s) => s.trim()).filter(Boolean),
      goodToHaves: goodToHaves.split("\n").map((s) => s.trim()).filter(Boolean),
    };

    try {
      const res = await fetch(`/api/${tenant}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Failed to create job");
        return;
      }
      // The jobs list is server-rendered, so the Router Cache would serve the
      // payload from before this job existed. Without this the new job is
      // missing from the list until a hard reload.
      router.refresh();
      router.push(`/${tenant}/jobs/${data.job?.id ?? ""}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 620 }}>
      <div className="page-head">
        <h1>Create job</h1>
        <p className="muted">Applications are filed against a job, so this comes first.</p>
      </div>
      <form onSubmit={handleSubmit} className="card stack">
        {error && <div className="notice notice-error">{error}</div>}
        <div>
          <label htmlFor="title">Title</label>
          <input id="title" type="text" placeholder="MERN Stack Developer" value={title} onChange={(e) => setTitle(e.target.value)} required  />
        </div>
        <div>
          <label htmlFor="location">Location</label>
          <input id="location" type="text" placeholder="Bengaluru / Remote" value={location} onChange={(e) => setLocation(e.target.value)}  />
        </div>
        <div>
          <label htmlFor="salaryBand">Salary band</label>
          <input id="salaryBand" type="text" placeholder="8–14 LPA" value={salaryBand} onChange={(e) => setSalaryBand(e.target.value)}  />
        </div>
        <div>
          <label htmlFor="experienceRange">Experience range</label>
          <input id="experienceRange" type="text" placeholder="3–6 years" value={experienceRange} onChange={(e) => setExperienceRange(e.target.value)}  />
        </div>
        <div>
          <label htmlFor="mustHaves">Must-haves</label>
          <p className="subtle" style={{ marginTop: -2, marginBottom: 6 }}>One per line. These drive candidate scoring.</p>
          <textarea id="mustHaves" value={mustHaves} onChange={(e) => setMustHaves(e.target.value)} rows={4}  />
        </div>
        <div>
          <label htmlFor="goodToHaves">Good-to-haves</label>
          <p className="subtle" style={{ marginTop: -2, marginBottom: 6 }}>One per line. Counted, but never disqualifying.</p>
          <textarea id="goodToHaves" value={goodToHaves} onChange={(e) => setGoodToHaves(e.target.value)} rows={4}  />
        </div>
        <button type="submit" disabled={loading} className="primary">
          {loading ? "Creating..." : "Create job"}
        </button>
      </form>
    </div>
  );
}
