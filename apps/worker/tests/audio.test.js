import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

import { decode, encode, decodeByte, frameEnergy, SILENCE_BYTE } from '../src/audio/mulaw.js';
import { VoiceActivityDetector } from '../src/audio/vad.js';
import { pcmToMulaw8k, createTTS, SarvamTTS, ElevenLabsTTS, elevenLabsSourceRate } from '../src/audio/tts.js';
import { PlivoStream } from '../src/audio/plivoStream.js';
import { splitSentences, toSpeech } from '../src/utils/speech.js';
import { truncateToHeard } from '../src/lib/history.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const tone = (amp, noise = 0, samples = 160) => {
  const s = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    s[i] = Math.round(amp * Math.sin((2 * Math.PI * 300 * i) / 8000) + (Math.random() - 0.5) * noise);
  }
  return encode(s);
};

describe('mu-law codec', () => {
  it('treats 0xFF as digital silence', () => {
    expect(decodeByte(SILENCE_BYTE)).toBe(0);
    expect(frameEnergy(Buffer.alloc(160, SILENCE_BYTE))).toBe(0);
  });

  it('round-trips within mu-law quantisation error', () => {
    const s = new Int16Array(8000);
    for (let i = 0; i < s.length; i++) s[i] = Math.round(20000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    const back = decode(encode(s));
    const worst = Math.max(...Array.from(s, (v, i) => Math.abs(back[i] - v))) / 32768;
    expect(worst).toBeLessThan(0.02);
  });

  it('separates speech energy from silence by a wide margin', () => {
    expect(frameEnergy(tone(12000))).toBeGreaterThan(frameEnergy(tone(0, 200)) * 10);
  });
});

describe('barge-in VAD', () => {
  it('learns the line noise floor instead of using a fixed threshold', () => {
    const quiet = new VoiceActivityDetector();
    const noisy = new VoiceActivityDetector();
    for (let i = 0; i < 100; i++) {
      quiet.push(tone(0, 50));
      noisy.push(tone(0, 4000));
    }
    // A noisy mobile line ends up with a higher bar, so its own hiss cannot
    // trip a barge-in.
    expect(noisy.threshold).toBeGreaterThan(quiet.threshold);
  });

  it('does not fire on line noise alone', () => {
    const vad = new VoiceActivityDetector();
    const events = [];
    for (let i = 0; i < 200; i++) {
      const e = vad.push(tone(0, 600));
      if (e) events.push(e);
    }
    expect(events).toEqual([]);
  });

  it('fires within about 60ms of speech starting', () => {
    const vad = new VoiceActivityDetector();
    for (let i = 0; i < 50; i++) vad.push(tone(0, 300));

    let firedAt = null;
    for (let i = 0; i < 20 && firedAt === null; i++) {
      if (vad.push(tone(9000, 300)) === 'speech-start') firedAt = (i + 1) * 20;
    }
    expect(firedAt).toBe(60);
  });

  it('waits out a mid-sentence pause before calling the turn over', () => {
    const vad = new VoiceActivityDetector();
    for (let i = 0; i < 50; i++) vad.push(tone(0, 300));
    for (let i = 0; i < 10; i++) vad.push(tone(9000, 300));

    // 300ms of thinking silence - shorter than the 500ms hangover
    let ended = false;
    for (let i = 0; i < 15; i++) if (vad.push(tone(0, 300)) === 'speech-end') ended = true;
    expect(ended).toBe(false);
    expect(vad.speaking).toBe(true);
  });
});

describe('TTS resampling fallback', () => {
  it('downsamples 24kHz linear PCM to 8kHz mu-law at exactly a third the rate', () => {
    const n = 2400;
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(15000 * Math.sin((2 * Math.PI * 440 * i) / 24000)), i * 2);
    expect(pcmToMulaw8k(pcm, 24000)).toHaveLength(800);
  });

  it('passes 8kHz straight through', () => {
    expect(pcmToMulaw8k(Buffer.alloc(320), 8000)).toHaveLength(160);
  });
});

