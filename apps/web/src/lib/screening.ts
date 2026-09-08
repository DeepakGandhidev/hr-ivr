import { DEFAULT_SCREENING_THRESHOLD, ValidationError } from "@pratibha/shared";
import {
  estimateCostUsd,
  extractText,
  isMockMode,
  llmClient,
  llmModel,
  renderTemplate,
  thinkingFor,
} from "@/lib/llm";

export interface ScreeningInput {
  /** Body of the active `cv_screening` prompt template, read by the caller. */
  promptBody: string;
  jobTitle: string;
  mustHaves: string[];
  goodToHaves: string[];
  cvParsed: Record<string, unknown> | null;
  threshold?: number;
}

export interface ScreeningResult {
  score: number;
  matchedMustHaves: string[];
  gaps: string[];
  verdict: "shortlist" | "archive";
  reasonSummary: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Scores one candidate against the job's must-haves (§5 Stage 5). Threshold
 * splits shortlist from archive; archived candidates keep their reason, which
 * the tenant sees and the candidate never does.
 */
export async function runCvScreening(input: ScreeningInput): Promise<ScreeningResult> {
  const threshold = input.threshold ?? DEFAULT_SCREENING_THRESHOLD;

  if (isMockMode()) {
    return mockScreening(input, threshold);
  }

  const prompt = renderTemplate(input.promptBody, {
    jobTitle: input.jobTitle,
    mustHaves: input.mustHaves.join("\n- ") || "None",
    goodToHaves: input.goodToHaves.join("\n- ") || "None",
    cvParsed: input.cvParsed ? JSON.stringify(input.cvParsed, null, 2) : "No parsed CV data",
    threshold: String(threshold),
  });

  const model = llmModel();
  const response = await llmClient().messages.create({
    model,
    max_tokens: 1024,
    ...thinkingFor(model),
    messages: [{ role: "user", content: prompt }],
  } as any);

  const text = extractText(response.content);

  let parsed: Record<string, unknown>;
  try {
    const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ValidationError("Screening response could not be parsed as JSON", { raw: text });
  }

  const score = Number(parsed.score);
  if (Number.isNaN(score) || score < 0 || score > 100) {
    throw new ValidationError("Invalid screening score", { score: parsed.score });
  }

  // The threshold is the tenant's setting, so it decides the verdict — not the
  // model's opinion of its own score.
  const verdict = score >= threshold ? "shortlist" : "archive";

  return {
    score,
    matchedMustHaves: Array.isArray(parsed.matchedMustHaves) ? parsed.matchedMustHaves.map(String) : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps.map(String) : [],
    verdict,
    reasonSummary: String(parsed.reasonSummary ?? ""),
    model,
    tokensIn: response.usage.input_tokens,
    tokensOut: response.usage.output_tokens,
    costUsd: estimateCostUsd(response.usage.input_tokens, response.usage.output_tokens, model),
  };
}

/**
 * Deterministic keyword overlap, so a mock run still produces a spread of
 * scores across candidates rather than one constant — the shortlist screen is
 * only worth looking at if some candidates fall on each side of the threshold.
 */
function mockScreening(input: ScreeningInput, threshold: number): ScreeningResult {
  const haystack = JSON.stringify(input.cvParsed ?? {}).toLowerCase();
  const hit = (skill: string) => haystack.includes(skill.toLowerCase());

  const matchedMustHaves = input.mustHaves.filter(hit);
  const gaps = input.mustHaves.filter((s) => !hit(s));
  const matchedGood = input.goodToHaves.filter(hit);

  const mustRatio = input.mustHaves.length ? matchedMustHaves.length / input.mustHaves.length : 1;
  const goodRatio = input.goodToHaves.length ? matchedGood.length / input.goodToHaves.length : 0;
  const score = Math.round(mustRatio * 80 + goodRatio * 20);

  const verdict = score >= threshold ? "shortlist" : "archive";
  const reasonSummary =
    `[mock] Matched ${matchedMustHaves.length}/${input.mustHaves.length} must-haves` +
    (matchedGood.length ? ` and ${matchedGood.length} good-to-haves` : "") +
    (gaps.length ? `. Gaps: ${gaps.join(", ")}.` : ". No gaps against must-haves.");

  return {
    score,
    matchedMustHaves,
    gaps,
    verdict,
    reasonSummary,
    model: "mock",
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
}
