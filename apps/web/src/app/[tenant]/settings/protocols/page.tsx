"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Protocol {
  id?: string;
  jobId?: string | null;
  instructionText: string;
  durationMinutes: number;
  difficulty: "easy" | "moderate" | "hard" | "expert";
  minQuestions: number;
  maxQuestions: number;
  focusAreas?: string[] | null;
  agentName?: string | null;
  companyName?: string | null;
}

interface Job {
  id: string;
  title: string;
}

const DEFAULTS: Protocol = {
  jobId: null,
  instructionText:
    "Be warm and concise. Ask one question at a time. Do not discuss salary, joining dates, or other candidates. If asked something you cannot answer, say the team will follow up.",
  durationMinutes: 10,
  difficulty: "moderate",
  minQuestions: 6,
  maxQuestions: 10,
  focusAreas: [],
  agentName: null,
  companyName: null,
};

const DIFFICULTY: Array<{
  value: Protocol["difficulty"];
  label: string;
  hint: string;
  // Color tokens per difficulty — a quick visual read of how tough a stage is,
  // reusing the app's existing success/accent/warning/danger palette rather
  // than inventing new colors.
  dot: string;
  chip: string;
}> = [
  {
    value: "easy",
    label: "Easy",
    hint: "What they have done. Accepts a good-enough answer and moves on. Suits freshers.",
    dot: "bg-[var(--success)]",
    chip: "bg-[var(--success-soft)] text-[var(--success)] border-[var(--success-border)]",
  },
  {
    value: "moderate",
    label: "Moderate",
    hint: "Real work on their CV, one follow-up for specifics. The usual choice.",
    dot: "bg-[var(--accent)]",
    chip: "bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-border)]",
  },
  {
    value: "hard",
    label: "Hard",
    hint: "Probes trade-offs and failures, follows up twice on vague answers.",
    dot: "bg-[var(--warning)]",
    chip: "bg-[var(--warning-soft)] text-[var(--warning)] border-[var(--warning-border)]",
  },
  {
    value: "expert",
    label: "Expert",
    hint: "Senior-hire depth. Challenges claims that do not hold together.",
    dot: "bg-[var(--danger)]",
    chip: "bg-[var(--danger-soft)] text-[var(--danger)] border-[var(--danger-border)]",
  },
];

// Shared Tailwind fragments so every field stays visually identical instead
// of drifting as fields get touched one at a time.
const labelCls = "mb-1.5 block text-sm font-semibold text-[var(--text)]";
const hintCls = "mt-1.5 text-xs text-[var(--text-muted)]";
const inputCls =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--text)] outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[var(--accent)]/15";
const cardCls = "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)] sm:p-6";
const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--accent-hover)] hover:shadow disabled:cursor-not-allowed disabled:opacity-60";
const secondaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2.5 text-sm font-semibold text-[var(--text)] transition hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

