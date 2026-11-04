import { redirect } from "next/navigation";
import { adminPrisma } from "@pratibha/prisma";
import { createClient } from "@/lib/supabase/server";
import { PAUSED_STATUSES, workspacePausedNotice } from "@/lib/authz";
import { TenantNav } from "@/components/TenantNav";
import { ActivateWorkspace } from "@/components/ActivateWorkspace";
import { gstRatePercent } from "@pratibha/shared";
import { copyFor, PORTAL_COPY_PREFIXES } from "@/lib/copy";
import { CopyProvider } from "@/lib/copy-client";
import SaarthiChat from "@/components/SaarthiChat";
import { saarthiConfig } from "@/lib/saarthi";
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
    select: { role: true, tenant: { select: { slug: true, status: true, name: true } } },
  });
  if (member?.tenant.slug === tenant && (PAUSED_STATUSES as readonly string[]).includes(member.tenant.status)) {
    return (
      <main style={{ maxWidth: 520, margin: "96px auto", padding: 24, textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}>{member.tenant.name}</h1>
        <p className="notice" style={{ fontSize: 16 }}>{workspacePausedNotice()}</p>
      </main>
    );
  }

  // Saarthi inside the portal: signed in (it knows the member) when the SDK
  // secret is set, otherwise an ordinary anonymous chat.
  const saarthi = saarthiConfig();
  const saarthiChat =
    saarthi.portalOn && member?.tenant.slug === tenant ? (
      <SaarthiChat
        siteKey={saarthi.siteKey}
        widgetUrl={saarthi.widgetUrl}
        tokenUrl={saarthi.canSign ? `/api/${tenant}/saarthi-token` : undefined}
      />
    ) : null;

  // Signed up but not yet paid: the activation screen, and nothing else.
  if (member?.tenant.slug === tenant && member.tenant.status === "pending_payment") {
    return (
      <CopyProvider copy={copyFor(PORTAL_COPY_PREFIXES)}>
        <ActivateWorkspace tenant={tenant} name={member.tenant.name} isOwner={member.role === "owner"} gstRatePercent={gstRatePercent()} />
        {saarthiChat}
      </CopyProvider>
    );
  }

  return (
    // The admin panel's wording for every client screen in the portal.
    <CopyProvider copy={copyFor(PORTAL_COPY_PREFIXES)}>
      <div className="shell">
        <TenantNav tenant={tenant} />
        <main className="content">{children}</main>
      </div>
      {saarthiChat}
    </CopyProvider>
  );
}
