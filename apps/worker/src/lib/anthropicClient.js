import { Anthropic } from '@anthropic-ai/sdk';

/**
 * An Anthropic client that follows `config.anthropic` as it changes.
 *
 * The worker's config is reloaded in place when a key, endpoint or timeout is
 * changed in the admin panel. A client built once at start-up would go on
 * using the old ones until a restart, so the client is rebuilt whenever the
 * options it would be built with differ from the last. Building one is cheap;
 * comparing is cheaper, so this is safe to call on every turn.
 *
 * `bounded` applies the call's timeout and retry budget. Live calls need it
 * (an unbounded turn is a dead line); the post-call report runs far longer
 * than a turn and keeps the SDK's defaults.
 */
export function liveAnthropicClient(config, { bounded = false } = {}) {
  let client = null;
  let builtWith = null;

  return () => {
    const a = config.anthropic ?? {};
    const options = {
      apiKey: a.apiKey,
      ...(bounded ? { timeout: a.timeoutMs ?? 12_000, maxRetries: a.maxRetries ?? 1 } : {}),
      ...(a.baseUrl ? { baseURL: a.baseUrl } : {}),
    };
    const signature = JSON.stringify(options);
    if (!client || signature !== builtWith) {
      client = new Anthropic(options);
      builtWith = signature;
    }
    return client;
  };
}
