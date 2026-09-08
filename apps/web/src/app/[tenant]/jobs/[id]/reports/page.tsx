import { apiGet } from "@/lib/server-fetch";

interface AssessmentReport {
  id: string;
  overallScore: number;
  recommendation: string;
  strengths: string[];
  concerns: string[];
  generatedAt: string;
  // The API nests the candidate under the call that produced the report.
  interviewCall?: {
    language?: string | null;
    status?: string | null;
    candidate?: {
      name?: string | null;
      email?: string | null;
      phoneE164?: string | null;
    } | null;
  } | null;
}

async function loadReports(tenant: string, id: string): Promise<AssessmentReport[]> {
  const data = await apiGet<{ reports?: AssessmentReport[] }>(`/api/${tenant}/jobs/${id}/reports`, {});
  return data.reports ?? [];
}

export default async function ReportsPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const reports = await loadReports(tenant, id);

  return (
    <div>
      <div className="page-head"><h1>Assessment reports</h1></div>
      {reports.length === 0 ? (
        <p>No reports yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {reports.map((report) => (
            <li key={report.id} className="card" style={{ marginBottom: 12 }}>
              <strong>{report.interviewCall?.candidate?.name || report.interviewCall?.candidate?.email || report.interviewCall?.candidate?.phoneE164 || "Unknown candidate"}</strong>
              <p>Score: {report.overallScore} — Recommendation: <span style={{ textTransform: "uppercase" }}>{report.recommendation.replace(/_/g, " ")}</span></p>
              {report.strengths.length > 0 && (
                <p>Strengths: {report.strengths.join(", ")}</p>
              )}
              {report.concerns.length > 0 && (
                <p>Concerns: {report.concerns.join(", ")}</p>
              )}
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Generated {new Date(report.generatedAt).toLocaleString()}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
