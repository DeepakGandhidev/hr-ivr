import { WHATSAPP_KIND_GROUPS, whatsappKindSettingKey } from "@pratibha/shared/whatsapp-kinds";
import { whatsappConfig } from "@pratibha/shared/whatsapp";
import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { fetchPhoneNumber, loadTemplateRows } from "@/lib/whatsapp-admin";
import { WhatsAppBoard } from "./WhatsAppBoard";

export const dynamic = "force-dynamic";

/**
 * Connect Pratibha's WhatsApp number, see what Meta has approved, switch any
 * message off, and read the send log. The number's details and the template
 * list are asked of Meta on every visit, so they are never stale.
 */
export default async function WhatsAppPage() {
  const { admin } = await requireAdminPage();
  const since = new Date(Date.now() - 7 * 86_400_000);
  const config = whatsappConfig();
  const [settings, recent, week, number, templates] = await Promise.all([
    getSettings(),
    db.whatsappLog.findMany({ orderBy: { createdAt: "desc" }, take: 60 }).catch(() => []),
    db.whatsappLog.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: true }).catch(() => []),
    config ? fetchPhoneNumber(config.phoneNumberId, config.token, config.apiVersion) : Promise.resolve(null),
    loadTemplateRows(),
  ]);
  const portal = String(settings["brand.app_url"] ?? "").replace(/\/+$/, "");

  return (
    <WhatsAppBoard
      connection={
        config
          ? {
              phoneNumberId: config.phoneNumberId,
              wabaId: config.wabaId,
              hasAppSecret: Boolean(config.appSecret),
              number: number?.ok ? number.data?.display_phone_number ?? null : null,
              verifiedName: number?.ok ? number.data?.verified_name ?? null : null,
              quality: number?.ok ? number.data?.quality_rating ?? null : null,
              error: number && !number.ok ? number.error ?? "Meta did not answer" : null,
            }
          : null
      }
      callbackUrl={`${portal}/webhook/whatsapp`}
      verifyToken={String(settings["whatsapp.verify_token"] ?? "")}
      canConnect={can(admin.role, "settings.owner")}
      canEdit={can(admin.role, "settings.edit")}
      ownerRefusal={refusalReason(admin.role, "settings.owner")}
      groups={WHATSAPP_KIND_GROUPS}
      templates={templates.rows.map((t) => ({ ...t, on: t.required ? true : settings[whatsappKindSettingKey(t.key)] !== false }))}
      templateError={templates.error}
      candidatesNeedOptIn={settings["whatsapp.candidates_need_opt_in"] !== false}
      week={Object.fromEntries(week.map((w) => [w.status, w._count]))}
      recent={recent.map((r) => ({
        id: r.id,
        kind: r.kind,
        to: r.toPhone,
        template: r.template,
        status: r.status,
        error: r.error,
        at: r.createdAt.toISOString(),
      }))}
    />
  );
}
