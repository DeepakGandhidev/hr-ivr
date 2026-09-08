"use client";

import { useEffect, useState } from "react";

interface Job {
  id: string;
  title: string;
}

interface CallWindow {
  id?: string;
  jobId: string;
  timezone: string;
  days: number[];
  startTime: string;
  endTime: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * 24/7 is stored as every day with an identical start and end.
 *
 * The obvious 00:00–23:59 leaves the last minute of each day closed, and there
 * is no other way to say "all day" with two clock values — so equal times mean
 * the whole day, and the button below writes that rather than asking the user
 * to discover it.
 */
const ALWAYS = { days: ALL_DAYS, startTime: "00:00", endTime: "00:00" };

const isAlwaysOn = (w: CallWindow) =>
  w.startTime === w.endTime && ALL_DAYS.every((d) => w.days.includes(d));

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
  "UTC",
];

export default function CallWindowsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [windows, setWindows] = useState<Record<string, CallWindow>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`/api/${tenant}/jobs`, { cache: "no-store" }).then((r) => r.json()),
      fetch(`/api/${tenant}/call-windows`, { cache: "no-store" }).then((r) => r.json()),
    ])
      .then(([jobsData, windowsData]) => {
        const jobList: Job[] = jobsData.jobs ?? [];
        setJobs(jobList);
        const map: Record<string, CallWindow> = {};
        for (const w of windowsData.windows ?? []) {
          map[w.jobId] = { ...w, days: Array.isArray(w.days) ? w.days : [] };
        }
        for (const job of jobList) {
          if (!map[job.id]) {
            map[job.id] = {
              jobId: job.id,
              timezone: "Asia/Kolkata",
              days: [1, 2, 3, 4, 5],
              startTime: "09:00",
              endTime: "18:00",
            };
          }
        }
        setWindows(map);
      })
      .catch(() => setError("Failed to load call windows"));
  }, [tenant]);

  function updateWindow(jobId: string, updates: Partial<CallWindow>) {
    setWindows((prev) => ({ ...prev, [jobId]: { ...prev[jobId], ...updates } }));
  }

  function toggleDay(jobId: string, day: number) {
    const current = windows[jobId]?.days ?? [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day].sort((a, b) => a - b);
    updateWindow(jobId, { days: next });
  }

  async function saveWindow(jobId: string) {
    const window = windows[jobId];
    if (!window.days.length) {
      setError("Pick at least one day, or the agent can never take a call for this job.");
      return;
    }

    setSavingId(jobId);
    setError(null);
    setMessage(null);

    // The API expects these fields at the top level. Posting them wrapped as
    // { window: {...} } is what made every save fail validation.
    const res = await fetch(`/api/${tenant}/call-windows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: window.jobId,
        timezone: window.timezone,
        days: window.days,
        startTime: window.startTime,
        endTime: window.endTime,
      }),
    });

    const data = await res.json().catch(() => ({}));
    setSavingId(null);

    if (!res.ok) {
      setError(data.message || "Failed to save call window");
      return;
    }
    setMessage(`Saved. ${isAlwaysOn(window) ? "This job now accepts calls 24/7." : "Call window updated."}`);
  }

  function describe(w: CallWindow) {
    if (isAlwaysOn(w)) return "Always open — any time, any day";
    if (!w.days.length) return "No days selected — the agent will never answer";
    const days = w.days.map((d) => DAYS[d]).join(", ");
    const overnight = w.endTime < w.startTime ? " (overnight)" : "";
    return `${days} · ${w.startTime}–${w.endTime}${overnight}`;
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="page-head">
        <h1>Call windows</h1>
        <p className="muted">
          When the agent will answer screening calls for each job. Outside these
          hours a caller is told to try again later.
        </p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      {jobs.length === 0 ? (
        <div className="card empty">
          <h3>No jobs yet</h3>
          <p>Create a job first — call windows are set per role.</p>
        </div>
      ) : (
        jobs.map((job) => {
          const w = windows[job.id];
          if (!w) return null;
          const always = isAlwaysOn(w);

          return (
            <div key={job.id} className="card" style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
                <div>
                  <h3 style={{ marginBottom: 2 }}>{job.title}</h3>
                  <div className="subtle">{describe(w)}</div>
                </div>
                <span className={`badge ${always ? "badge-success" : "badge-neutral"}`}>
                  {always ? "24/7" : "Scheduled"}
                </span>
              </div>

              <div className="row" style={{ marginTop: 14, marginBottom: 14 }}>
                <button
                  type="button"
                  className={always ? "" : "primary"}
                  onClick={() =>
                    always
                      ? updateWindow(job.id, { days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" })
                      : updateWindow(job.id, ALWAYS)
                  }
                >
                  {always ? "Switch to set hours" : "Available 24/7"}
                </button>
              </div>

              {!always && (
                <>
                  <div style={{ marginBottom: 14 }}>
                    <label>Days</label>
                    <div className="row" style={{ gap: 12 }}>
                      {DAYS.map((dayLabel, day) => (
                        <label
                          key={day}
                          style={{ display: "inline-flex", alignItems: "center", marginBottom: 0, fontWeight: 500 }}
                        >
                          <input
                            type="checkbox"
                            checked={w.days.includes(day)}
                            onChange={() => toggleDay(job.id, day)}
                          />
                          {dayLabel}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
                    <div>
                      <label htmlFor={`${job.id}-start`}>Start time</label>
                      <input
                        id={`${job.id}-start`}
                        type="time"
                        value={w.startTime}
                        onChange={(e) => updateWindow(job.id, { startTime: e.target.value })}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${job.id}-end`}>End time</label>
                      <input
                        id={`${job.id}-end`}
                        type="time"
                        value={w.endTime}
                        onChange={(e) => updateWindow(job.id, { endTime: e.target.value })}
                      />
                    </div>
                  </div>

                  {w.endTime < w.startTime && (
                    <p className="subtle" style={{ marginTop: -6 }}>
                      This window runs overnight, from {w.startTime} through to {w.endTime} the next morning.
                    </p>
                  )}
                </>
              )}

              <div style={{ marginBottom: 14 }}>
                <label htmlFor={`${job.id}-timezone`}>Timezone</label>
                <select
                  id={`${job.id}-timezone`}
                  value={w.timezone}
                  onChange={(e) => updateWindow(job.id, { timezone: e.target.value })}
                >
                  {(TIMEZONES.includes(w.timezone) ? TIMEZONES : [w.timezone, ...TIMEZONES]).map((tz) => (
                    <option key={tz} value={tz}>{tz}</option>
                  ))}
                </select>
              </div>

              <button
                onClick={() => saveWindow(job.id)}
                disabled={savingId === job.id}
                className="primary"
              >
                {savingId === job.id ? "Saving…" : "Save window"}
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
