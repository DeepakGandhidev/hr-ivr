/**
 * Batch 6, I20: what the screeners collected on the call, as fields. Rendered
 * in the interview report and on the candidate profile from the same record,
 * so the two can never disagree.
 */

interface Money {
  said?: string;
  annual?: number | null;
}

export interface PracticalDetailsData {
  noticePeriod?: string;
  currentCtc?: Money;
  expectedCtc?: Money;
  reasonForLeaving?: string;
  gapExplanation?: string;
  location?: string;
  workMode?: string;
  travel?: string;
  referenceName?: string;
  referencePhone?: string;
  referenceRelation?: string;
  bandAnswer?: string;
  salaryMismatch?: { expectedAnnual?: number | null; bandMax?: number | null; action?: string };
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

function money(m: Money | undefined) {
  if (!m) return null;
  if (m.annual) return `${rupees(m.annual)} a year${m.said ? ` (said “${m.said}”)` : ""}`;
  return m.said ?? null;
}

export function hasPracticalDetails(d: unknown): d is PracticalDetailsData {
  return Boolean(d && typeof d === "object" && Object.keys(d as object).length);
}

export default function PracticalDetails({ details, heading = "Practical details" }: { details: PracticalDetailsData; heading?: string }) {
  const reference = [details.referenceName, details.referenceRelation, details.referencePhone].filter(Boolean).join(", ");
  const rows: [string, string | null | undefined][] = [
    ["Notice period", details.noticePeriod],
    ["Current CTC", money(details.currentCtc)],
    ["Expected CTC", money(details.expectedCtc)],
    ["Within the band?", details.bandAnswer],
    ["Reason for leaving", details.reasonForLeaving],
    ["On the gaps", details.gapExplanation],
    ["Location", details.location],
    ["Work mode", details.workMode],
    ["Travel", details.travel],
    ["Reference", reference || null],
  ];
  const shown = rows.filter(([, v]) => v);
  if (!shown.length && !details.salaryMismatch) return null;

  return (
    <section className="practical">
      <h3 className="report-sub">{heading}</h3>
      {details.salaryMismatch && (
        <p className="practical-flag">
          <span className="chip chip-amber sm">Salary mismatch</span>{" "}
          {details.salaryMismatch.expectedAnnual && details.salaryMismatch.bandMax
            ? `Expects ${rupees(details.salaryMismatch.expectedAnnual)} a year; the band tops out at ${rupees(details.salaryMismatch.bandMax)}.`
            : "Expectation above the band."}
        </p>
      )}
      <dl className="practical-list">
        {shown.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
