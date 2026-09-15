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

  // Shared classes for the text inputs, kept in one place so all five fields
  // stay visually identical instead of drifting as they're edited one by one.
  const inputClass =
    "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--text-subtle)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15";
  const labelClass = "mb-1.5 block text-sm font-semibold text-[var(--text)]";
  const hintClass = "-mt-1 mb-2 text-xs text-[var(--text-muted)]";

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="page-head">
        <h1>Create job</h1>
        <p className="muted">Applications are filed against a job, so this comes first.</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-7"
      >
        {error && (
          <div className="mb-6 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
          <div>
            <label htmlFor="title" className={labelClass}>
              Title
            </label>
            <input
              id="title"
              type="text"
              placeholder="MERN Stack Developer"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="location" className={labelClass}>
              Location
            </label>
            <input
              id="location"
              type="text"
              placeholder="Bengaluru / Remote"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="salaryBand" className={labelClass}>
              Salary band
            </label>
            <input
              id="salaryBand"
              type="text"
              placeholder="8–14 LPA"
              value={salaryBand}
              onChange={(e) => setSalaryBand(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="experienceRange" className={labelClass}>
              Experience range
            </label>
            <input
              id="experienceRange"
              type="text"
              placeholder="3–6 years"
              value={experienceRange}
              onChange={(e) => setExperienceRange(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-7 grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2">
          <div>
            <label htmlFor="mustHaves" className={labelClass}>
              Must-haves
            </label>
            <p className={hintClass}>One per line. These drive candidate scoring.</p>
            <textarea
              id="mustHaves"
              value={mustHaves}
              onChange={(e) => setMustHaves(e.target.value)}
              rows={6}
              className={`${inputClass} resize-y`}
            />
          </div>
          <div>
            <label htmlFor="goodToHaves" className={labelClass}>
              Good-to-haves
            </label>
            <p className={hintClass}>One per line. Counted, but never disqualifying.</p>
            <textarea
              id="goodToHaves"
              value={goodToHaves}
              onChange={(e) => setGoodToHaves(e.target.value)}
              rows={6}
              className={`${inputClass} resize-y`}
            />
          </div>
        </div>

        <div className="mt-7 flex flex-col-reverse items-stretch justify-end gap-3 border-t border-[var(--border)] pt-5 sm:flex-row sm:items-center">
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading && (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
              </svg>
            )}
            {loading ? "Creating..." : "Create job"}
          </button>
        </div>
      </form>
    </div>
  );
}