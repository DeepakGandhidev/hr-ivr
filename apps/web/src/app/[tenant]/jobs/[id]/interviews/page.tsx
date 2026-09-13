import Link from "next/link";
import { apiGet } from "@/lib/server-fetch";
import InterviewReport, { type InterviewReportData } from "@/components/InterviewReport";

async function loadInterviews(tenant: string, id: string): Promise<InterviewReportData[]> {
  const data = await apiGet<{ reports?: InterviewReportData[] }>(
    `/api/${tenant}/jobs/${id}/interviews`,
    {}
  );
  return data.reports ?? [];
}

export default async function InterviewsPage({
  params,
}: {
  params: { tenant: string; id: string };
}) {
  const { tenant, id } = params;
  const reports = await loadInterviews(tenant, id);

  return (
    <div>
      <div className="page-head">
        <Link href={`/${tenant}/jobs/${id}`} className="subtle">&larr; Job</Link>
        <h1 style={{ marginTop: 6 }}>Interviews</h1>
        <p className="subtle" style={{ margin: 0 }}>
          {reports.length === 0
            ? "No interviews have been completed for this role yet."
            : `${reports.length} completed ${reports.length === 1 ? "interview" : "interviews"}.`}
        </p>
      </div>

      {reports.length === 0 ? (
        <div className="card empty">
          <p className="muted">
            A report appears here once a candidate has been interviewed and the
            assessment has been written.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {reports.map((report) => (
            <InterviewReport key={report.id} report={report} />
          ))}
        </div>
      )}
    </div>
  );
}
