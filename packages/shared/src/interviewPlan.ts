/**
 * Interview settings (Batch 6): what Pratibha covers on a call, what it costs
 * in time, and how the prompt for it is put together.
 *
 * Pure functions only. The portal uses them for the live plan and for save
 * validation, the worker for the prompt and the salary check, so the page and
 * the phone call can never disagree about what a setting means.
 */

export const SCREENER_KEYS = [
  'notice',
  'salary',
  'reasonLeaving',
  'gaps',
  'location',
  'workMode',
  'travel',
  'reference',
] as const;
export type ScreenerKey = (typeof SCREENER_KEYS)[number];

/** Screener key → the interview_protocols field that stores it. */
export const SCREENER_FIELDS: Record<ScreenerKey, string> = {
  notice: 'screenNotice',
  salary: 'screenSalary',
  reasonLeaving: 'screenReasonLeaving',
  gaps: 'screenGaps',
  location: 'screenLocation',
  workMode: 'screenWorkMode',
  travel: 'screenTravel',
  reference: 'screenReference',
};

export const MISMATCH_ACTIONS = ['note', 'check', 'end'] as const;
export type MismatchAction = (typeof MISMATCH_ACTIONS)[number];

export const MAX_CUSTOM_QUESTIONS = 3;

// ---------------------------------------------------------------------------
// Guardrail (I14)
// ---------------------------------------------------------------------------

export const GUARDRAIL_ERROR =
  'This question touches personal topics Pratibha does not ask about. Keep questions about the work.';

/**
 * Personal-life topics no setting may introduce: religion, caste, marital
 * status, family plans, pregnancy, health, and the same family of questions
 * the fixed core already forbids (age, gender, orientation). Matched on whole
 * words, so "healthcare sales" and "child safety products" are not caught
 * while "your health" and "do you have children" are.
 */
const PERSONAL_TOPICS: RegExp[] = [
  /\breligio(n|ns|us)\b/i,
  /\b(caste|castes|jati|jaati|gotra)\b/i,
  /\b(hindu|muslim|christian|sikh|jain|buddhist|parsi)s?\b/i,
  /\b(temple|mosque|church|gurudwara|namaz|puja|pray|prayers?)\b/i,
  /\b(married|unmarried|marital|marriage|marry|spouse|husband|wife|divorced?|widowed?|fianc[eé]e?|boyfriend|girlfriend|in-laws)\b/i,
  /\b(kids|children|babies)\b/i,
  /\b(child|baby)\b(?![ -]?(safety|care|products?|labou?r|protection|development|food))/i,
  /\bfamily (plans?|planning)\b/i,
  /\bstart(ing)? a family\b/i,
  /\b(pregnan\w*|maternity|expecting a baby)\b/i,
  /\b(your|their|his|her|any) (health|medical|mental health)\b/i,
  /\b(health|medical) (condition|conditions|issue|issues|problem|problems|history)\b/i,
  /\b(illness|illnesses|disease|diseases|disabilit\w*|disabled|medication|medicines?|surgery|sick)\b/i,
  /\b(how old|your age|date of birth|birth ?year)\b/i,
  /\b(sexual|orientation|gay|lesbian)\b/i,
];

/** True when the text touches a topic Pratibha never asks about. */
export function touchesPersonalTopic(text: string | null | undefined): boolean {
  if (!text) return false;
  return PERSONAL_TOPICS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Money (I02, I12)
// ---------------------------------------------------------------------------

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

/** "twenty five" → "25", "fifty" → "50"; leaves digits alone. */
function wordsToDigits(text: string): string {
  return text.replace(
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b|\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi,
    (m, tens?: string, unit?: string, single?: string) =>
      tens && unit
        ? String(WORD_NUMBERS[tens.toLowerCase()] + WORD_NUMBERS[unit.toLowerCase()])
        : String(WORD_NUMBERS[(single ?? m).toLowerCase()])
  );
}

const UNIT = String.raw`(lpa|lakhs?|lacs?|crores?|cr|thousand|k|l)\b`;

function amount(num: string, unit: string | undefined): number | null {
  const n = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? '').toLowerCase();
  if (!u) return n < 1000 ? n * 100_000 : n; // "8" said as a CTC is 8 lakh
  if (/^(cr|crores?)$/.test(u)) return n * 10_000_000;
  if (/^(l|lpa|lakhs?|lacs?)$/.test(u)) return n * 100_000;
  if (/^(k|thousand)$/.test(u)) return n * 1_000;
  return null;
}

