"use client";

import { useEffect } from "react";

interface Screening {
  score: number;
  verdict: string;
  reasonSummary: string;
  matchedMustHaves: string[] | null;
  gaps: string[] | null;
  createdAt: string;
}

/**
 * The whole screening result for one candidate.
 *
 * Nothing here is truncated. The reason exists to be read — it is the argument
 * for or against someone — and the table it came from could only show it by
 * making every row a different height. So the table gets a fixed-height control
 * and the full text lives here, where there is room for it.
 */
export default function ScreeningDetail({
  who,
  screening,
  onClose,
}: {
  who: string;
  screening: Screening;
  onClose: () => void;
}) {
  // Escape closes it. A modal that can only be dismissed by finding the button
  // is a modal people feel trapped by.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matched = screening.matchedMustHaves ?? [];
  const gaps = screening.gaps ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Screening detail for ${who}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 4 }}>
          <strong>{who}</strong>
          <button className="ghost sm" style={{ marginLeft: "auto" }} onClick={onClose}>
            Close
          </button>
        </div>

        <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 14 }}>
          <span className={`score${screening.score >= 75 ? " hi" : ""}`}>{screening.score}</span>
          <span className="badge badge-neutral">{screening.verdict}</span>
          <span className="subtle">
            Screened {new Date(screening.createdAt).toLocaleDateString()}
          </span>
        </div>

        <section style={{ marginBottom: 14 }}>
          <div className="subtle" style={{ marginBottom: 4 }}>Reason</div>
          {/* pre-wrap: the model writes paragraphs, and collapsing them into
              one block loses the structure of its argument. */}
          <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
            {screening.reasonSummary || "No reason recorded."}
          </p>
        </section>

        <div
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}
        >
          <section>
            <div className="subtle" style={{ marginBottom: 4 }}>Matched requirements</div>
            {matched.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {matched.map((m, i) => <li key={i}>{m}</li>)}
              </ul>
            ) : (
              <p className="subtle" style={{ margin: 0 }}>None recorded.</p>
            )}
          </section>

          <section>
            <div className="subtle" style={{ marginBottom: 4 }}>Gaps</div>
            {gaps.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            ) : (
              <p className="subtle" style={{ margin: 0 }}>None recorded.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
