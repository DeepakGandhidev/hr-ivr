import { DEFAULT_SCREENING_THRESHOLD } from "@pratibha/shared";
import { adminPrisma } from "@pratibha/prisma";

/**
 * Platform settings, as the admin panel's Platform settings page writes them.
 *
 * Read on every request that needs one, so a change applies on the next screen
 * load in every workspace without a deploy. The defaults are what the portal
 * did before these keys existed, so a missing row changes nothing.
 */
export interface PlatformSettings {
  suggestThreshold: number;
  junkHint: boolean;
  scoreGapThreshold: number;
  screenerSeconds: number;
  pageSize: number;
  descriptionCap: number;
  portalPostsGate: string;
  interviewTuningGate: string;
}

const DEFAULTS: PlatformSettings = {
  suggestThreshold: DEFAULT_SCREENING_THRESHOLD,
  junkHint: true,
  scoreGapThreshold: 2.0,
  screenerSeconds: 30,
  pageSize: 25,
  descriptionCap: 5000,
  portalPostsGate: "all",
  interviewTuningGate: "all",
};

const KEYS: Record<string, keyof PlatformSettings> = {
  "screening.suggest_threshold": "suggestThreshold",
  "pipeline.junk_hint": "junkHint",
  "report.score_gap_threshold": "scoreGapThreshold",
  "interview.screener_seconds": "screenerSeconds",
  "lists.page_size": "pageSize",
  "company.description_cap": "descriptionCap",
  "gate.portal_posts": "portalPostsGate",
  "gate.interview_tuning": "interviewTuningGate",
};

type Db = Pick<typeof adminPrisma, "platformSetting">;

export async function platformSettings(db: Db = adminPrisma): Promise<PlatformSettings> {
  const rows = await db.platformSetting.findMany({ where: { key: { in: Object.keys(KEYS) } } }).catch(() => []);
  const out: PlatformSettings = { ...DEFAULTS };
  for (const row of rows) {
    const field = KEYS[row.key];
    const value = row.value as unknown;
    if (typeof value === typeof DEFAULTS[field]) (out as unknown as Record<string, unknown>)[field] = value;
  }
  return out;
}

const TIERS = ["starter", "growth", "scale"];

/** Whether a plan clears a gate: "all", "growth" (and above) or "scale". */
export function planClearsGate(planKey: string | null | undefined, gate: string): boolean {
  if (gate === "all") return true;
  const need = TIERS.indexOf(gate);
  const have = TIERS.indexOf(planKey ?? "");
  return need === -1 || (have !== -1 && have >= need);
}
