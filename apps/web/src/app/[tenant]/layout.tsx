import { redirect } from "next/navigation";
import { adminPrisma } from "@pratibha/prisma";
import { createClient } from "@/lib/supabase/server";
import { PAUSED_STATUSES, WORKSPACE_PAUSED_NOTICE } from "@/lib/authz";
import { TenantNav } from "@/components/TenantNav";
import "@/app/jobs-module.css";

interface TenantLayoutProps {
  children: React.ReactNode;
  params: { tenant: string };
}

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenant } = params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // A suspended workspace (or one held for deletion) shows its members the
  // notice instead of the app; every API route refuses them as well.
  const member = await adminPrisma.user.findUnique({
    where: { authProviderId: user.id },
    select: { tenant: { select: { slug: true, status: true, name: true } } },
  });
  if (member?.tenant.slug === tenant && (PAUSED_STATUSES as readonly string[]).includes(member.tenant.status)) {
    return (
      <main style={{ maxWidth: 520, margin: "96px auto", padding: 24, textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}>{member.tenant.name}</h1>
        <p className="notice" style={{ fontSize: 16 }}>{WORKSPACE_PAUSED_NOTICE}</p>
      </main>
    );
  }

  return (
    <div className="shell">
      <TenantNav tenant={tenant} />
      <main className="content">{children}</main>
    </div>
  );
}