function normaliseMoney(text: string) {
  const t = wordsToDigits(text.toLowerCase())
    .replace(/₹|\brs\.?|\binr\b|rupees?/g, ' ')
    .replace(/(\d)\s*(lpa|lakhs?|lacs?|crores?|cr|k|l)\b/g, '$1 $2');
  const monthly = /(per month|a month|\/ ?month|monthly|\bpm\b|p\.m\.|in hand)/.test(t);
  return { t, mult: monthly ? 12 : 1 };
}

/**
 * An annual CTC from what a candidate said: "50L", "50 lakh", "5000000",
 * "12.5 LPA", "1.2 crore", "45k per month", "twenty five lakhs". Monthly
 * figures are annualised. Null when there is no number to read.
 */
export function parseCtc(text: string | null | undefined): number | null {
  if (!text) return null;
  const { t, mult } = normaliseMoney(text);
  const m = new RegExp(String.raw`(\d[\d,]*(?:\.\d+)?)\s*(?:${UNIT})?`, 'i').exec(t);
  if (!m) return null;
  const value = amount(m[1], m[2]);
  return value === null ? null : Math.round(value * mult);
}

/** A free-text band as numbers: "6-8 LPA", "6 to 8 lakh", "up to 12 L". */
export function parseSalaryBand(text: string | null | undefined): { min: number | null; max: number | null } | null {
  if (!text) return null;
  const { t, mult } = normaliseMoney(text);
  const num = String.raw`(\d[\d,]*(?:\.\d+)?)`;
  const range = new RegExp(String.raw`${num}\s*(?:${UNIT})?\s*(?:-|–|to)\s*${num}\s*(?:${UNIT})?`, 'i').exec(t);
  if (range) {
    const lo = amount(range[1], range[2] ?? range[4]);
    const hi = amount(range[3], range[4] ?? range[2]);
    if (lo !== null && hi !== null && lo <= hi) return { min: Math.round(lo * mult), max: Math.round(hi * mult) };
  }
  const upTo = new RegExp(String.raw`(?:up ?to|upto|max(?:imum)?|till)\s*${num}\s*(?:${UNIT})?`, 'i').exec(t);
  if (upTo) {
    const hi = amount(upTo[1], upTo[2]);
    if (hi !== null) return { min: null, max: Math.round(hi * mult) };
  }
  return null;
}

/** ₹ in words people say on calls: 600000 → "6 lakh", 12000000 → "1.2 crore". */
export function formatRupeesSpoken(n: number): string {
  const trim = (x: number) => String(Number(x.toFixed(2)));
  if (n >= 10_000_000) return `${trim(n / 10_000_000)} crore`;
  if (n >= 100_000) return `${trim(n / 100_000)} lakh`;
  return `${Math.round(n).toLocaleString('en-IN')} rupees`;
}

/** The band as spoken: "6 to 8 lakh", or "up to 12 lakh". */
export function formatBandSpoken(min: number | null | undefined, max: number | null | undefined): string | null {
  if (!max) return null;
  if (!min || min === max) return `up to ${formatRupeesSpoken(max)}`;
  const lo = formatRupeesSpoken(min);
  const hi = formatRupeesSpoken(max);
  // "6 lakh to 8 lakh" reads as "6 to 8 lakh" when the units match.
  const unit = (s: string) => s.split(' ').slice(1).join(' ');
  return unit(lo) === unit(hi) ? `${lo.split(' ')[0]} to ${hi}` : `${lo} to ${hi}`;
}

/** I12: how an expected CTC compares with the band. */
export function salaryVerdict(expectedAnnual: number | null, bandMax: number | null | undefined) {
  if (expectedAnnual === null || !bandMax) return 'unknown' as const;
  return expectedAnnual > bandMax ? ('above' as const) : ('within' as const);
}

