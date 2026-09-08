import Link from "next/link";
import { apiGet } from "@/lib/server-fetch";

interface Job {
  id: string;
  title: string;
  status: string;
  location?: string | null;
  createdAt: string;
}

async function loadJobs(tenant: string): Promise<Job[]> {
  const data = await apiGet<{ jobs?: Job[] }>(`/api/${tenant}/jobs`, {});
  return data.jobs ?? [];
}

/** Only an open job receives applications, so the state is worth showing plainly. */
function statusClass(status: string) {
  if (status === "open") return "badge-success";
  if (status === "draft") return "badge-warning";
  if (status === "closed") return "badge-neutral";
  return "badge-neutral";
}

export default async function JobsPage({ params }: { params: { tenant: string } }) {
  const { tenant } = params;
  const jobs = await loadJobs(tenant);

  return (
    <div style={{ maxWidth: 900 }}>
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div>
          <h1>Jobs</h1>
          <p className="muted">Roles you are hiring for. Applications are filed against these.</p>
        </div>
        <Link href={`/${tenant}/jobs/new`} className="btn btn-primary">
          New job
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="card empty">
          <h3>No jobs yet</h3>
          <p>
            Create a job first — applications need a role to be filed against
            before a mailbox can import them.
          </p>
          <Link href={`/${tenant}/jobs/new`} className="btn btn-primary" style={{ marginTop: 16 }}>
            Create your first job
          </Link>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))" }}>
          {jobs.map((job) => (
            <Link
              key={job.id}
              href={`/${tenant}/jobs/${job.id}`}
              className="card"
              style={{ color: "inherit", display: "block" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 10 }}>
                <strong style={{ fontSize: 15 }}>{job.title}</strong>
                <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
              </div>
              <div className="subtle" style={{ marginTop: 6 }}>
                {job.location || "Location not set"}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