describe('speech text preparation', () => {
  it('strips markdown the TTS would otherwise read aloud', () => {
    expect(toSpeech('**Six years** of `Node.js` — see [the CV](http://x)'))
      .toBe('Six years of Node.js — see the CV');
  });

  it('does not split a decimal into two utterances', () => {
    expect(splitSentences('You have 6.5 years at Infosys. Is now a good time?'))
      .toEqual(['You have 6.5 years at Infosys.', 'Is now a good time?']);
  });

  it('does not split on an abbreviation', () => {
    expect(splitSentences('We are open until 7 p.m. India time.')).toHaveLength(1);
  });

  it('breaks an overlong sentence at a comma so audio starts sooner', () => {
    const long = `I would like to understand ${'the details of your work '.repeat(12)}, and then move on.`;
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(230);
  });
});

function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1; // WebSocket.OPEN
  ws.sent = [];
  ws.send = (payload) => ws.sent.push(JSON.parse(payload));
  ws.close = () => { ws.readyState = 3; };
  return ws;
}

const deliver = (ws, message) => ws.emit('message', Buffer.from(JSON.stringify(message)));

describe('Plivo stream protocol', () => {
  it('chunks playback under the 16KB base64 recommendation and checkpoints the segment', () => {
    const ws = fakeSocket();
    const stream = new PlivoStream(ws, logger);
    // 3 seconds of audio at 8000 bytes/sec
    const id = stream.play(Buffer.alloc(24000, SILENCE_BYTE), 'a long sentence');

    const audio = ws.sent.filter(m => m.event === 'playAudio');
    const checkpoints = ws.sent.filter(m => m.event === 'checkpoint');

    expect(audio).toHaveLength(6);
    for (const message of audio) {
      expect(message.media.payload.length).toBeLessThanOrEqual(16 * 1024);
      expect(message.media.contentType).toBe('audio/x-mulaw');
      expect(message.media.sampleRate).toBe(8000);
    }
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].checkpoint.id).toBe(id);
  });

  it('decodes inbound media and surfaces DTMF', () => {
    const ws = fakeSocket();
    const stream = new PlivoStream(ws, logger);
    const frames = []; const digits = [];
    stream.on('audio', f => frames.push(f));
    stream.on('dtmf', d => digits.push(d));

    deliver(ws, { event: 'start', start: { streamId: 's1', callUUID: 'c1' } });
    deliver(ws, { event: 'media', media: { payload: Buffer.alloc(160, SILENCE_BYTE).toString('base64') } });
    deliver(ws, { event: 'dtmf', dtmf: { digit: '7' } });

    expect(stream.streamId).toBe('s1');
    expect(frames[0]).toHaveLength(160);
    expect(digits).toEqual(['7']);
  });

  it('treats a checkpoint ack as confirming every segment queued before it', () => {
    const ws = fakeSocket();
    const stream = new PlivoStream(ws, logger);
    stream.play(Buffer.alloc(800, SILENCE_BYTE), 'First sentence.');
    const second = stream.play(Buffer.alloc(800, SILENCE_BYTE), 'Second sentence.');
    stream.play(Buffer.alloc(800, SILENCE_BYTE), 'Third sentence.');

    deliver(ws, { event: 'playedStream', playedStream: { checkpointId: second } });

    // Playback is ordered, so the first is implicitly confirmed by the second.
    const { heard, dropped } = stream.clear();
    expect(heard).toBe('First sentence. Second sentence.');
    expect(dropped).toBe('Third sentence.');
    expect(ws.sent.some(m => m.event === 'clearAudio')).toBe(true);
  });

  it('survives an unparseable frame without tearing the call down', () => {
    const ws = fakeSocket();
    const stream = new PlivoStream(ws, logger);
    const closed = vi.fn();
    stream.on('close', closed);
    ws.emit('message', Buffer.from('not json'));
    expect(closed).not.toHaveBeenCalled();
  });
});

