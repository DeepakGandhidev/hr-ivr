import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage, panelEnabled } from "@/lib/auth/session";
import { ROLE_TITLE } from "@/lib/auth/roles";
import { Sidebar } from "@/components/Sidebar";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  if (!panelEnabled()) notFound();
  const { admin } = await requireAdminPage();

  return (
    <div className="shell">
      <Sidebar name={admin.name} roleTitle={ROLE_TITLE[admin.role]} />
      <main className="main">
        {!admin.totpEnabledAt && (
          <div className="notice">
            Two step verification is off for your account. Sign in as a workspace needs it.{" "}
            <Link href="/account/two-step">Turn it on</Link>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
