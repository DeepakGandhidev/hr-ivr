"use client";

import Dialog from "@/components/Dialog";
import Markdown from "@/components/Markdown";
import Time from "@/components/Time";

interface Screening {
  score: number;
  verdict: string;
  reasonSummary: string;
  matchedMustHaves: string[] | null;
  gaps: string[] | null;
  createdAt: string;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

/**
 * The whole screening result for one candidate.
 *
 * Nothing here is truncated. The reason exists to be read — it is the argument
 * for or against someone — and the table it came from shows only its first
 * line, so the full text lives here, rendered rather than as raw markdown.
 */
export default function ScreeningDetail({
  who,
  screening,
  threshold = 70,
  onClose,
}: {
  who: string;
  screening: Screening;
  /** The job's screening threshold, which decides the score's colour. */
  threshold?: number;
  onClose: () => void;
}) {
  const matched = asList(screening.matchedMustHaves);
  const gaps = asList(screening.gaps);
  const suggested = screening.verdict === "shortlist";

  return (
    <Dialog title={`Screening for ${who}`} onClose={onClose}>
      <div className="screening-head">
        <span className={`chip ${screening.score >= threshold ? "chip-green" : "chip-amber"}`}>
          Score {screening.score}
        </span>
        <span className={`chip ${suggested ? "chip-green" : "chip-neutral"}`}>
          {suggested ? "Suggested" : "Not suggested"}
        </span>
        <span className="muted small">
          Screened <Time value={screening.createdAt} />
        </span>
      </div>

      <section className="screening-section">
        <h3 className="req-head">Reason</h3>
        {screening.reasonSummary ? (
          <Markdown source={screening.reasonSummary} />
        ) : (
          <p className="muted">No reason recorded.</p>
        )}
      </section>

      <div className="req-cols">
        <section>
          <h3 className="req-head">Matched requirements</h3>
          {matched.length ? (
            <ul className="evidence">
              {matched.map((m, i) => (
                <li key={i}>
                  <CheckIcon />
                  <Markdown source={m} inline />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None recorded.</p>
          )}
        </section>

        <section>
          <h3 className="req-head">Gaps</h3>
          {gaps.length ? (
            <ul className="report-list">
              {gaps.map((g, i) => (
                <li key={i}>
                  <Markdown source={g} inline />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None recorded.</p>
          )}
        </section>
      </div>
    </Dialog>
  );
}

export function CheckIcon() {
  return (
    <svg className="check-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