// ---------------------------------------------------------------------------
// The plan (I31)
// ---------------------------------------------------------------------------

export interface PlanConstants {
  roleIntroSeconds: number;
  screenerSeconds: number;
  customQuestionSeconds: number;
  candidateQuestionsSeconds: number;
  coreQuestionSeconds: number;
  /** How far past the length an estimate may run before it counts as over: the polite wrap-up room. */
  wrapUpSlackMinutes: number;
}

export const DEFAULT_PLAN_CONSTANTS: PlanConstants = {
  roleIntroSeconds: 30,
  screenerSeconds: 30,
  customQuestionSeconds: 60,
  candidateQuestionsSeconds: 60,
  coreQuestionSeconds: 60,
  wrapUpSlackMinutes: 1,
};

export interface PlanInput {
  durationMinutes: number;
  minQuestions: number;
  maxQuestions: number;
  screeners: Partial<Record<ScreenerKey, boolean>>;
  introduceRole: boolean;
  candidateQuestions: boolean;
  customQuestions: string[];
}

export interface PlanLine {
  key: 'greeting' | 'intro' | 'screeners' | 'questions' | 'candidate';
  label: string;
  minutes: number;
}

export interface Plan {
  lines: PlanLine[];
  total: number;
  /** To the half minute, so every half-minute toggle shows. */
  rounded: number;
  /** As the card says it: "11", "10½". */
  label: string;
  over: boolean;
  screenerCount: number;
}

export const TRIM_WARNING = (t: number | string, len: number) =>
  `Your choices need about ${t} minutes of a ${len} minute interview. Add minutes or trim screeners.`;

/**
 * The live estimate: what the choices need. Greeting and consent are free
 * (the clock starts at the first question); the role introduction, each
 * screener, each custom question and the candidate's questions cost their
 * constant; core questions need at least the minimum number of questions.
 * Time left over goes to further core questions, up to the maximum, during
 * the call. Counting what is needed rather than filling the length is what
 * makes every toggle move the total.
 */
export function estimatePlan(input: PlanInput, c: PlanConstants = DEFAULT_PLAN_CONSTANTS): Plan {
  const min = (s: number) => s / 60;
  const screenerCount = SCREENER_KEYS.filter((k) => input.screeners[k]).length;
  const customCount = input.customQuestions.filter((q) => q.trim()).length;

  const intro = input.introduceRole ? min(c.roleIntroSeconds) : 0;
  const screeners = screenerCount * min(c.screenerSeconds);
  const custom = customCount * min(c.customQuestionSeconds);
  const candidate = input.candidateQuestions ? min(c.candidateQuestionsSeconds) : 0;

  const fixed = intro + screeners + custom + candidate;
  const core = Math.max(0, input.minQuestions) * min(c.coreQuestionSeconds);

  const lines: PlanLine[] = [{ key: 'greeting', label: 'Greeting and consent', minutes: 0 }];
  if (intro) lines.push({ key: 'intro', label: 'Role introduction', minutes: intro });
  if (screenerCount) {
    lines.push({ key: 'screeners', label: `${screenerCount} screener${screenerCount === 1 ? '' : 's'}`, minutes: screeners });
  }
  lines.push({
    key: 'questions',
    label: customCount
      ? `Your question${customCount === 1 ? '' : 's'} + core questions`
      : 'Core questions',
    minutes: custom + core,
  });
  if (candidate) lines.push({ key: 'candidate', label: "Candidate's questions", minutes: candidate });

  const total = fixed + core;
  const rounded = Math.round(total * 2) / 2;
  return {
    lines,
    total,
    rounded,
    label: Number.isInteger(rounded) ? String(rounded) : `${Math.floor(rounded)}½`,
    over: total > input.durationMinutes + c.wrapUpSlackMinutes,
    screenerCount,
  };
}

/** "free", "half a minute", "2 min", "1.5 min". */
export function formatPlanMinutes(m: number): string {
  if (m === 0) return 'free';
  if (m === 0.5) return 'half a minute';
  return `${Number(m.toFixed(1))} min`;
}

