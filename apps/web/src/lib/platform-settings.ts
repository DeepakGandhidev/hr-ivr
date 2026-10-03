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
  legalNameMax: number;
  addressLineMax: number;
  cityMax: number;
  logoMaxBytes: number;
  portalPostsGate: string;
  interviewTuningGate: string;
  /** Signals that together suggest "Not an application" on the Pipeline. */
  junkRule: string[];
  /** Candidates the screening runner takes per run. */
  autoScreenBatch: number;
  /** Batch 6, I31: the interview plan estimate. */
  roleIntroSeconds: number;
  customQuestionSeconds: number;
  candidateQuestionsSeconds: number;
  coreQuestionSeconds: number;
  wrapUpSlackMinutes: number;
}

const DEFAULTS: PlatformSettings = {
  suggestThreshold: DEFAULT_SCREENING_THRESHOLD,
  junkHint: true,
  scoreGapThreshold: 2.0,
  screenerSeconds: 30,
  pageSize: 25,
  descriptionCap: 600,
  legalNameMax: 200,
  addressLineMax: 300,
  cityMax: 100,
  logoMaxBytes: 2 * 1024 * 1024,
  portalPostsGate: "all",
  interviewTuningGate: "all",
  junkRule: ["no_phone", "no_job", "subject_name"],
  autoScreenBatch: 10,
  roleIntroSeconds: 30,
  customQuestionSeconds: 60,
  candidateQuestionsSeconds: 60,
  coreQuestionSeconds: 60,
  wrapUpSlackMinutes: 1,
};

const KEYS: Record<string, keyof PlatformSettings> = {
  "screening.suggest_threshold": "suggestThreshold",
  "pipeline.junk_hint": "junkHint",
  "report.score_gap_threshold": "scoreGapThreshold",
  "interview.screener_seconds": "screenerSeconds",
  "lists.page_size": "pageSize",
  "company.description_cap": "descriptionCap",
  "company.legal_name_max": "legalNameMax",
  "company.address_line_max": "addressLineMax",
  "company.city_max": "cityMax",
  "company.logo_max_bytes": "logoMaxBytes",
  "gate.portal_posts": "portalPostsGate",
  "gate.interview_tuning": "interviewTuningGate",
  "pipeline.junk_rule": "junkRule",
  "pipeline.auto_screen_batch": "autoScreenBatch",
  "interview.role_intro_seconds": "roleIntroSeconds",
  "interview.custom_question_seconds": "customQuestionSeconds",
  "interview.candidate_questions_seconds": "candidateQuestionsSeconds",
  "interview.core_question_seconds": "coreQuestionSeconds",
  "interview.wrap_up_slack_minutes": "wrapUpSlackMinutes",
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

/** I31: the plan card's constants, from DB config. */
export function planConstants(s: PlatformSettings) {
  return {
    roleIntroSeconds: s.roleIntroSeconds,
    screenerSeconds: s.screenerSeconds,
    customQuestionSeconds: s.customQuestionSeconds,
    candidateQuestionsSeconds: s.candidateQuestionsSeconds,
    coreQuestionSeconds: s.coreQuestionSeconds,
    wrapUpSlackMinutes: s.wrapUpSlackMinutes,
  };
}
