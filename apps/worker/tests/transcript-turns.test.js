import { describe, it, expect } from 'vitest';
import { CallTranscript } from '../src/lib/transcript.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function transcript() {
  // No dir, so nothing touches the filesystem.
  return new CallTranscript('s1', 'c1', quiet, {});
}

describe('CallTranscript.turns', () => {
  it('keeps only what was actually said', () => {
    const t = transcript();
    t.record('call.start', {});
    t.record('caller.interim', { text: 'I have five' });
    t.record('caller', { text: 'I have five years of experience.' });
    t.record('model.request', { state: 'SCREEN' });
    t.record('pratibha', { text: 'Tell me about that.' });
    t.record('tool.call', { tool: 'finish_screening' });

    expect(t.turns()).toEqual([
      { speaker: 'candidate', text: 'I have five years of experience.', atMs: expect.any(Number) },
      { speaker: 'pratibha', text: 'Tell me about that.', atMs: expect.any(Number) },
    ]);
  });

  // She streams a reply sentence by sentence and each is recorded separately;
  // unmerged, one question renders as several consecutive bubbles.
  it('merges consecutive turns by the same speaker', () => {
    const t = transcript();
    t.record('pratibha', { text: 'That is everything from my side.' });
    t.record('pratibha', { text: 'Do you have any questions?' });
    t.record('caller', { text: 'No, thank you.' });

    const turns = t.turns();
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      speaker: 'pratibha',
      text: 'That is everything from my side. Do you have any questions?',
    });
    expect(turns[1]).toMatchObject({ speaker: 'candidate', text: 'No, thank you.' });
  });

  it('drops empty and whitespace-only text', () => {
    const t = transcript();
    t.record('pratibha', { text: '   ' });
    t.record('caller', {});
    expect(t.turns()).toEqual([]);
  });

  it('records when each turn happened', () => {
    const t = transcript();
    t.record('caller', { text: 'Hello.' });
    const [turn] = t.turns();
    expect(turn.atMs).toBeGreaterThanOrEqual(0);
  });
});
