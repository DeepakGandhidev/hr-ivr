"use client";

import { useState } from "react";
import Transcript from "@/components/Transcript";

export interface QuestionAnswer {
  question: string;
  answer: string;
  atMs: number;
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
  dimensions?: { recommendationReasoning?: string } | null;
  interviewCall?: {
    id: string;
    startedAt?: string | null;
    candidate?: { name?: string | null; email?: string | null; phoneE164?: string | null } | null;
  } | null;
}

/** 0–10 with one decimal, or an honest dash. */
function scoreText(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(1) : "—";
}

/**
 * One interview report, in four sections.
 *
 * The order is the order a hiring manager reads in: the score first, then the
 * evidence for it, then the analysis, then the verdict. Sections 1 and 4 carry
 * two different scores and are deliberately far apart on the page — putting
 * them side by side invites reading them as one number checked twice.
 */
export default function InterviewReport({ report }: { report: InterviewReportData }) {
  const pairs = report.questionAnswers ?? [];
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const allOpen = pairs.length > 0 && expanded.size === pairs.length;

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    setExpanded(allOpen ? new Set() : new Set(pairs.map((_, i) => i)));
  }

  const who =
    report.interviewCall?.candidate?.name ||
    report.interviewCall?.candidate?.email ||
    report.interviewCall?.candidate?.phoneE164 ||
    "Unknown candidate";

  return (
    <article className="card report">
      <header className="report-head">
        <div>
          <h2 style={{ margin: 0 }}>{who}</h2>
          <p className="subtle" style={{ margin: "2px 0 0" }}>
            Interviewed {new Date(report.generatedAt).toLocaleString()}
          </p>
        </div>
      </header>

      {/* ---- 1. Interview score ------------------------------------------ */}
      <section className="report-section">
        <h3 className="report-section-title">1 · Interview score</h3>
        <div className="report-score-row">
          <span className={`score lg${(report.interviewScore ?? 0) >= 7 ? " hi" : ""}`}>
            {scoreText(report.interviewScore)}
          </span>
          <span className="subtle">out of 10 — how the interview itself went</span>
        </div>
        {report.interviewScoreReasoning ? (
          <p className="report-prose">{report.interviewScoreReasoning}</p>
        ) : (
          <p className="subtle report-prose">
            No written reasoning was recorded for this score. Reports generated
            before the interview sections were added carry the score only.
          </p>
        )}
      </section>

      {/* ---- 2. The interview -------------------------------------------- */}
      <section className="report-section">
        <div className="report-section-head">
          <h3 className="report-section-title">2 · The interview</h3>
          {pairs.length > 0 && (
            <button className="sm ghost" onClick={toggleAll}>
              {allOpen ? "Collapse all" : "Expand all"}
            </button>
          )}
        </div>

        {pairs.length === 0 ? (
          <p className="subtle" style={{ margin: 0 }}>
            No question-and-answer pairs were recorded for this interview.
          </p>
        ) : (
          <ol className="qa-list">
            {pairs.map((pair, i) => {
              const open = expanded.has(i);
              return (
                <li key={i} className="qa-item">
                  <button
                    className="qa-question"
                    aria-expanded={open}
                    onClick={() => toggle(i)}
                  >
                    <span className="qa-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
                    <span>{pair.question}</span>
                  </button>

                  {/* The same component the Calls section uses, given this one
                      exchange. Reused rather than reimplemented so the two
                      cannot drift apart. */}
                  {open && (
                    <div className="qa-answer">
                      <Transcript
                        turns={[
                          { speaker: "pratibha", text: pair.question, atMs: pair.atMs },
                          { speaker: "candidate", text: pair.answer, atMs: pair.atMs },
                        ]}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ---- 3. Analysis -------------------------------------------------- */}
      <section className="report-section">
        <h3 className="report-section-title">3 · Analysis</h3>

        <div className="report-columns">
          <div>
            <h4 className="report-sub">Strengths</h4>
            {report.strengths.length ? (
              <ul className="report-list">
                {report.strengths.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            ) : (
              <p className="subtle" style={{ margin: 0 }}>None recorded.</p>
            )}
          </div>

          <div>
            <h4 className="report-sub">Concerns</h4>
            {report.concerns.length ? (
              <ul className="report-list">
                {report.concerns.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            ) : (
              <p className="subtle" style={{ margin: 0 }}>None recorded.</p>
            )}
          </div>
        </div>

        <h4 className="report-sub" style={{ marginTop: 14 }}>Fit for this role</h4>
        {report.jdFitSummary ? (
          <p className="report-prose">{report.jdFitSummary}</p>
        ) : (
          <p className="subtle report-prose">
            No fit summary was recorded. Reports generated before this section
            existed do not have one.
          </p>
        )}
      </section>

      {/* ---- 4. Recommendation -------------------------------------------- */}
      <section className="report-section report-verdict">
        <h3 className="report-section-title">4 · Recommendation</h3>
        <div className="report-score-row">
          <span className={`score lg${(report.recommendationScore ?? 0) >= 7 ? " hi" : ""}`}>
            {scoreText(report.recommendationScore)}
          </span>
          <span className="subtle">
            out of 10 — the whole picture: role requirements, CV screening and interview
          </span>
        </div>

        <p className="report-prose">
          <span className="badge badge-neutral" style={{ marginRight: 8 }}>
            {report.recommendation.replace(/_/g, " ")}
          </span>
          {report.recommendationVerdict ??
            report.dimensions?.recommendationReasoning ??
            "No written verdict was recorded."}
        </p>

        {/* Said plainly rather than left for the reader to notice: the two
            scores measure different things and are supposed to be able to
            disagree. */}
        {typeof report.interviewScore === "number" &&
          typeof report.recommendationScore === "number" &&
          Math.abs(report.interviewScore - report.recommendationScore) >= 2 && (
            <p className="notice notice-info" style={{ marginTop: 10 }}>
              These two scores differ by{" "}
              {Math.abs(report.interviewScore - report.recommendationScore).toFixed(1)}.
              The interview and the fit for this role are not telling the same
              story — worth reading both sections above.
            </p>
          )}
      </section>
    </article>
  );
}
