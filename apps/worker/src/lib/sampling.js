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

/**
 * Moonshot's Kimi models run with thinking ON by default, and that breaks this
 * service in two separate ways:
 *
 *  1. They reject `tool_choice: {type:'tool'}` while thinking is on
 *     ("tool_choice 'specified' is incompatible with thinking enabled") - which
 *     is exactly the shape the post-call assessment uses, so no candidate would
 *     ever get scored.
 *  2. It costs 4+ seconds per turn. Measured on kimi-k2.6: 5332 ms with
 *     thinking, 1131 ms without. The 800 ms budget in 4.2 cannot absorb that on
 *     a live call - the candidate hears dead air.
 *
 * Turning it off fixes both. Two exceptions are deliberate:
 *  - Claude models are left alone; their defaults are already right for both
 *    call sites and Opus 5 rejects `disabled` above effort=high.
 *  - kimi-k2.7-code-* refuses type=disabled outright ("only type=enabled is
 *    allowed for this model"), so it is left alone too. It is fast enough for
 *    on-call turns but cannot run the assessment.
 */
const THINKING_NOT_DISABLEABLE = [/^kimi-k2\.7-code/];

export function thinkingFor(model) {
  const name = model ?? '';
  if (/^claude-/.test(name)) return {};
  if (THINKING_NOT_DISABLEABLE.some(pattern => pattern.test(name))) return {};
  return { thinking: { type: 'disabled' } };
}
