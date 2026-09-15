"use client";

export interface TranscriptTurn {
  speaker: "pratibha" | "candidate";
  text: string;
  atMs: number;
}

/** mm:ss from the start of the call. */
export function atLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * The conversation, turn by turn.
 *
 * One component for both places it appears — the Calls section and section 2 of
 * the interview report — because they are the same thing read for two different
 * reasons, and two implementations would drift the moment either was touched.
 *
 * Speakers are distinguished by label and alignment rather than by colour
 * alone: who said what is the primary information here, and colour is the one
 * channel a reader may not have.
 */
export default function Transcript({
  turns,
  emptyMessage = "No transcript was recorded for this call.",
}: {
  turns: TranscriptTurn[];
  emptyMessage?: string;
}) {
  if (!turns.length) {
    return <p className="subtle" style={{ margin: 0 }}>{emptyMessage}</p>;
  }

  return (
    <ol className="transcript">
      {turns.map((turn, i) => (
        <li key={i} className={`transcript-turn transcript-${turn.speaker}`}>
          <div className="transcript-meta">
            <span className="transcript-speaker">
              {turn.speaker === "pratibha" ? "Pratibha" : "Candidate"}
            </span>
            <span className="transcript-at">{atLabel(turn.atMs)}</span>
          </div>
          <p className="transcript-text">{turn.text}</p>
        </li>
      ))}
    </ol>
  );
}
