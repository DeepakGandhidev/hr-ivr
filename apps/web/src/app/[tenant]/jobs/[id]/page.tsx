import Link from "next/link";
import { apiGet } from "@/lib/server-fetch";

interface JobDescription {
  id: string;
  version: number;
  bodyMd: string;
  generatedBy: string;
  approvedAt?: string | null;
  createdAt: string;
}

interface Job {
  id: string;
  title: string;
  status: string;
  location?: string | null;
  salaryBand?: string | null;
  experienceRange?: string | null;
  mustHaves: string[];
  goodToHaves: string[];
}

interface JobWithDescriptions extends Job {
  descriptions: JobDescription[];
}

async function loadJob(tenant: string, id: string): Promise<JobWithDescriptions | null> {
  const data = await apiGet<{ job?: JobWithDescriptions }>(`/api/${tenant}/jobs/${id}`, {});
  return data.job ?? null;
}

export default async function JobDetailPage({ params }: { params: { tenant: string; id: string } }) {
  const { tenant, id } = params;
  const job = await loadJob(tenant, id);

  if (!job) {
    return (
      <div className="card empty">
        <h3>Job not found</h3>
        <p>It may have been deleted, or belong to another workspace.</p>
        <Link href={`/${tenant}/jobs`} className="btn" style={{ marginTop: 16 }}>Back to jobs</Link>
      </div>
    );
  }

  const latestJd = job.descriptions[0] ?? null;
  const statusClass =
    job.status === "open" ? "badge-success" : job.status === "draft" ? "badge-warning" : "badge-neutral";

  const facts = [
    ["Location", job.location],
    ["Salary band", job.salaryBand],
    ["Experience", job.experienceRange],
  ].filter(([, value]) => Boolean(value)) as Array<[string, string]>;

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <Link href={`/${tenant}/jobs`} className="subtle">&larr; Jobs</Link>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
          <h1 style={{ margin: 0 }}>{job.title}</h1>
          <span className={`badge ${statusClass}`}>{job.status}</span>
        </div>
      </div>

      {/* The actions are the point of this page, so they sit above the detail
          rather than below a JD that can run for several screens. */}
      <div className="row" style={{ marginBottom: 20 }}>
        <Link href={`/${tenant}/jobs/${id}/jd`} className="btn btn-primary">JD Studio</Link>
        <Link href={`/${tenant}/jobs/${id}/candidates`} className="btn">Candidates</Link>
        <Link href={`/${tenant}/jobs/${id}/shortlist`} className="btn">Shortlist</Link>
        <Link href={`/${tenant}/jobs/${id}/publish`} className="btn">Publish</Link>
        <Link href={`/${tenant}/jobs/${id}/reports`} className="btn">Reports</Link>
      </div>

      {facts.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
            {facts.map(([label, value]) => (
              <div key={label}>
                <div className="subtle">{label}</div>
                <div style={{ fontWeight: 550 }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(job.mustHaves?.length > 0 || job.goodToHaves?.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Requirements</h3>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Must have</div>
              <div className="row" style={{ gap: 6 }}>
                {(job.mustHaves ?? []).map((m) => <span key={m} className="badge badge-accent">{m}</span>)}
              </div>
            </div>
            <div>
              <div className="subtle" style={{ marginBottom: 6 }}>Good to have</div>
              <div className="row" style={{ gap: 6 }}>
                {(job.goodToHaves ?? []).map((g) => <span key={g} className="badge badge-neutral">{g}</span>)}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Latest job description</h3>
        {latestJd ? (
          <>
            <div className="subtle" style={{ marginBottom: 10 }}>
              Version {latestJd.version} · {latestJd.generatedBy}
              {latestJd.approvedAt ? " · approved" : " · not yet approved"}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{latestJd.bodyMd}</div>
          </>
        ) : (
          <p className="muted">
            No description yet. <Link href={`/${tenant}/jobs/${id}/jd`}>Write or generate one</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
