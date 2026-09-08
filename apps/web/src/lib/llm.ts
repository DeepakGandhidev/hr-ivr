import { Anthropic } from "@anthropic-ai/sdk";

/**
 * Single place the web app talks to a model. The provider is swappable by env
 * alone (§2.10 "we own the data layer", §13 "OpenAI fallback behind a provider
 * interface") — any endpoint speaking the Anthropic Messages API works, and
 * Moonshot's Kimi endpoint is what this deployment runs against.
 */
export function llmClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export function llmModel(): string {
  return process.env.ANTHROPIC_MODEL ?? "kimi-k2.6";
}

/**
 * Kimi runs with thinking ON by default, which rejects `tool_choice: {type:
 * "tool"}` — the exact shape screening and report generation use — and adds
 * seconds of latency. Claude models are left alone: their defaults are already
 * right, and Opus 5 rejects `disabled` above effort=high. `kimi-k2.7-code`
 * refuses `disabled` outright, so it is left alone too.
 *
 * Mirrors apps/worker/src/lib/sampling.js — keep the two in step.
 */
export function thinkingFor(model: string): { thinking?: { type: "disabled" } } {
  if (/^claude-/.test(model)) return {};
  if (/^kimi-k2\.7-code/.test(model)) return {};
  return { thinking: { type: "disabled" } };
}

/**
 * MOCK_MODE lets the whole pipeline — JD, screening, reports — run with no
 * provider account and no spend, so a demo tenant or a CI run exercises every
 * stage. It is off unless explicitly set.
 */
export function isMockMode(): boolean {
  return process.env.MOCK_MODE === "true";
}

const PRICING: Record<string, { in: number; out: number }> = {
  // USD per token.
  "kimi-k2.6": { in: 0.6e-6, out: 2.5e-6 },
  "kimi-k3": { in: 0.6e-6, out: 2.5e-6 },
  "kimi-k2.7-code": { in: 0.6e-6, out: 2.5e-6 },
  "claude-3-5-sonnet": { in: 3e-6, out: 15e-6 },
  "claude-3-opus": { in: 15e-6, out: 75e-6 },
  "claude-3-haiku": { in: 0.25e-6, out: 1.25e-6 },
  "claude-haiku-4-5": { in: 1e-6, out: 5e-6 },
};

/**
 * §8 makes cost a first-class column, so an unknown model must not silently
 * bill zero — it falls back to the rate of the model family we run.
 */
export function estimateCostUsd(tokensIn: number, tokensOut: number, model: string): number {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k));
  const rate = key ? PRICING[key] : PRICING["kimi-k2.6"];
  return tokensIn * rate.in + tokensOut * rate.out;
}

export function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}
