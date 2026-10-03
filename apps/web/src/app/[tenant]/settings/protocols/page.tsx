"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  DEFAULT_PLAN_CONSTANTS,
  estimatePlan,
  formatPlanMinutes,
  GUARDRAIL_ERROR,
  MAX_CUSTOM_QUESTIONS,
  touchesPersonalTopic,
  TRIM_WARNING,
  type PlanConstants,
} from "@pratibha/shared";
import Dialog from "@/components/Dialog";
import { useToast } from "@/components/Toast";

type Difficulty = "easy" | "moderate" | "hard" | "expert";
type Mismatch = "note" | "check" | "end";

interface Protocol {
  id?: string;
  jobId?: string | null;
  instructionText: string;
  durationMinutes: number;
  difficulty: Difficulty;
  minQuestions: number;
  maxQuestions: number;
  focusAreas?: string[] | null;
  agentName?: string | null;
  companyName?: string | null;
  screenNotice: boolean;
  screenSalary: boolean;
  screenReasonLeaving: boolean;
  screenGaps: boolean;
  screenLocation: boolean;
  screenWorkMode: boolean;
  screenTravel: boolean;
  screenReference: boolean;
  shareBand: boolean;
  mismatchAction: Mismatch;
  introduceRole: boolean;
  candidateQuestions: boolean;
  hearBackDays: number | null;
  customQuestions: string[];
}

interface Job {
  id: string;
  title: string;
  status: string;
  salaryMin: number | null;
  salaryMax: number | null;
  overrides: boolean;
}

interface Loaded {
  protocols: Protocol[];
  jobs: Job[];
  constants: PlanConstants;
  tuningAllowed: boolean;
  canEdit: boolean;
  tenantName: string;
}

/** The migration's defaults, for a workspace that has never saved. */
const DEFAULTS: Protocol = {
  jobId: null,
  instructionText: "",
  durationMinutes: 10,
  difficulty: "moderate",
  minQuestions: 6,
  maxQuestions: 10,
  focusAreas: [],
  agentName: null,
  companyName: null,
  screenNotice: true,
  screenSalary: true,
  screenReasonLeaving: true,
  screenGaps: true,
  screenLocation: false,
  screenWorkMode: false,
  screenTravel: false,
  screenReference: false,
  shareBand: true,
  mismatchAction: "check",
  introduceRole: true,
  candidateQuestions: true,
  hearBackDays: 3,
  customQuestions: [],
};

const DIFFICULTY: { value: Difficulty; label: string; hint: string }[] = [
  { value: "easy", label: "Easy", hint: "What they have done. Accepts a good enough answer and moves on. Suits freshers." },
  { value: "moderate", label: "Moderate", hint: "Real work on their CV, one follow up for specifics." },
  { value: "hard", label: "Hard", hint: "Probes trade offs and failures, follows up twice on vague answers." },
  { value: "expert", label: "Expert", hint: "Senior hire depth. Challenges claims that do not hold together." },
];

const SCREENERS: { field: keyof Protocol; label: string; why: string }[] = [
  { field: "screenNotice", label: "Notice period and earliest joining date", why: "The number one reason offers fall through" },
  { field: "screenSalary", label: "Current and expected salary", why: "Handled by your salary policy below" },
  { field: "screenReasonLeaving", label: "Reason for leaving the last job", why: "Asked neutrally, answer goes in the report" },
  { field: "screenGaps", label: "Gaps in the CV, if screening found any", why: "Only asked when a gap exists, so it costs nothing otherwise" },
  { field: "screenLocation", label: "Current location, commute or relocation", why: "Uses the job's location" },
  { field: "screenWorkMode", label: "Work mode expectations", why: "Office, hybrid or field, as the role needs" },
  { field: "screenTravel", label: "Willingness to travel for field work", why: "For sales and service roles" },
  { field: "screenReference", label: "A reference from the last job", why: "Previous manager or HR, name and phone number, for your later checks" },
];

