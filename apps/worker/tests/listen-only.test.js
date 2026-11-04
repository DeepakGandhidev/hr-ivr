import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const { startSettings, __resetSettingsRuntime } = await import('@pratibha/shared/settings-runtime');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** Records every line the agent would have spoken. */
class FakePlivo extends EventEmitter {
  constructor() { super(); this.spoken = []; }
  play(audio, text) { this.spoken.push(text); return `cp-${this.spoken.length}`; }
  async playStream(chunks, { text, signal } = {}) {
    let queued = 0;
    for await (const chunk of chunks) {
      if (signal?.aborted) break;
      queued += chunk.length;
    }
    if (!queued || signal?.aborted) return null;
    this.spoken.push(text);
    return `cp-${this.spoken.length}`;
  }
  clear() { return { heard: '', dropped: '' }; }
  get queuedMs() { return 0; }
  close() {}
}

async function build(runTurn) {
  const { CallSession } = await import('../src/lib/callSession.js');
  const { MockSTT, MockTTS } = await import('../src/audio/mockSpeech.js');
  const { SessionManager } = await import('../src/lib/sessionManager.js');

  const session = new SessionManager().create('lo1');
  const plivo = new FakePlivo();
  const stt = new MockSTT();
  const call = new CallSession({
    plivo, session, stt, tts: new MockTTS(), logger,
    agent: { runTurn },
    analyst: { analyse: async () => null },
    api: { startCall: async () => ({ id: 1 }), updateCall: async () => ({}), saveTranscript: async () => ({}), escalate: async () => ({}) },
    config: { vad: {}, stt: {}, tts: { codec: 'mulaw' } },
  });
  await call.begin({ streamId: 's1', callUUID: 'lo1' });
  return { call, session, plivo, stt };
}

afterEach(() => {
  __resetSettingsRuntime();
  logger.info.mockClear();
});

describe('listen-only calls (phone-number verification)', () => {
  it('answers silently, never runs the AI, and logs exactly what it heard', async () => {
    await startSettings({ app: 'worker', load: async () => [{ key: 'calls.listen_only', value: true }], intervalMs: 1e9 });
    const runTurn = vi.fn();
    const { call, plivo, stt } = await build(runTurn);

    stt.say('Your verification code is 6 6 5 3 3 0.');
    await call.whenIdle();

    expect(plivo.spoken).toHaveLength(0); // not even the disclosure
    expect(runTurn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ heard: 'Your verification code is 6 6 5 3 3 0.' }),
      'Listen-only heard'
    );
  });

  it('is off by default: the agent greets as usual', async () => {
    const { plivo } = await build(vi.fn());
    expect(plivo.spoken.length).toBeGreaterThan(0);
  });
});
