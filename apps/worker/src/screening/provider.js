import { Anthropic } from '@anthropic-ai/sdk';
import { samplingFor, thinkingFor } from '../lib/sampling.js';

/**
 * Thin provider wrapper. P0 is Anthropic-only; an OpenAI fallback can be
 * injected by passing a `fallback` client later without changing callers.
 */
export class LlmProvider {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.primary = new Anthropic({
      apiKey: config.anthropic.apiKey,
      ...(config.anthropic.baseUrl ? { baseURL: config.anthropic.baseUrl } : {}),
    });
  }

  async complete({ system, messages, tools, toolChoice, maxTokens = 1024, temperature = 0.2 }) {
    const started = Date.now();
    const response = await this.primary.messages.create({
      model: this.config.anthropic.model,
      max_tokens: maxTokens,
      ...samplingFor(this.config.anthropic.model, temperature),
      ...thinkingFor(this.config.anthropic.model),
      system,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    });

    const usage = response.usage ?? {};
    return {
      content: response.content,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      },
      latencyMs: Date.now() - started,
      model: this.config.anthropic.model,
    };
  }
}