// ---------------------------------------------------------------------------
// Prompt assembly (I10, I11, I13)
// ---------------------------------------------------------------------------

/** The block library as stored in prompt_templates (key interviewer_system). */
export interface PromptBlockLibrary {
  format: 'pratibha.blocks/1';
  blocks: Record<string, string>;
}

export function parseBlockLibrary(body: string | null | undefined): PromptBlockLibrary | null {
  if (!body) return null;
  try {
    const doc = JSON.parse(body);
    if (doc?.format === 'pratibha.blocks/1' && doc.blocks && typeof doc.blocks === 'object') return doc;
  } catch {
    // Older plain-text versions are not block libraries.
  }
  return null;
}

export interface InterviewOptions {
  screeners: Partial<Record<ScreenerKey, boolean>>;
  shareBand: boolean;
  mismatchAction: MismatchAction;
  introduceRole: boolean;
  candidateQuestions: boolean;
  hearBackDays: number | null;
  customQuestions: string[];
  instructionText: string;
  difficulty: 'easy' | 'moderate' | 'hard' | 'expert';
  minQuestions: number;
  maxQuestions: number;
  durationMinutes: number;
  focusAreas: string[];
}

export interface PromptContext {
  agentName: string;
  tenantName: string;
  languageHint: string;
  jdSummary: string | null;
  /** Rendered criteria lines; empty means there is nothing to screen for. */
  criteriaList: string;
  /** I11: gaps the CV screening flagged for this candidate. */
  gaps: string[];
  jobLocation: string | null;
  bandMin: number | null;
  bandMax: number | null;
  /** Data sections (who the caller is) placed straight after the fixed core. */
  afterCore?: string[];
}

export function fillBlock(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const v = vars[k];
    return v === null || v === undefined ? '' : String(v);
  });
}

/** Defaults for a protocol row, or for none. Mirrors the migration defaults. */
export function interviewOptionsFrom(p: Record<string, unknown> | null | undefined): InterviewOptions {
  const row = (p ?? {}) as Record<string, any>;
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const minQuestions = Number(row.minQuestions) || 6;
  return {
    screeners: {
      notice: bool(row.screenNotice, true),
      salary: bool(row.screenSalary, true),
      reasonLeaving: bool(row.screenReasonLeaving, true),
      gaps: bool(row.screenGaps, true),
      location: bool(row.screenLocation, false),
      workMode: bool(row.screenWorkMode, false),
      travel: bool(row.screenTravel, false),
      reference: bool(row.screenReference, false),
    },
    shareBand: bool(row.shareBand, true),
    mismatchAction: (MISMATCH_ACTIONS as readonly string[]).includes(row.mismatchAction) ? row.mismatchAction : 'check',
    introduceRole: bool(row.introduceRole, true),
    candidateQuestions: bool(row.candidateQuestions, true),
    hearBackDays: row.hearBackDays === null ? null : Number(row.hearBackDays ?? 3) || null,
    customQuestions: Array.isArray(row.customQuestions)
      ? row.customQuestions.filter((q: unknown): q is string => typeof q === 'string' && q.trim() !== '').slice(0, MAX_CUSTOM_QUESTIONS)
      : [],
    instructionText: typeof row.instructionText === 'string' ? row.instructionText : '',
    difficulty: ['easy', 'moderate', 'hard', 'expert'].includes(row.difficulty) ? row.difficulty : 'moderate',
    minQuestions,
    maxQuestions: Math.max(Number(row.maxQuestions) || 10, minQuestions),
    durationMinutes: Number(row.durationMinutes) || 10,
    focusAreas: Array.isArray(row.focusAreas) ? row.focusAreas.filter(Boolean) : [],
  };
}

const SCREENER_BLOCK: Record<ScreenerKey, string> = {
  notice: 'screener_notice',
  salary: 'screener_salary',
  reasonLeaving: 'screener_reason_leaving',
  gaps: 'screener_gaps',
  location: 'screener_location',
  workMode: 'screener_work_mode',
  travel: 'screener_travel',
  reference: 'screener_reference',
};

