import Link from "next/link";
import { apiGet } from "@/lib/server-fetch";
import JobActions from "@/components/JobActions";

interface Job {
  id: string;
  title: string;
  status: string;
  location?: string | null;
  createdAt: string;
  _count?: { candidates: number };
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
  const [jobs, me] = await Promise.all([
    loadJobs(tenant),
    apiGet<{ user?: { role?: string } }>("/api/auth/me", {}),
  ]);
  const canDelete = ["admin", "owner"].includes(me.user?.role ?? "");

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
            /* A div, not a Link: the Edit and Archive controls are interactive
               and nesting them inside an anchor is invalid HTML — the browser
               closes the anchor early and the layout breaks. The title carries
               the navigation instead. */
            <div key={job.id} className="card" style={{ display: "block" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 10 }}>
                <Link
                  href={`/${tenant}/jobs/${job.id}`}
                  style={{ color: "inherit", fontSize: 15, fontWeight: 600 }}
                >
                  {job.title}
                </Link>
                <span className={`badge ${statusClass(job.status)}`}>{job.status}</span>
              </div>
              <div className="subtle" style={{ marginTop: 6 }}>
                {job.location || "Location not set"}
              </div>
              <div style={{ marginTop: 12 }}>
                <JobActions
                  tenant={tenant}
                  jobId={job.id}
                  title={job.title}
                  candidateCount={job._count?.candidates ?? 0}
                  canDelete={canDelete}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