// The behaviour Twilio used to hand over as `utteranceUntilInterrupt`.
describe('barge-in history reconciliation', () => {
  const spoken = (content) => ({ role: 'assistant', content });

  it('trims the last turn to the sentences that actually played', () => {
    const history = [{ role: 'user', content: 'Yes, go ahead.' }, spoken('Thanks Ananya. Tell me about the payments integration.')];
    const result = truncateToHeard(history, { heard: 'Thanks Ananya.', dropped: 'Tell me about the payments integration.' });

    expect(result.changed).toBe(true);
    // The question was never heard, so it is no longer on the record as asked
    // and Pratibha will ask it again.
    expect(history[1].content).toBe('Thanks Ananya.');
  });

  it('drops the turn entirely when none of it was heard', () => {
    const history = [{ role: 'user', content: 'Hello?' }, spoken('Tell me about the payments integration.')];
    const result = truncateToHeard(history, { heard: '', dropped: 'Tell me about the payments integration.' });

    expect(result.changed).toBe(true);
    expect(history).toHaveLength(1);
  });

  it('leaves history alone when the whole reply played', () => {
    const history = [spoken('Is now a good time?')];
    expect(truncateToHeard(history, { heard: 'Is now a good time?', dropped: '' }).changed).toBe(false);
    expect(history[0].content).toBe('Is now a good time?');
  });

  it('never rewrites a tool-call turn', () => {
    const toolTurn = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'verify_code', input: {} }] };
    const history = [toolTurn];
    expect(truncateToHeard(history, { heard: '', dropped: 'something' }).changed).toBe(false);
    expect(history[0]).toBe(toolTurn);
  });
});

