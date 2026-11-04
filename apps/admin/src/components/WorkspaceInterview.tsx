"use client";

import { useState } from "react";
import { useToast } from "@/components/ui";
import { EDIT_REFUSAL, EditDialog, Fact } from "@/components/WorkspaceEditKit";
import type { ProtocolForm } from "@/lib/workspace-edit-data";

export interface InterviewRules {
  tuningAllowed: boolean;
  maxCustomQuestions: number;
}

const DIFFICULTY = ["easy", "moderate", "hard", "expert"] as const;
const MISMATCH = [
  { value: "note", label: "Note it in the report" },
  { value: "check", label: "Check they are still interested" },
  { value: "end", label: "End the call politely" },
] as const;
const SCREENERS: { key: keyof ProtocolForm; label: string }[] = [
  { key: "screenNotice", label: "Notice period" },
  { key: "screenSalary", label: "Salary expectation" },
  { key: "screenReasonLeaving", label: "Reason for leaving" },
  { key: "screenGaps", label: "Gaps in the CV" },
  { key: "screenLocation", label: "Location" },
  { key: "screenWorkMode", label: "Work mode" },
  { key: "screenTravel", label: "Travel" },
  { key: "screenReference", label: "References" },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The Interview tab: the workspace-wide settings every job without its own uses. */
export function WorkspaceInterview({
  wsId,
  protocol,
  rules,
  updatedAt,
  overrides,
  canEdit,
}: {
  wsId: string;
  protocol: ProtocolForm;
  rules: InterviewRules;
  updatedAt: string | null;
  overrides: number;
  canEdit: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const screeners = SCREENERS.filter((s) => protocol[s.key]).map((s) => s.label);

  return (
    <>
      <div className="card card-pad">
        <div className="card-row">
          <div className="grow card-title">Interview settings · version {protocol.version || "not saved"}</div>
          <button className="btn sm" onClick={() => setOpen(true)} disabled={!canEdit} title={canEdit ? undefined : EDIT_REFUSAL}>Edit</button>
        </div>
        <Fact label="Length">{protocol.durationMinutes} minutes, {protocol.minQuestions} to {protocol.maxQuestions} questions</Fact>
        <Fact label="Difficulty">{cap(protocol.difficulty)}</Fact>
        <Fact label="Introduces itself as">{protocol.agentName ?? "Pratibha"} from {protocol.companyName ?? "the workspace name"}</Fact>
        <Fact label="Focus areas">{protocol.focusAreas.length ? protocol.focusAreas.join(", ") : "Follows the CV"}</Fact>
        <Fact label="Screeners">{screeners.length ? screeners.join(", ") : "None"}</Fact>
        <Fact label="Salary">
          {protocol.shareBand ? "Shares the band" : "Does not share the band"}; on a mismatch, {MISMATCH.find((m) => m.value === protocol.mismatchAction)?.label.toLowerCase()}
        </Fact>
        <Fact label="Custom questions">{protocol.customQuestions.length ? protocol.customQuestions.join("\n") : "None"}</Fact>
        <div className="card-foot">
          {updatedAt ? `First saved ${updatedAt}; the row keeps no edit time. ` : ""}
          {overrides ? `${overrides} ${overrides === 1 ? "job has" : "jobs have"} their own settings (Jobs tab). ` : ""}
          {rules.tuningAllowed ? "" : "Their plan does not include interview tuning, so only length and question counts can change."}
        </div>
      </div>
      {open && (
        <InterviewDialog wsId={wsId} protocol={protocol} rules={rules} title="Workspace interview settings"
          onClose={() => setOpen(false)} onDone={(m) => { setOpen(false); toast.show(m); }} />
      )}
      {toast.node}
    </>
  );
}

/**
 * Every field the portal's Interview settings page edits, for the workspace or
 * (with jobId) one job. Sends the whole form, as the portal does.
 */
export function InterviewDialog({
  wsId,
  jobId,
  protocol,
  rules,
  title,
  onClose,
  onDone,
}: {
  wsId: string;
  jobId?: string;
  protocol: ProtocolForm;
  rules: InterviewRules;
  title: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [form, setForm] = useState<ProtocolForm>(protocol);
  const [focus, setFocus] = useState(protocol.focusAreas.join(", "));
  const set = <K extends keyof ProtocolForm>(key: K, value: ProtocolForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const locked = !rules.tuningAllowed;
  const questions = Array.from({ length: rules.maxCustomQuestions }, (_, i) => form.customQuestions[i] ?? "");

  return (
    <EditDialog title={title} path={`/api/workspaces/${wsId}/interview`} confirm="Save settings" width={640} onClose={onClose} onDone={onDone}
      payload={() => ({
        ...(jobId ? { jobId } : {}),
        // Always sent: the schema reads a missing one as empty.
        instructionText: form.instructionText,
        durationMinutes: Number(form.durationMinutes),
        minQuestions: Number(form.minQuestions),
        maxQuestions: Number(form.maxQuestions),
        agentName: form.agentName?.trim() || null,
        companyName: form.companyName?.trim() || null,
        introduceRole: form.introduceRole,
        candidateQuestions: form.candidateQuestions,
        hearBackDays: form.hearBackDays === null || String(form.hearBackDays) === "" ? null : Number(form.hearBackDays),
        // Without tuning on the plan these are left out, so they keep whatever
        // they were rather than tripping the plan gate on a reformatted value.
        ...(locked
          ? {}
          : {
              difficulty: form.difficulty,
              focusAreas: focus.split(",").map((s) => s.trim()).filter(Boolean),
              ...Object.fromEntries(SCREENERS.map((s) => [s.key, form[s.key]])),
              shareBand: form.shareBand,
              mismatchAction: form.mismatchAction,
              customQuestions: questions.map((q) => q.trim()).filter(Boolean),
            }),
      })}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "52vh", overflowY: "auto", paddingRight: 4 }}>
        {locked && <div className="notice">Their plan does not include interview tuning. Length and question counts can still change.</div>}
        <div className="grid-3" style={{ gap: 10 }}>
          <NumberField id="iv-len" label="Length, minutes" value={form.durationMinutes} min={2} max={90} onChange={(v) => set("durationMinutes", v)} />
          <NumberField id="iv-min" label="Fewest questions" value={form.minQuestions} min={1} max={40} onChange={(v) => set("minQuestions", v)} />
          <NumberField id="iv-max" label="Most questions" value={form.maxQuestions} min={1} max={40} onChange={(v) => set("maxQuestions", v)} />
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div className="field">
            <label className="label" htmlFor="iv-diff">Difficulty</label>
            <select id="iv-diff" className="select" value={form.difficulty} disabled={locked} onChange={(e) => set("difficulty", e.target.value)}>
              {DIFFICULTY.map((d) => <option key={d} value={d}>{cap(d)}</option>)}
            </select>
          </div>
          <NumberField id="iv-hear" label="Hear back within, days" value={form.hearBackDays ?? ""} min={1} max={30} allowEmpty
            onChange={(v) => set("hearBackDays", Number.isNaN(v) ? null : v)} />
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div className="field">
            <label className="label" htmlFor="iv-agent">Agent name</label>
            <input id="iv-agent" className="input" maxLength={60} value={form.agentName ?? ""} placeholder="Pratibha" onChange={(e) => set("agentName", e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="iv-company">Company name said on calls</label>
            <input id="iv-company" className="input" maxLength={120} value={form.companyName ?? ""} placeholder="The workspace name" onChange={(e) => set("companyName", e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="iv-focus">Focus areas, comma separated</label>
          <input id="iv-focus" className="input" value={focus} disabled={locked} placeholder="Leave blank to follow the CV" onChange={(e) => setFocus(e.target.value)} />
        </div>
        <div className="field">
          <span className="label">Screeners asked near the end</span>
          <div className="pills">
            {SCREENERS.map((s) => (
              <button key={s.key} type="button" disabled={locked} className={`pill${form[s.key] ? " on" : ""}`}
                onClick={() => set(s.key, !form[s.key] as never)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div className="field">
            <label className="label" htmlFor="iv-mismatch">On a salary mismatch</label>
            <select id="iv-mismatch" className="select" value={form.mismatchAction} disabled={locked} onChange={(e) => set("mismatchAction", e.target.value)}>
              {MISMATCH.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          <div className="field">
            <span className="label">Conversation</span>
            <Check label="Shares the salary band" checked={form.shareBand} disabled={locked} onChange={(v) => set("shareBand", v)} />
            <Check label="Introduces the role" checked={form.introduceRole} onChange={(v) => set("introduceRole", v)} />
            <Check label="Takes the candidate's questions" checked={form.candidateQuestions} onChange={(v) => set("candidateQuestions", v)} />
          </div>
        </div>
        {rules.maxCustomQuestions > 0 && (
          <div className="field">
            <span className="label">Custom questions, asked word for word ({rules.maxCustomQuestions} at most)</span>
            {questions.map((q, i) => (
              <input key={i} className="input" maxLength={300} value={q} disabled={locked} aria-label={`Custom question ${i + 1}`}
                onChange={(e) => {
                  const next = [...questions];
                  next[i] = e.target.value;
                  set("customQuestions", next);
                }} />
            ))}
            <span className="hint">Questions about religion, caste, marriage, family plans or health are refused.</span>
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor="iv-instr">Anything else, in their words</label>
          <textarea id="iv-instr" className="textarea" maxLength={20000} value={form.instructionText} disabled={locked}
            onChange={(e) => set("instructionText", e.target.value)} />
        </div>
      </div>
    </EditDialog>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
  allowEmpty,
}: {
  id: string;
  label: string;
  value: number | string;
  min: number;
  max: number;
  onChange: (v: number) => void;
  allowEmpty?: boolean;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} className="input" type="number" min={min} max={max} value={value}
        onChange={(e) => onChange(allowEmpty && e.target.value === "" ? NaN : Number(e.target.value))} />
    </div>
  );
}

function Check({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
