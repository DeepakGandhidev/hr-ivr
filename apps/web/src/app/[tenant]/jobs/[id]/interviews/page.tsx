"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import InterviewReport, {
  reportCandidateName,
  scoreGap,
  scoreText,
  type InterviewReportData,
} from "@/components/InterviewReport";
import { JobShellError, JobTabHeader, JobTabs, recommendationChip, useJobSummary } from "@/components/JobShell";
import { firstSentence } from "@/components/Markdown";
import Time from "@/components/Time";
import { callMinutes } from "@/lib/format";

/**
 * A job's interviews: a table first, one report at a time underneath.
 *
 * Reports used to render fully stacked, which buried the second candidate under
 * the first one's whole conversation. The table answers "who, how did it go,
 * what does Pratibha think" at a glance; a report opens only when asked for.
 */
export default function InterviewsPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const searchParams = useSearchParams();
  const { summary, error: summaryError, refresh } = useJobSummary();
  const [reports, setReports] = useState<InterviewReportData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(searchParams.get("report"));
  const reportRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/${tenant}/jobs/${id}/interviews`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Could not load interviews");
      setReports(data.reports ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load interviews");
    }
  }, [tenant, id]);

  useEffect(() => {
    load();
  }, [load]);

  // Arriving from "View report" on the Candidates tab lands on that report.
  useEffect(() => {
    if (reports && openId) reportRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reports, openId]);

  if (summaryError) return <JobShellError />;

  const n = reports?.length ?? 0;
  const gapThreshold = summary?.config.scoreGapThreshold ?? 2;
  const open = reports?.find((r) => r.id === openId) ?? null;

  return (
    <div className="jm">
      <JobTabHeader
        title="Interviews"
        intro={
          n === 0
            ? "No interviews completed yet. Reports are ready within minutes of each call."
            : `${n} completed. Reports are ready within minutes of each call. Pratibha recommends, you decide.`
        }
      />
      <JobTabs active="interviews" />

      {error && <div className="notice notice-error">{error}</div>}

      {reports === null ? (
        <p className="muted">Loading…</p>
      ) : n === 0 ? (
        <div className="jm-card empty">
          <p className="muted">
            A report appears here once a candidate has been interviewed and the assessment has been written.
          </p>
        </div>
      ) : (
        <>
          <div className="jm-card flush">
            <table className="rtable iv-table">
              <caption className="visually-hidden">Completed interviews</caption>
              <colgroup>
                <col className="c-name" />
                <col className="c-when" />
                <col className="c-num" />
                <col className="c-fit" />
                <col className="c-verdict" />
                <col />
                <col className="c-open" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Candidate</th>
                  <th scope="col">When</th>
                  <th scope="col">Interview</th>
                  <th scope="col">Fit</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">In one line</th>
                  <th scope="col">
                    <span className="visually-hidden">Report</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const who = reportCandidateName(r);
                  const gap = scoreGap(r);
                  const verdict = recommendationChip(r.recommendation);
                  const minutes = callMinutes(r.interviewCall?.startedAt, r.interviewCall?.endedAt);
                  const line = firstSentence(r.recommendationVerdict ?? r.dimensions?.recommendationReasoning ?? "");
                  const isOpen = r.id === openId;
                  return (
                    <tr key={r.id} className={isOpen ? "is-open" : undefined}>
                      <td data-label="Candidate" className="cell-name">
                        {who}
                      </td>
                      <td data-label="When" className="cell-when">
                        <Time value={r.interviewCall?.startedAt ?? r.generatedAt} />
                        {minutes && ` · ${minutes}`}
                      </td>
                      <td data-label="Interview">
                        <span className="num">{scoreText(r.interviewScore)}</span>
                        {typeof r.interviewScore === "number" && <span className="muted small"> / 10</span>}
                      </td>
                      <td data-label="Fit">
                        <span className="num">{scoreText(r.recommendationScore)}</span>
                        {typeof r.recommendationScore === "number" && <span className="muted small"> / 10</span>}
                        {gap !== null && gap >= gapThreshold && (
                          <span className="gap-badge" title="The interview and fit scores disagree">
                            gap {gap.toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td data-label="Verdict">
                        <span className={`chip chip-${verdict.tone}`}>{verdict.label}</span>
                      </td>
                      <td data-label="In one line">
                        <span className="why-text" title={line}>
                          {line || "—"}
                        </span>
                      </td>
                      <td data-label="Report" className="cell-actions">
                        <button
                          type="button"
                          className="btn-link strong"
                          aria-expanded={isOpen}
                          aria-controls="open-report"
                          aria-label={`${isOpen ? "Close" : "Open"} the report for ${who}`}
                          onClick={() => setOpenId(isOpen ? null : r.id)}
                        >
                          {isOpen ? (
                            <>
                              Reading <span aria-hidden="true">↓</span>
                            </>
                          ) : (
                            "Open"
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div id="open-report" ref={reportRef}>
            {open && (
              <InterviewReport
                key={open.id}
                tenant={tenant}
                report={open}
                gapThreshold={gapThreshold}
                canChangeStatus={Boolean(summary?.permissions.canChangeStatus)}
                onChanged={async () => {
                  await Promise.all([load(), refresh()]);
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