export default function ProtocolsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [scope, setScope] = useState<string>(""); // "" = workspace default
  const [draft, setDraft] = useState<Protocol>(DEFAULTS);
  const [focusText, setFocusText] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, j, t] = await Promise.all([
        fetch(`/api/${tenant}/interview-protocols`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/${tenant}/jobs`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/${tenant}/settings`, { cache: "no-store" }).then((r) => r.json()),
      ]);
      setProtocols(p.protocols ?? []);
      setJobs(j.jobs ?? []);
      setCompanyName(t.tenant?.name ?? "");
    } catch {
      setError("Failed to load settings");
    }
  }, [tenant]);

  useEffect(() => {
    load();
  }, [load]);

  const current = useMemo(
    () => protocols.find((p) => (p.jobId ?? "") === scope),
    [protocols, scope]
  );

  // Switching scope loads that protocol, or the workspace default as a starting
  // point so a per-job override does not begin from an empty form.
  useEffect(() => {
    const base = current ?? protocols.find((p) => !p.jobId) ?? DEFAULTS;
    setDraft({ ...DEFAULTS, ...base, jobId: scope || null });
    setFocusText((base.focusAreas ?? []).join(", "));
  }, [scope, current, protocols]);

  function set<K extends keyof Protocol>(key: K, value: Protocol[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);

    if (draft.maxQuestions < draft.minQuestions) {
      setError("Maximum questions cannot be lower than the minimum.");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/${tenant}/interview-protocols`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(scope ? { jobId: scope } : {}),
          instructionText: draft.instructionText,
          durationMinutes: Number(draft.durationMinutes),
          difficulty: draft.difficulty,
          minQuestions: Number(draft.minQuestions),
          maxQuestions: Number(draft.maxQuestions),
          focusAreas: focusText.split(",").map((s) => s.trim()).filter(Boolean),
          agentName: draft.agentName?.trim() || null,
          companyName: draft.companyName?.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || "Failed to save");
        return;
      }
      setMessage(scope ? "Saved for this job." : "Saved as the workspace default.");
      await load();
    } finally {
      setSaving(false);
    }
  }

  const scopeLabel = scope ? jobs.find((j) => j.id === scope)?.title ?? "this job" : "all jobs";
  const overrides = protocols.filter((p) => p.jobId).length;
  const activeDifficulty = DIFFICULTY.find((d) => d.value === draft.difficulty)!;

  return (
    <div className="w-full">
      <div className="page-head">
        <h1>Interview settings</h1>
        <p className="muted">
          How long each interview runs, how hard it is, and what the agent calls itself. Set a workspace default, then
          override it per job.
        </p>
      </div>

      {error && (
        <div className="mb-5 rounded-lg border border-[var(--danger-border)] bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
      {message && (
        <div className="mb-5 rounded-lg border border-[var(--success-border)] bg-[var(--success-soft)] px-4 py-3 text-sm text-[var(--success)]">
          {message}
        </div>
      )}

      {/* Full-width dashboard split: the form takes the flexible left column,
          a fixed-width sidebar on the right holds Company + Scope so the page
          uses the whole viewport without individual inputs stretching to
          absurd widths on large monitors. Stacks to one column below xl. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_360px]">
        <form onSubmit={save} className={cardCls}>
          <div className="mb-6 flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-[var(--text)]">Interview for {scopeLabel}</h3>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${activeDifficulty.chip}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${activeDifficulty.dot}`} />
              {activeDifficulty.label}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-3">
            <div>
              <label htmlFor="duration" className={labelCls}>
                Length (minutes)
              </label>
              <input
                id="duration"
                type="number"
                min={2}
                max={90}
                value={draft.durationMinutes}
                onChange={(e) => set("durationMinutes", Number(e.target.value))}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="minq" className={labelCls}>
                Minimum questions
              </label>
              <input
                id="minq"
                type="number"
                min={1}
                max={40}
                value={draft.minQuestions}
                onChange={(e) => set("minQuestions", Number(e.target.value))}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="maxq" className={labelCls}>
                Maximum questions
              </label>
              <input
                id="maxq"
                type="number"
                min={1}
                max={40}
                value={draft.maxQuestions}
                onChange={(e) => set("maxQuestions", Number(e.target.value))}
                className={inputCls}
              />
            </div>
          </div>
          <p className={hintCls}>
            The clock starts at the first question, not when the phone is answered — greeting and consent do not eat
            into the interview. An interview that overruns is wrapped up politely rather than cut off.
          </p>

          <div className="mt-7">
            <label htmlFor="difficulty" className={labelCls}>
              Difficulty
            </label>
            <select
              id="difficulty"
              value={draft.difficulty}
              onChange={(e) => set("difficulty", e.target.value as Protocol["difficulty"])}
              className={inputCls}
            >
              {DIFFICULTY.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
            <p className={hintCls}>{activeDifficulty.hint}</p>
          </div>

          <div className="mt-7 grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
            <div>
              <label htmlFor="focus" className={labelCls}>
                Focus areas
              </label>
              <input
                id="focus"
                value={focusText}
                onChange={(e) => setFocusText(e.target.value)}
                placeholder="system design, React performance, team leadership"
                className={inputCls}
              />
              <p className={hintCls}>Comma separated. Questions lean towards these; leave blank to follow the CV.</p>
            </div>
            <div>
              <label htmlFor="agentName" className={labelCls}>
                Agent name
              </label>
              <input
                id="agentName"
                value={draft.agentName ?? ""}
                onChange={(e) => set("agentName", e.target.value)}
                placeholder="Pratibha"
                className={inputCls}
              />
              <p className={hintCls}>What the agent calls itself when it introduces itself.</p>
            </div>
          </div>

          <div className="mt-7">
            <label htmlFor="brand" className={labelCls}>
              Hiring under (optional)
            </label>
            <input
              id="brand"
              value={draft.companyName ?? ""}
              onChange={(e) => set("companyName", e.target.value)}
              placeholder={companyName || "your company"}
              className={inputCls}
            />
            <p className={hintCls}>Set a different brand here if this role is hired under another name.</p>
          </div>

          <div className="mt-7">
            <label htmlFor="instructions" className={labelCls}>
              Instructions for the interviewer
            </label>
            <textarea
              id="instructions"
              value={draft.instructionText}
              onChange={(e) => set("instructionText", e.target.value)}
              rows={8}
              className={`${inputCls} resize-y`}
            />
            <p className={hintCls}>
              Tone and anything off-limits. Safety rules and the interview structure are enforced separately and
              cannot be overridden here.
            </p>
          </div>

          <div className="mt-7 flex justify-end border-t border-[var(--border)] pt-5">
            <button type="submit" disabled={saving} className={primaryBtn}>
              {saving && (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4Z" />
                </svg>
              )}
              {saving ? "Saving…" : scope ? "Save for this job" : "Save workspace default"}
            </button>
          </div>
        </form>

        <div className="flex flex-col gap-6 xl:sticky xl:top-6 xl:self-start">
          <div className={cardCls}>
            <h3 className="mb-4 text-base font-semibold text-[var(--text)]">Company</h3>
            <label htmlFor="company" className={labelCls}>
              Company name
            </label>
            <input id="company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className={inputCls} />
            <p className={hintCls}>The agent says this out loud when it introduces itself on every call.</p>
            <button type="button" onClick={saveCompany} disabled={!companyName.trim()} className={`${secondaryBtn} mt-4 w-full`}>
              Save company name
            </button>
          </div>

          <div className={cardCls}>
            <label htmlFor="scope" className={labelCls}>
              These settings apply to
            </label>
            <select id="scope" value={scope} onChange={(e) => setScope(e.target.value)} className={inputCls}>
              <option value="">All jobs (workspace default)</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                  {protocols.some((p) => p.jobId === j.id) ? " — has its own settings" : ""}
                </option>
              ))}
            </select>
            <p className={hintCls}>
              {scope
                ? "Overrides the workspace default for this job only."
                : `Used by every job without its own settings.${overrides ? ` ${overrides} job(s) currently override it.` : ""}`}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}