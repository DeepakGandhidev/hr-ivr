import Link from "next/link";
import { adminPrisma } from "@pratibha/prisma";
import "@/app/jobs-module.css";

interface PageProps {
  params: { tenantSlug: string };
}

/** The statuses in which a workspace takes no applications. */
const PAUSED = ["suspended", "deleted_pending", "deleted"];

/**
 * A workspace's hosted careers page: its logo (or its name, as text, when it
 * has none), its description, and every open role it has published, each
 * linking to that role's own page.
 *
 * Public, so no session and no tenant context: like the job page, this read
 * uses the unfiltered client and is narrowed to exactly what a careers page
 * shows. Open, published, not archived; never drafts or candidate data.
 */
export default async function CareersPage({ params }: PageProps) {
  const tenant = await adminPrisma.tenant.findUnique({
    where: { slug: params.tenantSlug },
    select: {
      name: true,
      slug: true,
      status: true,
      companyProfile: { select: { description: true, logoAssetId: true } },
      jobs: {
        where: {
          status: "open",
          deletedAt: null,
          posts: { some: { channel: "careers_page", status: "posted" } },
        },
        orderBy: { createdAt: "desc" },
        select: { slug: true, title: true, location: true, experienceRange: true },
      },
    },
  });

  if (!tenant || tenant.status === "deleted") {
    return (
      <main style={{ maxWidth: 720, margin: "48px auto", padding: 24 }}>
        <p>Careers page not found.</p>
      </main>
    );
  }

  const paused = PAUSED.includes(tenant.status);
  const jobs = paused ? [] : tenant.jobs;

  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: 24 }}>
      <header style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16 }}>
        {tenant.companyProfile?.logoAssetId ? (
          // The public logo route exposes only the pinned logo.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/public/${tenant.slug}/logo`}
            alt={tenant.name}
            style={{ maxWidth: 120, maxHeight: 72, objectFit: "contain", background: "#FFFFFF", borderRadius: 8 }}
          />
        ) : null}
        <div>
          <h1 style={{ margin: 0 }}>{tenant.name}</h1>
          <p style={{ color: "var(--text-muted)", margin: "4px 0 0" }}>Careers</p>
        </div>
      </header>

      {tenant.companyProfile?.description && (
        <p style={{ color: "var(--text-muted)", lineHeight: 1.6 }}>{tenant.companyProfile.description}</p>
      )}

      <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: "24px 0" }} />

      <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>Open roles</h2>
      {jobs.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>
          {paused ? "Applications are paused at the moment." : "No open roles right now. Check back soon."}
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {jobs.map((j) => (
            <li key={j.slug}>
              <Link
                href={`/j/${j.slug}`}
                style={{ display: "block", padding: "14px 16px", border: "1px solid var(--border)", borderRadius: 10, textDecoration: "none", color: "inherit" }}
              >
                <strong>{j.title}</strong>
                {(j.location || j.experienceRange) && (
                  <span style={{ display: "block", color: "var(--text-muted)", fontSize: 13, marginTop: 2 }}>
                    {[j.location, j.experienceRange].filter(Boolean).join(" · ")}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
