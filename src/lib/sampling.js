/**
 * `temperature`, `top_p` and `top_k` were removed on the current frontier
 * models - Opus 5, Sonnet 5, Opus 4.7/4.8 and Fable 5 all reject them with a
 * 400. Haiku 4.5, which handles the on-call turns, still accepts them.
 *
 * The model is configurable per deployment, so the request has to adapt to
 * whichever one is set rather than hard-coding either shape. Getting this wrong
 * fails the whole call, not one turn.
 */
const SAMPLING_REMOVED = [/^claude-opus-(5|4-[78])/, /^claude-sonnet-5/, /^claude-fable-5/, /^claude-mythos-5/];

export function acceptsSampling(model) {
  return !SAMPLING_REMOVED.some(pattern => pattern.test(model ?? ''));
}

export function samplingFor(model, temperature) {
  return acceptsSampling(model) ? { temperature } : {};
}