// Regression: every terminal path ends the session inside a tool and then still
// owes the candidate a closing line. An earlier version of #say broke out of the
// sentence loop as soon as session.ended went true, so callers who gave a bad
// code, asked for a human, or simply finished the screening were hung up on
// without a word - the call died at precisely its most sensitive moment.
describe('a closing line still plays after a tool ends the call', () => {
  class FakePlivo extends EventEmitter {
    constructor() { super(); this.spoken = []; }
    play(audio, text) { this.spoken.push(text); return `cp-${this.spoken.length}`; }
    clear() { return { heard: '', dropped: '' }; }
    get queuedMs() { return 0; }
    close() {}
  }

  const build = async (runTurn) => {
    const { CallSession } = await import('../src/lib/callSession.js');
    const { MockSTT, MockTTS } = await import('../src/audio/mockSpeech.js');
    const { SessionManager } = await import('../src/lib/sessionManager.js');

    const session = new SessionManager().create('t1');
    const plivo = new FakePlivo();
    const stt = new MockSTT();

    const call = new CallSession({
      plivo, session, stt, tts: new MockTTS(), logger,
      agent: { runTurn },
      analyst: { analyse: async () => null },
      api: {
        startCall: async () => ({ id: 1 }),
        updateCall: async () => ({}),
        saveTranscript: async () => ({}),
        escalate: async () => ({})
      },
      config: { vad: {}, stt: {}, tts: { codec: 'mulaw' } }
    });

    await call.begin({ streamId: 's1', callUUID: 't1' });
    plivo.spoken.length = 0; // drop the disclosure; we are testing what follows
    return { call, session, plivo, stt };
  };

  it('speaks the goodbye when the tool finished the call before the reply', async () => {
    const goodbye = 'Thanks for your time, Ananya. Our team will review this and get back to you by email.';
    const { call, session, plivo, stt } = await build(async (s, speak) => {
      s.finish('completed');   // what end_call does
      await speak(goodbye);    // what the model still owes the candidate
    });

    stt.say('No questions from me, thanks.');
    await call.whenIdle();

    expect(plivo.spoken.join(' ')).toContain('Our team will review this');
    expect(session.outcome).toBe('completed');
  });

  // The other half of the same guarantee: the reply must still stop the moment
  // the candidate talks over it. Driven through the real path - loud frames in,
  // VAD fires, clearAudio goes out - rather than by poking the abort directly.
  it('stops mid-reply when the candidate talks over her', async () => {
    let release;
    const gatedTts = {
      async *stream(text, signal) {
        await new Promise(r => { release = r; });
        if (signal?.aborted) return;
        yield Buffer.alloc(160, SILENCE_BYTE);
      },
      reset() {}, close() {}
    };

    const { CallSession } = await import('../src/lib/callSession.js');
    const { MockSTT } = await import('../src/audio/mockSpeech.js');
    const { SessionManager } = await import('../src/lib/sessionManager.js');

    const session = new SessionManager().create('t2');
    const plivo = new FakePlivo();
    let cleared = false;
    plivo.clear = () => { cleared = true; return { heard: '', dropped: 'Two. Three.' }; };
    const stt = new MockSTT();

    const call = new CallSession({
      plivo, session, stt, tts: gatedTts, logger,
      agent: { runTurn: async (s, speak) => { await speak('One. Two. Three.'); } },
      analyst: { analyse: async () => null },
      api: { startCall: async () => ({ id: 1 }), updateCall: async () => ({}), saveTranscript: async () => ({}), escalate: async () => ({}) },
      config: { vad: {}, stt: {}, tts: { codec: 'mulaw' } }
    });

    // begin() speaks the disclosure through the same gate, so let it through.
    const begun = call.begin({ streamId: 's1', callUUID: 't2' });
    for (let i = 0; i < 8; i++) { release?.(); await new Promise(r => setImmediate(r)); }
    await begun;
    plivo.spoken.length = 0;

    stt.say('Go on then.');
    await new Promise(r => setImmediate(r));
    // Mid-reply, the candidate starts talking. Three loud frames is what the
    // VAD needs to call it speech.
    expect(call.speaking).toBe(true);
    for (let i = 0; i < 5; i++) plivo.emit('audio', tone(12000));

    release?.();
    await call.whenIdle();

    expect(cleared).toBe(true);
    expect(call.speaking).toBe(false);
    expect(plivo.spoken.length).toBeLessThan(3);
  });
});

