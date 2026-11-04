import { SETTINGS, SETTING_GROUPS } from "@pratibha/shared/settings-registry";
import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { getSettings, runtimeSnapshots, savedSettingKeys } from "@/lib/settings";
import { SettingsEditor, type SettingItem } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { admin } = await requireAdminPage();
  const [values, saved, runtime] = await Promise.all([getSettings(), savedSettingKeys(), runtimeSnapshots()]);

  const items: SettingItem[] = SETTINGS.map((def) => {
    const running = {
      web: runtime.web?.values[def.key] ?? null,
      worker: runtime.worker?.values[def.key] ?? null,
    };
    // Nothing saved here: show what the app that uses it is actually running
    // with (its own .env), not this server's idea of the default.
    const reported = def.apps.includes("worker") && running.worker ? running.worker : def.apps.includes("web") && running.web ? running.web : null;
    const isSaved = saved.has(def.key);
    return {
      def,
      value: isSaved || !reported ? (values[def.key] ?? null) : reported.value,
      saved: isSaved,
      running,
    };
  });

  return (
    <SettingsEditor
      items={items}
      groups={SETTING_GROUPS}
      canEdit={can(admin.role, "settings.edit")}
      canOwner={can(admin.role, "settings.owner")}
      refusal={refusalReason(admin.role, "settings.edit")}
      ownerRefusal={refusalReason(admin.role, "settings.owner")}
      reportedAt={{ web: runtime.web?.at ?? null, worker: runtime.worker?.at ?? null }}
      adminEmail={admin.email}
    />
  );
}
