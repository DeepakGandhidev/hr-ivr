import { db, type Db } from "@/lib/db";

/**
 * Platform settings: every tunable the product runs on, in the database.
 *
 * The defaults here are only the fallback for a missing row (the migration
 * seeds every key). They match what the portal did before these keys existed,
 * so a missing row can never change behaviour.
 */
export const SETTING_DEFAULTS = {
  "screening.suggest_threshold": 70,
  "pipeline.junk_hint": true,
  "report.score_gap_threshold": 2.0,
  "interview.screener_seconds": 30,
  "lists.page_size": 25,
  "company.description_cap": 5000,
  "gate.portal_posts": "all",
  "gate.interview_tuning": "all",
  "admin.goodwill_cap_minutes": 100,
  "admin.session_idle_minutes": 60,
  "admin.session_max_hours": 12,
  "admin.code_recency_minutes": 15,
  "admin.delete_hold_days": 30,
  "refund.window_days": 7,
  "refund.first_payment_max_usage_percent": 20,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFAULTS)[K] extends number
  ? number
  : (typeof SETTING_DEFAULTS)[K] extends boolean
    ? boolean
    : string;

/** Which plans a gated feature is open to. */
export const GATE_OPTIONS = [
  { value: "all", label: "Every plan" },
  { value: "growth", label: "Growth and above" },
  { value: "scale", label: "Scale only" },
] as const;

export async function getSetting<K extends SettingKey>(key: K, client: Db = db): Promise<SettingValue<K>> {
  const row = await client.platformSetting.findUnique({ where: { key } });
  return (row?.value ?? SETTING_DEFAULTS[key]) as SettingValue<K>;
}

export async function getSettings(client: Db = db): Promise<{ [K in SettingKey]: SettingValue<K> }> {
  const rows = await client.platformSetting.findMany();
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    if (row.key in SETTING_DEFAULTS) out[row.key] = row.value;
  }
  return out as { [K in SettingKey]: SettingValue<K> };
}