/**
 * The interview prompt, from named blocks in a fixed order: the core first,
 * then one block per enabled option (role introduction, core questions, custom
 * questions, screeners, salary per policy, candidate questions, hear back,
 * close), and the hiring team's own words last. `used` names every block that
 * went in, which is what the call log records and what the tests check.
 */
export function assembleInterviewPrompt(
  library: PromptBlockLibrary,
  o: InterviewOptions,
  ctx: PromptContext
): { text: string; used: string[] } {
  const used: string[] = [];
  const parts: string[] = [];
  const block = (name: string) => {
    const text = library.blocks[name];
    if (typeof text !== 'string') throw new Error(`Interview prompt block "${name}" is missing from the active library`);
    return text;
  };
  const band = formatBandSpoken(ctx.bandMin, ctx.bandMax);
  const vars = {
    agentName: ctx.agentName,
    tenantName: ctx.tenantName,
    languageHint: ctx.languageHint,
    jdSummary: ctx.jdSummary,
    criteriaList: ctx.criteriaList,
    difficulty: o.difficulty,
    minQuestions: o.minQuestions,
    maxQuestions: o.maxQuestions,
    durationMinutes: o.durationMinutes,
    focusAreas: o.focusAreas.join(', '),
    gaps: ctx.gaps.join('; '),
    jobLocation: ctx.jobLocation || "the job's location",
    band,
    hearBackDays: o.hearBackDays,
    instructions: o.instructionText.trim(),
    referenceQuestion: library.blocks.line_reference ?? '',
  };
  const add = (name: string, extra: Record<string, string | number | null | undefined> = {}) => {
    used.push(name);
    parts.push(fillBlock(block(name), { ...vars, ...extra }));
  };

  add('core');
  for (const section of ctx.afterCore ?? []) parts.push(section);

  if (o.introduceRole && ctx.jdSummary) add('role_intro');

  if (ctx.criteriaList) {
    add('core_questions', {
      focusLine: o.focusAreas.length ? fillBlock(block('focus_line'), vars) : '',
      difficultyGuidance: block(`difficulty_${o.difficulty}`),
    });
  }

  if (o.customQuestions.length) {
    add('custom_questions', {
      customQuestions: o.customQuestions.map((q, i) => `${i + 1}. ${q.trim()}`).join('\n'),
    });
  }

  // Screeners, grouped near the end. The gap screener only exists when the CV
  // screening flagged a gap (I11), so it costs nothing otherwise.
  const screenerLines: string[] = [];
  const screenerNames: string[] = [];
  for (const key of SCREENER_KEYS) {
    if (!o.screeners[key]) continue;
    if (key === 'gaps' && !ctx.gaps.length) continue;
    screenerNames.push(SCREENER_BLOCK[key]);
    screenerLines.push(fillBlock(block(SCREENER_BLOCK[key]), vars));
  }
  if (screenerLines.length) {
    used.push('screeners', ...screenerNames);
    parts.push(`${fillBlock(block('screeners'), vars)}\n${screenerLines.join('\n')}`);
  }

  if (o.screeners.salary) {
    if (o.shareBand && band) add('salary_share_band');
    add(`salary_${o.mismatchAction}`);
  }

  if (o.candidateQuestions) add('candidate_questions');
  if (o.hearBackDays) add('hear_back');
  add('close');
  if (o.instructionText.trim()) add('instructions');

  return { text: parts.join('\n\n'), used };
}

// ---------------------------------------------------------------------------
// Devices (Batch 5, P15)
// ---------------------------------------------------------------------------

/**
 * "Chrome on Mac", "Firefox on Windows", "Safari on iPhone". Anything that is
 * not a browser - a server-side refresh, a script - is "Unknown browser", so a
 * label like "Next.js Middleware" can never be shown as a device.
 */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua || !/Mozilla\/|Opera\//.test(ua)) return 'Unknown browser';
  const browser =
    /EdgA?\/|EdgiOS\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
    : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\/|Chromium\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
    : null;
  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : null;
  if (!browser) return 'Unknown browser';
  return os ? `${browser} on ${os}` : browser;
}
