"use client";

import { useState } from "react";
import Dialog from "@/components/Dialog";
import { recommendationChip } from "@/components/JobShell";
import Markdown, { truncateEnd } from "@/components/Markdown";
import Time from "@/components/Time";
import Transcript, { type TranscriptTurn } from "@/components/Transcript";
import { callMinutes, plural } from "@/lib/format";
import { CANDIDATE_STATUS_LABELS, type CandidateStatus } from "@pratibha/shared";

export interface QuestionAnswer {
  question: string;
  answer: string;
  atMs: number;
}

/** One requirement, judged against the CV and the call (J62). */
export interface RequirementFit {
  criterionId?: number;
  requirement: string;
  kind?: "must" | "good";
  status: "met" | "partly" | "not_met";
  evidence: string;
}

export interface InterviewReportData {
  id: string;
  overallScore: number;
  recommendation: string;
  strengths: string[];
  concerns: string[];
  generatedAt: string;
  interviewScore: number | null;
  interviewScoreReasoning: string | null;
  questionAnswers: QuestionAnswer[] | null;
  jdFitSummary: string | null;
  recommendationScore: number | null;
  recommendationVerdict: string | null;
  dimensions?: { recommendationReasoning?: string; requirementFit?: RequirementFit[] } | null;
  interviewCall?: {
    id: string;
    startedAt?: string | null;
    endedAt?: string | null;
    language?: string | null;
    recordingRef?: string | null;
    candidate?: {
      id?: string;
      name?: string | null;
      email?: string | null;
      phoneE164?: string | null;
      status?: CandidateStatus;
    } | null;
  } | null;
}

const LANGUAGES: Record<string, string> = { en: "English", hi: "Hindi", hinglish: "Hinglish" };

/** 0–10 with one decimal, or an honest dash. */
export function scoreText(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(1) : "—";
}

/** The difference between the two scores, when both exist. */
export function scoreGap(report: Pick<InterviewReportData, "interviewScore" | "recommendationScore">): number | null {
  if (typeof report.interviewScore !== "number" || typeof report.recommendationScore !== "number") return null;
  return Math.abs(report.interviewScore - report.recommendationScore);
}

export function reportCandidateName(report: InterviewReportData): string {
  const c = report.interviewCall?.candidate;
  return c?.name || c?.email || c?.phoneE164 || "Unknown candidate";
}

const FIT_CHIP: Record<RequirementFit["status"], { label: string; tone: string }> = {
  met: { label: "Met", tone: "green" },
  partly: { label: "Partly", tone: "amber" },
  not_met: { label: "Not met", tone: "clay" },
};

/**
 * One interview report, in the order a hiring manager reads it: who and when,
 * the two scores, strengths against concerns, fit requirement by requirement,
 * the conversation itself, and then the decision — which is theirs.
 */
