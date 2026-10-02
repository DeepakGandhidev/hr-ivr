import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { getSettings, GATE_OPTIONS } from "@/lib/settings";
import { SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { admin } = await requireAdminPage();
  const s = await getSettings();
  return (
    <SettingsForm
      canEdit={can(admin.role, "settings.edit")}
      refusal={refusalReason(admin.role, "settings.edit")}
      gates={GATE_OPTIONS.map((g) => ({ value: g.value, label: g.label }))}
      initial={{
        "screening.suggest_threshold": String(s["screening.suggest_threshold"]),
        "pipeline.junk_hint": Boolean(s["pipeline.junk_hint"]),
        "report.score_gap_threshold": String(s["report.score_gap_threshold"]),
        "interview.screener_seconds": String(s["interview.screener_seconds"]),
        "lists.page_size": String(s["lists.page_size"]),
        "company.description_cap": String(s["company.description_cap"]),
        "gate.portal_posts": String(s["gate.portal_posts"]),
        "gate.interview_tuning": String(s["gate.interview_tuning"]),
      }}
    />
  );
}
