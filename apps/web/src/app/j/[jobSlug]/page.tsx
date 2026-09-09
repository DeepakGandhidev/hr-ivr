import { adminPrisma } from "@pratibha/prisma";

interface PageProps {
  params: { jobSlug: string };
}

export default async function CareersJobPage({ params }: PageProps) {
  const { jobSlug } = params;

  // The hosted careers page (§5 Stage 3) is public: there is no session and so
  // no tenant context, which means RLS would hide the row. This read uses the
  // unfiltered client on purpose, and is narrowed to exactly what a job post is
  // meant to expose — an OPEN job and its APPROVED description. It must never
  // be widened to unapproved drafts, closed roles, or candidate data.
  const job = await adminPrisma.job.findFirst({
    // deletedAt is belt-and-braces: archiving also closes the role, so the
    // status filter already hides it. Both, because this page is public and a
    // future change to either rule must not quietly republish an archived job.
    where: { slug: jobSlug, status: "open", deletedAt: null },
    include: {
      tenant: { select: { name: true } },
      descriptions: {
        where: { approvedAt: { not: null } },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });

  if (!job) {
    return (
      <main style={{ maxWidth: 720, margin: "48px auto", padding: 24 }}>
        <p>Job not found.</p>
      </main>
    );
  }

  const jd = job.descriptions[0];

  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: 24 }}>
      <h1>{job.title}</h1>
      <p style={{ color: "var(--text-muted)" }}>{job.tenant.name}</p>
      <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "24px 0" }} />
      {jd ? (
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", lineHeight: 1.6 }}>{jd.bodyMd}</pre>
      ) : (
        <p>No job description available.</p>
      )}
      <div style={{ marginTop: 32, padding: 16, background: "var(--surface-2)", borderRadius: 4, textAlign: "center" }}>
        <p style={{ margin: 0 }}>Interested? Shortlisted candidates will be invited to a short telephonic interview with Pratibha, our AI recruiter.</p>
        {process.env.PRATIBHA_NUMBER ? (
          <a href={`tel:${process.env.PRATIBHA_NUMBER}`} style={{ fontSize: 24, fontWeight: "bold", color: "var(--accent)", textDecoration: "none", display: "block", marginTop: 12 }}>
            {process.env.PRATIBHA_NUMBER}
          </a>
        ) : (
          <p style={{ fontSize: 24, fontWeight: "bold", color: "var(--accent)", margin: 0 }}>—</p>
        )}
      </div>
    </main>
  );
}