export default function InterviewReport({
  tenant,
  report,
  gapThreshold,
  canChangeStatus,
  onChanged,
}: {
  tenant: string;
  report: InterviewReportData;
  gapThreshold: number;
  canChangeStatus: boolean;
  /** After a stage change or a note, so the page can re-read what changed. */
  onChanged: () => void | Promise<void>;
}) {
  const call = report.interviewCall;
  const candidate = call?.candidate;
  const who = reportCandidateName(report);
  const pairs = report.questionAnswers ?? [];
  const fit = (report.dimensions?.requirementFit ?? []).filter((f) => f && f.requirement && f.status in FIT_CHIP);
  const gap = scoreGap(report);
  const minutes = callMinutes(call?.startedAt, call?.endedAt);
  const language = call?.language ? LANGUAGES[call.language] ?? call.language : null;
  const verdict = recommendationChip(report.recommendation);

  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<CandidateStatus | undefined>(candidate?.status);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noting, setNoting] = useState(false);
  const [transcript, setTranscript] = useState<{ turns: TranscriptTurn[] | null; error: string | null } | null>(null);

  /** Manual status change: the same endpoint, audit and timeline as the candidate page. */
  async function setStage(next: CandidateStatus) {
    if (!candidate?.id) return;
    setBusy(next);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/${tenant}/candidates/${candidate.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, reason: "Decided from the interview report" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not change the stage");
      setStatus(next);
      setNotice(`${who} moved to ${CANDIDATE_STATUS_LABELS[next]}.`);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the stage");
    } finally {
      setBusy(null);
    }
  }

  async function openTranscript() {
    if (!call?.id) return;
    setTranscript({ turns: null, error: null });
    try {
      const res = await fetch(`/api/${tenant}/calls/${call.id}/transcript`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Could not load this transcript");
      setTranscript({ turns: body.turns ?? [], error: null });
    } catch (e) {
      setTranscript({ turns: [], error: e instanceof Error ? e.message : "Could not load this transcript" });
    }
  }

  const first = pairs[0];

  return (
    <article className="report-card" aria-labelledby={`report-${report.id}`}>
      {/* Header */}
      <header className="report-top">
        <h2 id={`report-${report.id}`}>{who}</h2>
        <span className="muted small">
          <Time value={call?.startedAt ?? report.generatedAt} />
          {minutes && ` · ${minutes}`}
          {language && ` · ${language}`}
        </span>
        <div className="jm-spacer" />
        {call?.recordingRef ? (
          <a href={call.recordingRef} target="_blank" rel="noopener noreferrer" className="link-strong">
            Listen to recording
          </a>
        ) : (
          <span className="muted small" title="Recordings are not available in the portal for this call">
            No recording
          </span>
        )}
        {call?.id && (
          <button type="button" className="btn-link strong" onClick={openTranscript}>
            Transcript
          </button>
        )}
      </header>

      {/* Score band */}
      <div className="score-band">
        <div className="score-block">
          <div className="score-big">
            {scoreText(report.interviewScore)}
            {typeof report.interviewScore === "number" && <span> / 10</span>}
          </div>
          <div className="score-label">Interview score · how the call itself went</div>
        </div>
        <div className="score-block">
          <div className="score-big">
            {scoreText(report.recommendationScore)}
            {typeof report.recommendationScore === "number" && <span> / 10</span>}
          </div>
          <div className="score-label">Recommendation · the whole picture with the JD and CV</div>
        </div>
        {gap !== null && gap >= gapThreshold && (
          <div className="score-explainer">
            <div className="score-explainer-title">These scores differ by {gap.toFixed(1)}</div>
            <div>
              The interview and the fit for this role are not telling the same story. Both sections below are worth
              reading.
            </div>
          </div>
        )}
      </div>

      {(report.interviewScoreReasoning || report.recommendationVerdict || report.dimensions?.recommendationReasoning) && (
        <details className="report-why">
          <summary>Why these scores</summary>
          {report.interviewScoreReasoning && (
            <div>
              <h3 className="report-sub">Interview score</h3>
              <Markdown source={report.interviewScoreReasoning} />
            </div>
          )}
          {(report.recommendationVerdict || report.dimensions?.recommendationReasoning) && (
            <div>
              <h3 className="report-sub">
                Recommendation <span className={`chip sm chip-${verdict.tone}`}>{verdict.label}</span>
              </h3>
              <Markdown source={report.recommendationVerdict ?? report.dimensions?.recommendationReasoning ?? ""} />
            </div>
          )}
        </details>
      )}

      {/* Strengths and concerns, side by side */}
      <div className="report-cols">
        <div>
          <h3 className="report-sub good">Strengths</h3>
          {report.strengths.length ? (
            <ul className="report-list">
              {report.strengths.map((s, i) => (
                <li key={i}>
                  <Markdown source={s} inline />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None recorded.</p>
          )}
        </div>
        <div>
          <h3 className="report-sub bad">Concerns</h3>
          {report.concerns.length ? (
            <ul className="report-list">
              {report.concerns.map((c, i) => (
                <li key={i}>
                  <Markdown source={c} inline />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None recorded.</p>
          )}
        </div>
      </div>

      {/* Fit — per requirement when the report has it, the paragraph otherwise */}
      <section>
        <h3 className="report-sub">
          {fit.length ? "Fit for this role, requirement by requirement" : "Fit for this role"}
        </h3>
        {fit.length ? (
          <ul className="fit-list">
            {fit.map((f, i) => (
              <li key={i}>
                <span className={`chip sm chip-${FIT_CHIP[f.status].tone}`}>{FIT_CHIP[f.status].label}</span>
                <span>
                  <strong>
                    {f.requirement.replace(/[.\s]+$/, "")}
                    {f.kind === "good" ? ", good to have" : ""}.
                  </strong>{" "}
                  {f.evidence}
                </span>
              </li>
            ))}
          </ul>
        ) : report.jdFitSummary ? (
          <Markdown source={report.jdFitSummary} />
        ) : (
          <p className="muted">No fit summary was recorded. Reports generated before this section existed do not have one.</p>
        )}
      </section>

      {/* The interview, collapsed to its first exchange */}
      <section className="qa-module" aria-label="The interview">
        <div className="card-title-row">
          <h3 className="report-sub">The interview · {plural(pairs.length, "question")}</h3>
          {pairs.length > 1 && (
            <button
              type="button"
              className="btn-link strong"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Collapse" : "Expand all"}
            </button>
          )}
        </div>

        {pairs.length === 0 ? (
          <p className="muted">No question and answer pairs were recorded for this interview.</p>
        ) : expanded ? (
          <ol className="qa-full">
            {pairs.map((p, i) => (
              <li key={i}>
                <div className="qa-q">Pratibha: {p.question}</div>
                <div className="qa-a">{p.answer}</div>
              </li>
            ))}
          </ol>
        ) : (
          <>
            {/* Cut from the end, always from the first word (J04). */}
            <div className="qa-first">
              <div className="qa-q">Pratibha: {truncateEnd(first.question, 240)}</div>
              <div className="qa-a">{truncateEnd(first.answer, 220)}</div>
            </div>
            {pairs.length > 1 && (
              <div className="muted small">{plural(pairs.length - 1, "more question")} collapsed</div>
            )}
          </>
        )}
      </section>

      {/* The decision */}
      {error && <div className="notice notice-error">{error}</div>}
      {notice && (
        <div className="notice notice-success" role="status">
          {notice}
        </div>
      )}
      <footer className="report-foot">
        <button
          type="button"
          className="btn-ink"
          onClick={() => setStage("advance_stage")}
          disabled={!canChangeStatus || !candidate?.id || busy !== null || status === "advance_stage"}
          title={canChangeStatus ? undefined : "Only reviewers and above can change a candidate's stage"}
        >
          {busy === "advance_stage" ? "Saving…" : status === "advance_stage" ? "Advanced" : "Advance stage"}
        </button>
        <button
          type="button"
          className="btn-line"
          onClick={() => setStage("rejected")}
          disabled={!canChangeStatus || !candidate?.id || busy !== null || status === "rejected"}
          title={canChangeStatus ? undefined : "Only reviewers and above can change a candidate's stage"}
        >
          {busy === "rejected" ? "Saving…" : "Not proceeding"}
        </button>
        <button type="button" className="btn-link" onClick={() => setNoting(true)} disabled={!candidate?.id}>
          Add a note
        </button>
        {status && <span className="muted small">Stage: {CANDIDATE_STATUS_LABELS[status]}</span>}
        <div className="jm-spacer" />
        <span className="muted small">Pratibha recommends. You decide.</span>
      </footer>

      {noting && candidate?.id && (
        <NoteDialog
          tenant={tenant}
          candidateId={candidate.id}
          who={who}
          onClose={() => setNoting(false)}
          onSaved={async () => {
            setNoting(false);
            setNotice(`Note added to ${who}'s record.`);
            await onChanged();
          }}
        />
      )}

      {transcript && (
        <Dialog title={`Transcript for ${who}`} onClose={() => setTranscript(null)} wide>
          {transcript.error ? (
            <div className="notice notice-error">{transcript.error}</div>
          ) : transcript.turns === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <Transcript turns={transcript.turns} />
          )}
        </Dialog>
      )}
    </article>
  );
}

function NoteDialog({
  tenant,
  candidateId,
  who,
  onClose,
  onSaved,
}: {
  tenant: string;
  candidateId: string;
  who: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/${tenant}/candidates/${candidateId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(data.message || "The note did not save");
    onSaved();
  }

  return (
    <Dialog title={`Add a note about ${who}`} onClose={onClose} busy={busy}>
      <form onSubmit={save} className="stack">
        <div>
          <label htmlFor="report-note">Note</label>
          <textarea id="report-note" rows={4} value={body} onChange={(e) => setBody(e.target.value)} required />
        </div>
        <p className="muted small">Notes are visible to your team on the candidate&apos;s page.</p>
        {error && <div className="notice notice-error">{error}</div>}
        <div className="jm-dialog-actions">
          <button type="button" className="btn-line" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-ink" disabled={busy || !body.trim()}>
            {busy ? "Saving…" : "Add note"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
