import { EMAIL_KINDS, EMAIL_KIND_GROUPS, emailKindSettingKey } from "@pratibha/shared/email-kinds";
import { platformSmtp } from "@pratibha/shared/platform-mail";
import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { EmailBoard } from "./EmailBoard";

export const dynamic = "force-dynamic";

/** Connect Pratibha's mailbox, see every email it sends, switch any off, and read the send log. */
export default async function EmailPage() {
  const { admin } = await requireAdminPage();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [settings, recent, week] = await Promise.all([
    getSettings(),
    db.emailLog.findMany({ orderBy: { createdAt: "desc" }, take: 60 }).catch(() => []),
    db.emailLog.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: true }).catch(() => []),
  ]);
  const smtp = platformSmtp();

  return (
    <EmailBoard
      mailbox={smtp ? { address: smtp.user, host: smtp.host, port: smtp.port } : null}
      canConnect={can(admin.role, "settings.owner")}
      canEdit={can(admin.role, "settings.edit")}
      ownerRefusal={refusalReason(admin.role, "settings.owner")}
      adminEmail={admin.email}
      groups={EMAIL_KIND_GROUPS}
      kinds={EMAIL_KINDS.map((k) => ({ ...k, on: k.required ? true : settings[emailKindSettingKey(k.key)] !== false }))}
      week={Object.fromEntries(week.map((w) => [w.status, w._count]))}
      recent={recent.map((r) => ({
        id: r.id,
        kind: r.kind,
        to: r.to,
        subject: r.subject,
        status: r.status,
        error: r.error,
        at: r.createdAt.toISOString(),
      }))}
    />
  );
}
