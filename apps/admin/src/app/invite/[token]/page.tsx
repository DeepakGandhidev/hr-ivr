import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { hashToken, panelEnabled } from "@/lib/auth/session";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { Brand } from "@/components/Brand";
import { AcceptInviteForm } from "./AcceptInviteForm";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: { token: string } }) {
  if (!panelEnabled()) notFound();
  const admin = await db.adminUser.findUnique({ where: { inviteTokenHash: hashToken(params.token) } });
  const valid = admin && !admin.deactivatedAt && admin.inviteExpiresAt && admin.inviteExpiresAt > new Date();

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand />
        {valid ? (
          <>
            <div>
              <h1 className="page-title">Welcome, {admin!.name}</h1>
              <p className="page-sub">
                You have been invited as {ROLE_LABEL[admin!.role]} ({admin!.email}). Choose a password of at least
                twelve characters. Next you will set up two step verification.
              </p>
            </div>
            <AcceptInviteForm token={params.token} email={admin!.email} />
          </>
        ) : (
          <div>
            <h1 className="page-title">This invite has expired</h1>
            <p className="page-sub">Invites last 72 hours and work once. Ask an Owner to send a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}
