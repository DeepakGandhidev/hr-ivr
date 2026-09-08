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

const DIFFICULTY: Array<{ value: Protocol["difficulty"]; label: string; hint: string }> = [
  { value: "easy", label: "Easy", hint: "What they have done. Accepts a good-enough answer and moves on. Suits freshers." },
  { value: "moderate", label: "Moderate", hint: "Real work on their CV, one follow-up for specifics. The usual choice." },
  { value: "hard", label: "Hard", hint: "Probes trade-offs and failures, follows up twice on vague answers." },
  { value: "expert", label: "Expert", hint: "Senior-hire depth. Challenges claims that do not hold together." },
];

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

  async function saveCompany() {
    setError(null);
    setMessage(null);
    const res = await fetch(`/api/${tenant}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: companyName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data.message || "Failed to save company name");
      return;
    }
    setMessage("Company name updated. The agent will use it on the next call.");
  }

  const scopeLabel = scope ? jobs.find((j) => j.id === scope)?.title ?? "this job" : "all jobs";
  const overrides = protocols.filter((p) => p.jobId).length;

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="page-head">
        <h1>Interview settings</h1>
        <p className="muted">
          How long each interview runs, how hard it is, and what the agent calls
          itself. Set a workspace default, then override it per job.
        </p>
      </div>

      {error && <div className="notice notice-error" style={{ marginBottom: 16 }}>{error}</div>}
      {message && <div className="notice notice-success" style={{ marginBottom: 16 }}>{message}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Company</h3>
        <label htmlFor="company">Company name</label>
        <input id="company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
        <p className="subtle" style={{ marginTop: 4 }}>
          The agent says this out loud when it introduces itself on every call.
        </p>
        <button type="button" onClick={saveCompany} disabled={!companyName.trim()}>
          Save company name
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <label htmlFor="scope">These settings apply to</label>
        <select id="scope" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All jobs (workspace default)</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title}
              {protocols.some((p) => p.jobId === j.id) ? " — has its own settings" : ""}
            </option>
          ))}
        </select>
        <p className="subtle" style={{ marginTop: 4, marginBottom: 0 }}>
          {scope
            ? "Overrides the workspace default for this job only."
            : `Used by every job without its own settings.${overrides ? ` ${overrides} job(s) currently override it.` : ""}`}
        </p>
      </div>

      <form onSubmit={save} className="card stack">
        <h3 style={{ marginBottom: 0 }}>Interview for {scopeLabel}</h3>

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <div>
            <label htmlFor="duration">Length (minutes)</label>
            <input
              id="duration"
              type="number"
              min={2}
              max={90}
              value={draft.durationMinutes}
              onChange={(e) => set("durationMinutes", Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="minq">Minimum questions</label>
            <input
              id="minq"
              type="number"
              min={1}
              max={40}
              value={draft.minQuestions}
              onChange={(e) => set("minQuestions", Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="maxq">Maximum questions</label>
            <input
              id="maxq"
              type="number"
              min={1}
              max={40}
              value={draft.maxQuestions}
              onChange={(e) => set("maxQuestions", Number(e.target.value))}
            />
          </div>
        </div>
        <p className="subtle" style={{ marginTop: -8 }}>
          The clock starts at the first question, not when the phone is answered
          — greeting and consent do not eat into the interview. An interview that
          overruns is wrapped up politely rather than cut off.
        </p>

        <div>
          <label htmlFor="difficulty">Difficulty</label>
          <select
            id="difficulty"
            value={draft.difficulty}
            onChange={(e) => set("difficulty", e.target.value as Protocol["difficulty"])}
          >
            {DIFFICULTY.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
          <p className="subtle" style={{ marginTop: 4 }}>
            {DIFFICULTY.find((d) => d.value === draft.difficulty)?.hint}
          </p>
        </div>

        <div>
          <label htmlFor="focus">Focus areas</label>
          <input
            id="focus"
            value={focusText}
            onChange={(e) => setFocusText(e.target.value)}
            placeholder="system design, React performance, team leadership"
          />
          <p className="subtle" style={{ marginTop: 4 }}>
            Comma separated. Questions lean towards these; leave blank to follow the CV.
          </p>
        </div>

        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div>
            <label htmlFor="agentName">Agent name</label>
            <input
              id="agentName"
              value={draft.agentName ?? ""}
              onChange={(e) => set("agentName", e.target.value)}
              placeholder="Pratibha"
            />
          </div>
          <div>
            <label htmlFor="brand">Hiring under (optional)</label>
            <input
              id="brand"
              value={draft.companyName ?? ""}
              onChange={(e) => set("companyName", e.target.value)}
              placeholder={companyName || "your company"}
            />
          </div>
        </div>
        <p className="subtle" style={{ marginTop: -8 }}>
          Set a different brand here if this role is hired under another name.
        </p>

        <div>
          <label htmlFor="instructions">Instructions for the interviewer</label>
          <textarea
            id="instructions"
            value={draft.instructionText}
            onChange={(e) => set("instructionText", e.target.value)}
            rows={8}
          />
          <p className="subtle" style={{ marginTop: 4 }}>
            Tone and anything off-limits. Safety rules and the interview
            structure are enforced separately and cannot be overridden here.
          </p>
        </div>

        <div>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : scope ? "Save for this job" : "Save workspace default"}
          </button>
        </div>
      </form>
    </div>
  );
}