const MISMATCH: { value: Mismatch; label: string }[] = [
  { value: "note", label: "Just note it in the report and carry on" },
  { value: "check", label: "State the band and ask if they can work within it, then note their answer" },
  { value: "end", label: "Politely wrap up the interview and mark the mismatch" },
];

const ALWAYS_TRUE =
  "Candidates are told the call is recorded and assessed, and can decline. One question at a time, wrapped up politely. No commitments: no offers, no joining dates, no pay promises. No personal life questions: religion, caste, marital status, family plans, health. These cannot be switched off, on any plan.";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export default function InterviewSettingsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const toast = useToast();
  const uid = useId();
  const [data, setData] = useState<Loaded | null>(null);
  const [scope, setScope] = useState(""); // "" = workspace default
  const [draft, setDraft] = useState<Protocol>(DEFAULTS);
  const [focusText, setFocusText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [showOverrides, setShowOverrides] = useState(false);

  // Deep link from a job's "Interview setup" card: /settings/protocols?job=<id>
  useEffect(() => {
    const job = new URLSearchParams(window.location.search).get("job");
    if (job) setScope(job);
  }, []);

  const load = useCallback(async () => {
    const r = await fetch(`/api/${tenant}/interview-protocols`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(d.message || "Could not load interview settings");
      return;
    }
    setData(d);
  }, [tenant]);

  useEffect(() => {
    void load();
  }, [load]);

  const workspaceDefault = useMemo(() => data?.protocols.find((p) => !p.jobId), [data]);
  const own = useMemo(() => data?.protocols.find((p) => (p.jobId ?? "") === scope), [data, scope]);
  const job = data?.jobs.find((j) => j.id === scope) ?? null;
  const overriding = data?.jobs.filter((j) => j.overrides) ?? [];

  // Switching scope loads that scope's settings, or the workspace default as
  // the starting point, so a new per job override does not begin empty.
  useEffect(() => {
    const base = own ?? workspaceDefault ?? DEFAULTS;
    setDraft({ ...DEFAULTS, ...base, customQuestions: Array.isArray(base.customQuestions) ? base.customQuestions : [], jobId: scope || null });
    setFocusText((base.focusAreas ?? []).join(", "));
    setError(null);
    setErrorField(null);
  }, [scope, own, workspaceDefault]);

  function set<K extends keyof Protocol>(key: K, value: Protocol[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const questions = [0, 1, 2].map((i) => draft.customQuestions[i] ?? "");
  const setQuestion = (i: number, v: string) => {
    const next = [...questions];
    next[i] = v;
    set("customQuestions", next);
  };

  const plan = useMemo(
    () =>
      estimatePlan(
        {
          durationMinutes: Number(draft.durationMinutes) || 0,
          minQuestions: Number(draft.minQuestions) || 0,
          maxQuestions: Number(draft.maxQuestions) || 0,
          introduceRole: draft.introduceRole,
          candidateQuestions: draft.candidateQuestions,
          customQuestions: draft.customQuestions,
          screeners: {
            notice: draft.screenNotice,
            salary: draft.screenSalary,
            reasonLeaving: draft.screenReasonLeaving,
            gaps: draft.screenGaps,
            location: draft.screenLocation,
            workMode: draft.screenWorkMode,
            travel: draft.screenTravel,
            reference: draft.screenReference,
          },
        },
        data?.constants ?? DEFAULT_PLAN_CONSTANTS
      ),
    [draft, data]
  );

  // The same check the server makes, shown while typing.
  const guardrailOn = (text: string) => touchesPersonalTopic(text);
  const anyGuardrail = questions.some(guardrailOn) || guardrailOn(draft.instructionText);

  async function save() {
    setSaving(true);
    setError(null);
    setErrorField(null);
    try {
      const focusAreas = focusText.split(",").map((s) => s.trim()).filter(Boolean);
      const body = {
        ...(scope ? { jobId: scope } : {}),
        instructionText: draft.instructionText,
        durationMinutes: Number(draft.durationMinutes),
        difficulty: draft.difficulty,
        minQuestions: Number(draft.minQuestions),
        maxQuestions: Number(draft.maxQuestions),
        focusAreas,
        agentName: draft.agentName?.trim() || null,
        companyName: draft.companyName?.trim() || null,
        screenNotice: draft.screenNotice,
        screenSalary: draft.screenSalary,
        screenReasonLeaving: draft.screenReasonLeaving,
        screenGaps: draft.screenGaps,
        screenLocation: draft.screenLocation,
        screenWorkMode: draft.screenWorkMode,
        screenTravel: draft.screenTravel,
        screenReference: draft.screenReference,
        shareBand: draft.shareBand,
        mismatchAction: draft.mismatchAction,
        introduceRole: draft.introduceRole,
        candidateQuestions: draft.candidateQuestions,
        hearBackDays: draft.hearBackDays ? Number(draft.hearBackDays) : null,
        customQuestions: questions.map((q) => q.trim()).filter(Boolean),
      };
      const res = await fetch(`/api/${tenant}/interview-protocols`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.message || "Could not save");
        setErrorField(d.details?.field ?? null);
        return;
      }
      await load();
      toast.show(scope ? `Saved for ${job?.title ?? "this job"}.` : "Workspace default saved.");
    } finally {
      setSaving(false);
    }
  }

  async function revertToDefault(jobId: string) {
    const res = await fetch(`/api/${tenant}/interview-protocols?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d.message || "Could not remove the override");
      return;
    }
    await load();
    toast.show("That job now uses the workspace default.");
  }

  if (!data) {
    return <div className="jm">{error ? <div className="notice notice-error">{error}</div> : <p className="muted">Loading…</p>}</div>;
  }

  const locked = !data.canEdit;
  const tuningLocked = locked || !data.tuningAllowed;
  const diff = DIFFICULTY.find((d) => d.value === draft.difficulty) ?? DIFFICULTY[1];

  return (
    <div className="jm is-page">
      <div className="is-main">
        <div>
          <h1>Interview settings</h1>
          <p className="muted is-sub">
            Decide what Pratibha covers on every call. Each choice costs interview time, and the plan on the right keeps the total honest.
          </p>
        </div>

        {error && !errorField && <div className="notice notice-error" role="alert">{error}</div>}
        {locked && <div className="notice notice-info">Only owners and admins can change interview settings.</div>}

        <section className="is-card" aria-labelledby={`${uid}-basics`}>
          <h2 id={`${uid}-basics`} className="is-title">Basics</h2>
          <div className="is-grid3">
            <Field id={`${uid}-len`} label="Length in minutes">
              <input id={`${uid}-len`} type="number" min={2} max={90} value={draft.durationMinutes} disabled={locked} onChange={(e) => set("durationMinutes", Number(e.target.value))} />
            </Field>
            <Field id={`${uid}-qmin`} label="Minimum questions">
              <input id={`${uid}-qmin`} type="number" min={1} max={40} value={draft.minQuestions} disabled={locked} onChange={(e) => set("minQuestions", Number(e.target.value))} />
            </Field>
            <Field id={`${uid}-qmax`} label="Maximum questions">
              <input id={`${uid}-qmax`} type="number" min={1} max={40} value={draft.maxQuestions} disabled={locked} onChange={(e) => set("maxQuestions", Number(e.target.value))} />
            </Field>
          </div>
          <div className="is-grid2">
            <Field id={`${uid}-diff`} label="Difficulty" help={diff.hint}>
              <select id={`${uid}-diff`} value={draft.difficulty} disabled={tuningLocked} onChange={(e) => set("difficulty", e.target.value as Difficulty)}>
                {DIFFICULTY.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </Field>
            <Field id={`${uid}-focus`} label="Focus areas" help="Questions lean towards these. Leave blank to follow the CV.">
              <input id={`${uid}-focus`} value={focusText} disabled={tuningLocked} placeholder="cold calling, handling objections" onChange={(e) => setFocusText(e.target.value)} />
            </Field>
          </div>
          <p className="is-note">
            The clock starts at the first question. Greeting and consent are free, and an interview that overruns is wrapped up politely, never cut off.
          </p>
        </section>

        {!data.tuningAllowed && (
          <div className="notice notice-info">
            Screeners, salary policy, your own questions, difficulty, focus areas and instructions are part of interview style tuning, which is not on your plan. Length and question counts are on every plan.
          </div>
        )}

        <section className="is-card" aria-labelledby={`${uid}-scr`}>
          <div>
            <h2 id={`${uid}-scr`} className="is-title">Screeners Pratibha always asks</h2>
            <p className="is-desc">The practical questions that decide whether a hire can actually happen. Each adds roughly half a minute.</p>
          </div>
          <div className="is-screeners">
            {SCREENERS.map((s) => (
              <label key={s.field} className="is-tile">
                <input type="checkbox" checked={Boolean(draft[s.field])} disabled={tuningLocked} onChange={(e) => set(s.field, e.target.checked as never)} />
                <span>
                  <span className="is-tile-label">{s.label}</span>
                  <br />
                  <span className="is-tile-why">{s.why}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="is-card" aria-labelledby={`${uid}-sal`}>
          <div>
            <h2 id={`${uid}-sal`} className="is-title">Salary policy</h2>
            <p className="is-desc">
              Applies when salary is asked.{" "}
              {job ? (
                job.salaryMax ? (
                  <>
                    This job&apos;s band: {job.salaryMin ? `${rupees(job.salaryMin)} to ` : "up to "}
                    {rupees(job.salaryMax)} a year.
                  </>
                ) : (
                  <>
                    This job has no band yet. <Link href={`/${tenant}/jobs/${job.id}/edit`}>Set one on the role</Link>.
                  </>
                )
              ) : (
                "The band comes from each job."
              )}
            </p>
          </div>
          <label className="is-check">
            <input type="checkbox" checked={draft.shareBand} disabled={tuningLocked} onChange={(e) => set("shareBand", e.target.checked)} />
            <span>
              <span className="is-tile-label">Share the role&apos;s salary band with the candidate</span>{" "}
              <span className="is-tile-why">so nobody wastes a round on a mismatch</span>
            </span>
          </label>
          <fieldset className="is-radios" disabled={tuningLocked}>
            <legend>If their expectation is above the band</legend>
            {MISMATCH.map((m) => (
              <label key={m.value} className="is-check">
                <input type="radio" name={`${uid}-mismatch`} value={m.value} checked={draft.mismatchAction === m.value} onChange={() => set("mismatchAction", m.value)} />
                <span>{m.label}</span>
              </label>
            ))}
          </fieldset>
          <p className="is-quiet">
            Pratibha never negotiates pay or makes commitments. Numbers are collected and checked against the band; the deciding stays with your team.
          </p>
        </section>

        <section className="is-card" aria-labelledby={`${uid}-conv`}>
          <h2 id={`${uid}-conv`} className="is-title">The conversation</h2>
          <label className="is-check">
            <input type="checkbox" checked={draft.introduceRole} disabled={locked} onChange={(e) => set("introduceRole", e.target.checked)} />
            <span>
              <span className="is-tile-label">Introduce the role before the questions begin</span>{" "}
              <span className="is-tile-why">a half minute summary of the JD, so both sides talk about the same job</span>
            </span>
          </label>
          <label className="is-check">
            <input type="checkbox" checked={draft.candidateQuestions} disabled={locked} onChange={(e) => set("candidateQuestions", e.target.checked)} />
            <span>
              <span className="is-tile-label">Invite the candidate&apos;s questions at the end</span>{" "}
              <span className="is-tile-why">answered from the JD; anything else is taken down for your team</span>
            </span>
          </label>
          <div className="is-check">
            <input
              type="checkbox"
              id={`${uid}-hb`}
              checked={draft.hearBackDays !== null}
              disabled={locked}
              onChange={(e) => set("hearBackDays", e.target.checked ? 3 : null)}
            />
            <span>
              <label htmlFor={`${uid}-hb`} className="is-tile-label">Tell them when they will hear back</label>{" "}
              <span className="is-tile-why">within</span>{" "}
              <input
                className="is-days"
                type="number"
                min={1}
                max={30}
                value={draft.hearBackDays ?? ""}
                disabled={locked || draft.hearBackDays === null}
                aria-label="Working days until candidates hear back"
                onChange={(e) => set("hearBackDays", e.target.value ? Number(e.target.value) : 1)}
              />{" "}
              <span className="is-tile-why">working days</span>
            </span>
          </div>
        </section>

        <section className="is-card" aria-labelledby={`${uid}-own`}>
          <div>
            <h2 id={`${uid}-own`} className="is-title">Your three questions</h2>
            <p className="is-desc">Asked word for word in every interview for this scope. Three at most, because each costs a minute.</p>
          </div>
          {questions.slice(0, MAX_CUSTOM_QUESTIONS).map((q, i) => {
            const bad = guardrailOn(q) || errorField === `customQuestions.${i}`;
            return (
              <div key={i}>
                <input
                  value={q}
                  disabled={tuningLocked}
                  maxLength={300}
                  placeholder={i === 0 ? "Add a question" : i === 1 ? "Add a second question" : "Add a third question"}
                  aria-label={`Custom question ${i + 1}`}
                  aria-invalid={bad || undefined}
                  aria-describedby={bad ? `${uid}-q${i}-err` : undefined}
                  onChange={(e) => setQuestion(i, e.target.value)}
                />
                {bad && (
                  <p id={`${uid}-q${i}-err`} className="is-error" role="alert">
                    {GUARDRAIL_ERROR}
                  </p>
                )}
              </div>
            );
          })}
        </section>

        <div className="is-pair">
          <section className="is-card" aria-labelledby={`${uid}-id`}>
            <h2 id={`${uid}-id`} className="is-title">Identity on calls</h2>
            <Field id={`${uid}-agn`} label="Agent name">
              <input id={`${uid}-agn`} value={draft.agentName ?? ""} placeholder="Pratibha" maxLength={60} disabled={locked} onChange={(e) => set("agentName", e.target.value)} />
            </Field>
            <Field id={`${uid}-hu`} label="Hiring under" help="The name spoken on calls. The legal name on invoices lives in Company profile.">
              <input id={`${uid}-hu`} value={draft.companyName ?? ""} placeholder={data.tenantName} maxLength={120} disabled={locked} onChange={(e) => set("companyName", e.target.value)} />
            </Field>
          </section>
          <section className="is-card" aria-labelledby={`${uid}-else`}>
            <h2 id={`${uid}-else`} className="is-title">Anything else, in your words</h2>
            <textarea
              rows={4}
              value={draft.instructionText}
              disabled={tuningLocked}
              aria-labelledby={`${uid}-else`}
              aria-describedby={`${uid}-else-h`}
              aria-invalid={guardrailOn(draft.instructionText) || errorField === "instructionText" || undefined}
              placeholder="Be warm and concise. This is a target driven role, so probe numbers when they come up."
              onChange={(e) => set("instructionText", e.target.value)}
            />
            {(guardrailOn(draft.instructionText) || errorField === "instructionText") && (
              <p className="is-error" role="alert">{GUARDRAIL_ERROR}</p>
            )}
            <p id={`${uid}-else-h`} className="is-help">
              Tone and special cases. For anything listed above, prefer the switches; they are followed more reliably than prose.
            </p>
          </section>
        </div>

        <section className="is-card" aria-labelledby={`${uid}-fixed`}>
          <div className="is-fixed-head">
            <h2 id={`${uid}-fixed`} className="is-title">Always true, on every call</h2>
            <span className="chip chip-neutral sm">Fixed</span>
          </div>
          <p className="is-body">{ALWAYS_TRUE}</p>
        </section>

        {error && errorField && <div className="notice notice-error" role="alert">{error}</div>}
        {!locked && (
          <div className="is-save">
            <button type="button" className="btn-ink" onClick={save} disabled={saving || anyGuardrail}>
              {saving ? "Saving…" : scope ? `Save for ${job?.title ?? "this job"}` : "Save workspace default"}
            </button>
          </div>
        )}
      </div>

      <aside className="is-rail" aria-label="Scope and plan">
        <section className="is-card is-rail-card">
          <label htmlFor={`${uid}-scope`} className="is-title sm">These settings apply to</label>
          <select id={`${uid}-scope`} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">All jobs (workspace default)</option>
            {data.jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title}
                {j.overrides ? " · own settings" : ""}
              </option>
            ))}
          </select>
          {scope ? (
            <p className="is-help">
              {own ? (
                <>
                  This job has its own settings.{" "}
                  {!locked && (
                    <button type="button" className="btn-link" onClick={() => revertToDefault(scope)}>
                      Use the workspace default
                    </button>
                  )}
                </>
              ) : (
                "Uses the workspace default. Saving gives this job its own settings."
              )}
            </p>
          ) : (
            <p className="is-help">
              Used by every job without its own settings.{" "}
              {overriding.length > 0 ? (
                <>
                  <button type="button" className="btn-link link-strong" onClick={() => setShowOverrides(true)}>
                    {overriding.length} {overriding.length === 1 ? "job overrides" : "jobs override"} it
                  </button>
                  .
                </>
              ) : (
                "No job overrides it."
              )}
            </p>
          )}
        </section>

        <section className="is-card is-rail-card" aria-labelledby={`${uid}-plan`} aria-live="polite">
          <h2 id={`${uid}-plan`} className="is-title sm">The interview this builds</h2>
          <div className="is-total">About {plan.label} minutes</div>
          <ul className="is-lines">
            {plan.lines.map((l) => (
              <li key={l.key}>
                <span>{l.label}</span>
                <span className="muted">{formatPlanMinutes(l.minutes)}</span>
              </li>
            ))}
          </ul>
          {plan.over ? (
            <p className="is-warn" role="status">{TRIM_WARNING(plan.label, Number(draft.durationMinutes) || 0)}</p>
          ) : (
            <p className="is-help">
              Fits your {draft.durationMinutes} minute setting with polite wrap up room. Turn on more screeners and this total updates; go past the length and it will tell you what to trim.
            </p>
          )}
        </section>

        <p className="is-help is-midcall">
          Changes apply to interviews that start after you save. Candidates already mid call finish on the old settings.
        </p>
      </aside>

      {showOverrides && (
        <Dialog title="Jobs with their own settings" onClose={() => setShowOverrides(false)}>
          <ul className="is-overrides">
            {overriding.map((j) => (
              <li key={j.id}>
                <span>{j.title}</span>
                <span className="jm-spacer" />
                <button
                  type="button"
                  className="btn-line sm"
                  onClick={() => {
                    setScope(j.id);
                    setShowOverrides(false);
                  }}
                >
                  Open
                </button>
                {!locked && (
                  <button type="button" className="btn-link" onClick={() => revertToDefault(j.id)}>
                    Use default
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Dialog>
      )}
      {toast.node}
    </div>
  );
}

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="is-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help && <p className="is-help">{help}</p>}
    </div>
  );
}
