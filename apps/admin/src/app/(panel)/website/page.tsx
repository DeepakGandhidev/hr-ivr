import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { websiteOverview } from "@/lib/website/store";
import { PAGE_LABELS } from "@/lib/website/schema";
import { listUploads } from "@/lib/website/uploads";
import { CompanySection, FaqSection, ImagesSection, PagesSection, PostsSection, PublishBar, TestimonialsSection } from "./WebsiteBoard";

export const dynamic = "force-dynamic";

const SITE_URL = process.env.SITE_PUBLIC_URL ?? "https://pratibha.tech";

const TABS = [
  { id: "seo", label: "Pages and SEO" },
  { id: "blog", label: "Blog" },
  { id: "testimonials", label: "Testimonials" },
  { id: "faq", label: "FAQ" },
  { id: "company", label: "Company and legal" },
  { id: "images", label: "Images" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default async function WebsitePage({ searchParams }: { searchParams: { tab?: string } }) {
  const { admin } = await requireAdminPage();
  const data = await websiteOverview();
  const tab: TabId = (TABS.find((t) => t.id === searchParams.tab)?.id ?? "seo") as TabId;
  const canEdit = can(admin.role, "website.edit");

  const pendingIn = (kinds: string[]) =>
    [...data.pages, ...(data.company ? [data.company] : []), ...data.testimonials, ...data.faq, ...data.posts].filter(
      (e) => kinds.includes(e.kind) && e.changed
    ).length;
  const tabKinds: Record<TabId, string[]> = { seo: ["page"], blog: ["post"], testimonials: ["testimonial"], faq: ["faq"], company: ["company"], images: [] };

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Website</h1>
          <p className="page-sub">
            What pratibha.tech says: page titles and descriptions for search, blog posts, testimonials, FAQs and the company details on the legal pages.
            Saving keeps a draft; Publish rebuilds the site with every draft at once.
          </p>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <PublishBar
          pending={data.pending}
          publishes={data.publishes}
          canPublish={can(admin.role, "website.publish")}
          refusal={refusalReason(admin.role, "website.publish")}
          configured={data.publishConfigured}
          siteUrl={SITE_URL}
        />

        {!canEdit && <div className="notice">{refusalReason(admin.role, "website.edit")}</div>}

        <div className="tabs">
          {TABS.map((t) => {
            const n = pendingIn(tabKinds[t.id]);
            return (
              <Link key={t.id} href={`/website?tab=${t.id}`} className={tab === t.id ? "on" : undefined}>
                {t.label}
                {n ? ` (${n})` : ""}
              </Link>
            );
          })}
        </div>

        {tab === "seo" && <PagesSection pages={data.pages} labels={PAGE_LABELS} canEdit={canEdit} />}
        {tab === "blog" && <PostsSection posts={data.posts} canEdit={canEdit} siteUrl={SITE_URL} />}
        {tab === "testimonials" && <TestimonialsSection items={data.testimonials} canEdit={canEdit} />}
        {tab === "faq" && <FaqSection items={data.faq} canEdit={canEdit} />}
        {tab === "company" && <CompanySection company={data.company} canEdit={canEdit} />}
        {tab === "images" && <ImagesSection images={listUploads()} canEdit={canEdit} />}
      </div>
    </>
  );
}
