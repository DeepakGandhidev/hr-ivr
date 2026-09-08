import { describe, it, expect, vi } from 'vitest';

/**
 * Turn-taking under interruption.
 *
 * The call used to chain one model turn per final transcript. A caller who said
 * three things while the model was thinking got three replies in a row: the
 * line went quiet, then the agent talked over itself. Worse, an unbounded
 * model call held the chain for as long as the SDK's ten-minute default, so
 * everything said in that window queued up behind it and the call was, from the
 * caller's side, simply dead.
 *
 * This exercises the pump in isolation — the same shape as CallSession's, with
 * the turn body replaced by a controllable promise.
 */
function makePump({ onTurn }) {
  const state = { turnRunning: false, pending: [], ended: false, turns: [] };

  function pump(initial = false) {
    if (state.turnRunning || state.ended) return;

    const utterance = state.pending.length ? state.pending.join(' ').trim() : null;
    state.pending = [];
    if (!initial && !utterance) return;

    state.turnRunning = true;
    state.turns.push(utterance);
    Promise.resolve(onTurn(utterance))
      .catch(() => {})
      .finally(() => {
        state.turnRunning = false;
        if (state.pending.length) pump();
      });
  }

  return {
    state,
    say(text) {
      state.pending.push(text);
      pump();
    },
    start() {
      pump(true);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('one turn at a time', () => {
  it('coalesces everything said during a turn into a single reply', async () => {
    let release;
    const inFlight = new Promise((r) => { release = r; });
    const onTurn = vi.fn().mockReturnValueOnce(inFlight).mockResolvedValue(undefined);

    const pump = makePump({ onTurn });

    pump.say('my name is priya');
    // Three more utterances while the first turn is still running.
    pump.say('sorry');
    pump.say('I meant Priya Sharma');
    pump.say('can you hear me');

    expect(onTurn).toHaveBeenCalledTimes(1);

    release();
    await tick();
    await tick();

    // One follow-up turn, carrying all three interruptions — not three turns.
    expect(onTurn).toHaveBeenCalledTimes(2);
    expect(onTurn.mock.calls[1][0]).toBe('sorry I meant Priya Sharma can you hear me');
  });

  it('never runs two turns concurrently', async () => {
    let concurrent = 0;
    let peak = 0;
    const onTurn = vi.fn(async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await tick();
      concurrent -= 1;
    });

    const pump = makePump({ onTurn });
    for (let i = 0; i < 8; i += 1) pump.say(`line ${i}`);

    for (let i = 0; i < 20; i += 1) await tick();
    expect(peak).toBe(1);
  });

  it('keeps answering after a turn throws, rather than wedging the call', async () => {
    const onTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error('model exploded'))
      .mockResolvedValue(undefined);

    const pump = makePump({ onTurn });
    pump.say('hello');
    await tick();
    await tick();

    pump.say('are you there');
    for (let i = 0; i < 5; i += 1) await tick();

    // A failed turn must release the lock; otherwise every later utterance is
    // silently swallowed and the caller talks to nobody.
    expect(onTurn).toHaveBeenCalledTimes(2);
    expect(onTurn.mock.calls[1][0]).toBe('are you there');
  });

  it('runs an opening turn with no utterance', () => {
    const onTurn = vi.fn().mockResolvedValue(undefined);
    const pump = makePump({ onTurn });

    pump.start();
    expect(onTurn).toHaveBeenCalledWith(null);
  });

  it('ignores blank input rather than triggering an empty turn', () => {
    const onTurn = vi.fn().mockResolvedValue(undefined);
    const pump = makePump({ onTurn });

    pump.say('');
    pump.say('   ');
    expect(onTurn).not.toHaveBeenCalled();
  });

  it('stops once the call has ended', async () => {
    const onTurn = vi.fn().mockResolvedValue(undefined);
    const pump = makePump({ onTurn });

    pump.state.ended = true;
    pump.say('hello');
    await tick();

    expect(onTurn).not.toHaveBeenCalled();
  });
});
