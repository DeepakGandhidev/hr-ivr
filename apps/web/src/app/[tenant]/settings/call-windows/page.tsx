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

// Shared Tailwind fragments so every card and field stays visually identical
// rather than drifting as they're edited one at a time.
const labelCls = "mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]";
const inputCls =
  "w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15";

function ClockIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlobeIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CalendarIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M8 2v3M16 2v3M3.5 9h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M5 12.5 9.5 17 19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatChip({ value, label, tone }: { value: number; label: string; tone: "neutral" | "success" | "accent" }) {
  const toneCls =
    tone === "success"
      ? "border-[var(--success-border)] bg-[var(--success-soft)] text-[var(--success)]"
      : tone === "accent"
        ? "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]"
        : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${toneCls}`}>
      <span className="text-sm font-bold">{value}</span>
      {label}
    </span>
  );
}

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

  const loadedWindows = jobs.map((j) => windows[j.id]).filter(Boolean) as CallWindow[];
  const alwaysCount = loadedWindows.filter(isAlwaysOn).length;
  const scheduledCount = loadedWindows.length - alwaysCount;

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-3">
        <div className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-lg shadow-[var(--accent)]/25">
          <ClockIcon className="h-5 w-5" />
        </div>
        <h1 className="!mb-0">Call windows</h1>
      </div>
      <p className="muted mb-5">
        When the agent will answer screening calls for each job. Outside these hours a caller is told to try again
        later.
      </p>

      {loadedWindows.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-2">
          <StatChip value={jobs.length} label="jobs" tone="neutral" />
          <StatChip value={alwaysCount} label="always-on" tone="success" />
          <StatChip value={scheduledCount} label="scheduled" tone="accent" />
        </div>
      )}

      {error && (
        <div className="mb-5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-[var(--success-border)] bg-[var(--success-soft)] px-4 py-3 text-sm text-[var(--success)]">
          <CheckIcon className="h-4 w-4 flex-none" />
          {message}
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="flex flex-col items-center rounded-3xl border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] py-16 text-center">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-lg shadow-[var(--accent)]/25">
            <CalendarIcon className="h-6 w-6" />
          </div>
          <h3 className="mb-1 text-base font-semibold text-[var(--text)]">No jobs yet</h3>
          <p className="text-sm text-[var(--text-muted)]">Create a job first — call windows are set per role.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {jobs.map((job) => {
            const w = windows[job.id];
            if (!w) return null;
            const always = isAlwaysOn(w);
            const initial = job.title.trim().charAt(0).toUpperCase() || "?";

            return (
              <div
                key={job.id}
                className="group overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
              >
                {/* Top accent strip — a quick color read of this job's status
                    before you even reach the badge. */}
                <div
                  className={`h-1.5 w-full ${
                    always
                      ? "bg-gradient-to-r from-[var(--success)] to-[var(--success)]/60"
                      : "bg-gradient-to-r from-[var(--accent)] to-[var(--violet,#8B5CF6)]"
                  }`}
                />

                <div className="p-5 sm:p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`grid h-10 w-10 flex-none place-items-center rounded-xl text-sm font-bold text-white ${
                          always
                            ? "bg-gradient-to-br from-[var(--success)] to-[var(--success)]/70"
                            : "bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)]"
                        }`}
                      >
                        {initial}
                      </div>
                      <div>
                        <h3 className="mb-0.5 text-base font-semibold text-[var(--text)]">{job.title}</h3>
                        <div className="text-xs text-[var(--text-muted)]">{describe(w)}</div>
                      </div>
                    </div>
                  </div>

                  {/* 24/7 switch — a real toggle rather than a button that
                      changes its own label, so the "on" state reads instantly. */}
                  <button
                    type="button"
                    onClick={() =>
                      always
                        ? updateWindow(job.id, { days: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "18:00" })
                        : updateWindow(job.id, ALWAYS)
                    }
                    className="mt-5 flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 transition hover:border-[var(--accent-border)]"
                  >
                    <span className="text-sm font-semibold text-[var(--text)]">Available 24/7</span>
                    <span
                      className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full transition-colors ${
                        always ? "bg-[var(--success)]" : "bg-[var(--border-strong)]"
                      }`}
                    >
                      <span
                        className={`inline-block h-4.5 w-4.5 h-[18px] w-[18px] transform rounded-full bg-white shadow transition-transform ${
                          always ? "translate-x-[22px]" : "translate-x-[4px]"
                        }`}
                      />
                    </span>
                  </button>

                  {!always && (
                    <>
                      <div className="mt-5">
                        <label className={labelCls}>
                          <CalendarIcon className="h-3.5 w-3.5 text-[var(--text-subtle)]" />
                          Days
                        </label>
                        <div className="flex flex-wrap gap-2">
                          {DAYS.map((dayLabel, day) => {
                            const selected = w.days.includes(day);
                            return (
                              <button
                                key={day}
                                type="button"
                                onClick={() => toggleDay(job.id, day)}
                                aria-pressed={selected}
                                title={dayLabel}
                                className={[
                                  "grid h-10 w-10 place-items-center rounded-full text-xs font-bold transition-all duration-150",
                                  selected
                                    ? "scale-105 bg-gradient-to-br from-[var(--accent)] to-[var(--accent-hover)] text-white shadow-md shadow-[var(--accent)]/25"
                                    : "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text-muted)] hover:border-[var(--accent-border)] hover:text-[var(--text)]",
                                ].join(" ")}
                              >
                                {dayLabel.slice(0, 2)}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="mt-5 grid grid-cols-2 gap-4">
                        <div>
                          <label htmlFor={`${job.id}-start`} className={labelCls}>
                            <ClockIcon className="h-3.5 w-3.5 text-[var(--text-subtle)]" />
                            Start time
                          </label>
                          <input
                            id={`${job.id}-start`}
                            type="time"
                            value={w.startTime}
                            onChange={(e) => updateWindow(job.id, { startTime: e.target.value })}
                            className={inputCls}
                          />
                        </div>
                        <div>
                          <label htmlFor={`${job.id}-end`} className={labelCls}>
                            <ClockIcon className="h-3.5 w-3.5 text-[var(--text-subtle)]" />
                            End time
                          </label>
                          <input
                            id={`${job.id}-end`}
                            type="time"
                            value={w.endTime}
                            onChange={(e) => updateWindow(job.id, { endTime: e.target.value })}
                            className={inputCls}
                          />
                        </div>
                      </div>

                      {w.endTime < w.startTime && (
                        <p className="mt-3 rounded-xl border border-[var(--warning-border)] bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]">
                          This window runs overnight, from {w.startTime} through to {w.endTime} the next morning.
                        </p>
                      )}
                    </>
                  )}

                  <div className="mt-5">
                    <label htmlFor={`${job.id}-timezone`} className={labelCls}>
                      <GlobeIcon className="h-3.5 w-3.5 text-[var(--text-subtle)]" />
                      Timezone
                    </label>
                    <select
                      id={`${job.id}-timezone`}
                      value={w.timezone}
                      onChange={(e) => updateWindow(job.id, { timezone: e.target.value })}
                      className={inputCls}
                    >
                      {(TIMEZONES.includes(w.timezone) ? TIMEZONES : [w.timezone, ...TIMEZONES]).map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-6 flex justify-end border-t border-[var(--border)] pt-5">
                    <button
                      onClick={() => saveWindow(job.id)}
                      disabled={savingId === job.id}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent-hover)] px-5 py-2.5 text-sm font-semibold text-white shadow-md shadow-[var(--accent)]/25 transition hover:shadow-lg hover:shadow-[var(--accent)]/30 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {savingId === job.id ? (
                        <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
                        </svg>
                      ) : (
                        <CheckIcon className="h-4 w-4" />
                      )}
                      {savingId === job.id ? "Saving…" : "Save window"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}