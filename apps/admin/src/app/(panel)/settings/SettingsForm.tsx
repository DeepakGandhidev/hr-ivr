"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { useToast } from "@/components/ui";

type Values = {
  "screening.suggest_threshold": string;
  "pipeline.junk_hint": boolean;
  "report.score_gap_threshold": string;
  "interview.screener_seconds": string;
  "lists.page_size": string;
  "company.description_cap": string;
  "gate.portal_posts": string;
  "gate.interview_tuning": string;
};

export function SettingsForm({
  initial,
  canEdit,
  refusal,
  gates,
}: {
  initial: Values;
  canEdit: boolean;
  refusal: string;
  gates: { value: string; label: string }[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/settings", {
        ...v,
        "screening.suggest_threshold": Number(v["screening.suggest_threshold"]),
        "report.score_gap_threshold": Number(v["report.score_gap_threshold"]),
        "interview.screener_seconds": Number(v["interview.screener_seconds"]),
        "lists.page_size": Number(v["lists.page_size"]),
        "company.description_cap": Number(v["company.description_cap"]),
      });
      toast.show(res.message);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const num = (k: keyof Values, label: string) => (
    <div className="card-row" style={{ fontSize: 13.5 }}>
      <span className="grow">{label}</span>
      <input className="input center" style={{ width: 80, padding: "7px 10px", fontSize: 13 }} aria-label={label} value={v[k] as string}
        onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/[^\d.]/g, "") })} disabled={!canEdit} />
    </div>
  );
  const gate = (k: keyof Values, label: string) => (
    <div className="card-row" style={{ fontSize: 13.5 }}>
      <span className="grow">{label}</span>
      <select className="select" style={{ width: 190, padding: "7px 10px", fontSize: 13 }} aria-label={label} value={v[k] as string}
        onChange={(e) => setV({ ...v, [k]: e.target.value })} disabled={!canEdit}>
        {gates.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
      </select>
    </div>
  );

  return (
    <>
      <div>
        <h1 className="page-title">Platform settings</h1>
        <p className="page-sub">Every tunable the product runs on, with a face instead of a constant in code. Changes apply immediately, to every workspace.</p>
      </div>
      {!canEdit && <div className="notice">{refusal}</div>}
      <div className="grid-2">
        <div className="card card-pad" style={{ gap: 11 }}>
          <div className="card-title">Screening</div>
          {num("screening.suggest_threshold", "Suggest for shortlist at score")}
          <div className="hint">Drives the Suggested chip and the green score bars, Batch 4 and 7. A job with its own threshold keeps it.</div>
          <div className="card-row" style={{ fontSize: 13.5, borderTop: "1px solid var(--line-soft)", paddingTop: 11 }}>
            <span className="grow">Junk hint on the Pipeline</span>
            <input type="checkbox" checked={v["pipeline.junk_hint"]} onChange={(e) => setV({ ...v, "pipeline.junk_hint": e.target.checked })}
              disabled={!canEdit} aria-label="Junk heuristic" style={{ width: 16, height: 16, accentColor: "#1E1B4B" }} />
          </div>
          <div className="hint">No phone, no job and a subject sourced name together suggest Not an application.</div>
        </div>
        <div className="card card-pad" style={{ gap: 11 }}>
          <div className="card-title">Interviews and reports</div>
          {num("report.score_gap_threshold", "Score gap badge from")}
          {num("interview.screener_seconds", "Estimated seconds per screener")}
          <div className="hint">Feed the report gap badge and the interview plan card, Batch 4 and 6.</div>
        </div>
        <div className="card card-pad" style={{ gap: 11 }}>
          <div className="card-title">Lists and paging</div>
          {num("lists.page_size", "Rows per page")}
          {num("company.description_cap", "Description length cap")}
          <div className="hint">Batch 7 pagination and Batch 8 company description. Rows per page also pages this panel.</div>
        </div>
        <div className="card card-pad" style={{ gap: 11 }}>
          <div className="card-row">
            <div className="grow card-title">Plan gates</div>
            <span className="chip sm chip-amber">D1 awaiting Gaurav</span>
          </div>
          {gate("gate.portal_posts", "Portal posts, Naukri and LinkedIn")}
          {gate("gate.interview_tuning", "Interview tuning: screeners, salary policy, custom questions")}
          <div className="hint">Every plan today, as the portal behaves now. Growth and above is the proposed default from Batch 6.</div>
        </div>
      </div>
      <div className="card-row" style={{ gap: 14 }}>
        <div className="hint" style={{ fontSize: 12.5 }}>Every change here lands in the Activity log with the old and new value.</div>
        <div className="grow" />
        {error && <div className="error-text" role="alert">{error}</div>}
        {canEdit && <button className="btn btn-primary" style={{ padding: "12px 22px", fontSize: 14 }} onClick={save} disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</button>}
      </div>
      {toast.node}
    </>
  );
}