// Either vendor can speak; the rest of the system must not be able to tell which
// one did. Whatever comes out of stream() is mu-law 8 kHz, because that is the
// only thing Plivo will play.
describe('switching voice vendor', () => {
  const config = (provider, elevenlabs = {}) => ({
    tts: {
      provider,
      apiKey: 'sarvam-key',
      model: 'bulbul:v3',
      codec: 'linear16',
      sourceRate: 22050,
      elevenlabs: {
        apiKey: 'xi-key',
        voiceId: 'voice-1',
        model: 'eleven_flash_v2_5',
        outputFormat: 'ulaw_8000',
        stability: 0.5,
        similarityBoost: 0.75,
        speed: 1.0,
        ...elevenlabs
      }
    }
  });

  const message = (tts, payload) => tts.decode(Buffer.from(JSON.stringify(payload)));

  it('builds whichever provider TTS_PROVIDER names', () => {
    expect(createTTS(config('sarvam'), logger)).toBeInstanceOf(SarvamTTS);
    expect(createTTS(config('elevenlabs'), logger)).toBeInstanceOf(ElevenLabsTTS);
    expect(() => createTTS(config('polly'), logger)).toThrow(/polly/);
  });

  it('dials ElevenLabs with the voice, model and format it was configured with', () => {
    const url = new URL(createTTS(config('elevenlabs'), logger).url());
    expect(url.pathname).toContain('/voice-1/stream-input');
    expect(url.searchParams.get('model_id')).toBe('eleven_flash_v2_5');
    expect(url.searchParams.get('output_format')).toBe('ulaw_8000');
  });

  // The empty-string terminator ends the context and closes the socket, which
  // would cost a handshake on every single turn.
  it('ends an ElevenLabs utterance with a flush, not a close', () => {
    const sent = createTTS(config('elevenlabs'), logger).utteranceMessages('Hello there');
    expect(sent).toEqual([{ text: 'Hello there ' }, { flush: true }]);
  });

  it('passes ElevenLabs mu-law through and transcodes its PCM', () => {
    const ulaw = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
    const passed = message(createTTS(config('elevenlabs'), logger), { audio: ulaw.toString('base64') });
    expect(Buffer.compare(passed, ulaw)).toBe(0);

    const pcm = Buffer.alloc(3200); // 1600 samples at 16 kHz = 800 at 8 kHz
    const transcoded = message(
      createTTS(config('elevenlabs', { outputFormat: 'pcm_16000' }), logger),
      { audio: pcm.toString('base64') }
    );
    expect(transcoded.length).toBe(800);
  });

  it('ends the utterance on isFinal and on an error, and ignores the rest', () => {
    const tts = createTTS(config('elevenlabs'), logger);
    expect(message(tts, { isFinal: true })).toBe(null);
    expect(message(tts, { error: 'voice_not_found', code: 1008 })).toBe(null);
    expect(message(tts, { normalizedAlignment: { chars: [] } })).toBe(undefined);
    expect(tts.decode(Buffer.from('not json'))).toBe(undefined);
  });

  // The sample rate is read back off the format string so the two cannot drift.
  it('reads the sample rate out of the ElevenLabs format name', () => {
    expect(elevenLabsSourceRate('ulaw_8000')).toBe(0);
    expect(elevenLabsSourceRate('pcm_16000')).toBe(16000);
    expect(elevenLabsSourceRate('pcm_24000')).toBe(24000);
    expect(elevenLabsSourceRate('mp3_44100_128')).toBeNaN();
  });

  it('leaves the Sarvam wire format alone', () => {
    const tts = createTTS(config('sarvam'), logger);
    expect(tts.utteranceMessages('Hello')).toEqual([
      { type: 'text', data: { text: 'Hello' } },
      { type: 'flush' }
    ]);
    const pcm = Buffer.alloc(4410); // 2205 samples at 22050 Hz = 800 at 8 kHz
    const chunk = message(tts, { type: 'audio', data: { audio: pcm.toString('base64') } });
    expect(chunk.length).toBe(800);
  });
});

describe('pcmToMulaw8k — Sarvam 22.05 kHz path', () => {
  /**
   * Sarvam's bulbul:v3 ignores output_audio_sample_rate and always emits
   * 22.05 kHz (confirmed from the WAV header on its REST endpoint). Handing
   * those bytes to Plivo as if they were 8 kHz played every greeting ~2.8x too
   * slow and robotic.
   */
  it('resamples 22050 Hz down to 8 kHz at the right ratio', () => {
    const seconds = 1;
    const samples = new Int16Array(22050 * seconds);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 22050));
    }
    const out = pcmToMulaw8k(Buffer.from(samples.buffer), 22050);
    // One second in must be one second out: 8000 mu-law bytes, within rounding.
    expect(out.length).toBeGreaterThan(7900);
    expect(out.length).toBeLessThan(8100);
  });

  it('handles a chunk landing on an odd byteOffset without throwing', () => {
    // Node pools small Buffers, so Buffer.from(base64) can start at an odd
    // offset — which Int16Array rejects, mid-call, for only some chunks.
    const backing = Buffer.alloc(2001);
    const odd = backing.subarray(1);
    expect(odd.byteOffset % 2).toBe(1);
    expect(() => pcmToMulaw8k(odd, 22050)).not.toThrow();
  });

  it('drops an odd trailing byte rather than shifting every later sample', () => {
    const even = pcmToMulaw8k(Buffer.alloc(400), 22050);
    const odd = pcmToMulaw8k(Buffer.alloc(401), 22050);
    expect(odd.length).toBe(even.length);
  });
});
