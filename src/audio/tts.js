import { WebSocket } from 'ws';
import { encode as mulawEncode } from './mulaw.js';

const SARVAM_ENDPOINT = 'wss://api.sarvam.ai/text-to-speech/ws';
const ELEVENLABS_ENDPOINT = 'wss://api.elevenlabs.io/v1/text-to-speech';

// No audio for this long means the utterance finished. Neither vendor's
// end-of-stream signal is something we depend on: what actually matters for
// turn-taking is when Plivo finishes *playing*, which its checkpoint ack tells
// us exactly. This timeout only closes the generator so it cannot hang a turn.
const IDLE_MS = 1500;

/**
 * Resample linear PCM to 8 kHz and encode to mu-law.
 *
 * Only used when the account cannot emit mu-law directly. Averaging across each
 * source window rather than picking one sample per window matters here: plain
 * decimation aliases a 24 kHz voice into something tinny, and the phone codec
 * is already unkind enough.
 */
export function pcmToMulaw8k(pcm, sourceRate) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  if (sourceRate === 8000) return mulawEncode(samples);

  const ratio = sourceRate / 8000;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    out[i] = end > start ? Math.round(sum / (end - start)) : 0;
  }
  return mulawEncode(out);
}

/**
 * The half of streaming synthesis that is the same whichever vendor is speaking:
 * one warm socket, barge-in by generation counter, and a generator that yields
 * mu-law 8 kHz until the vendor stops or the turn is abandoned.
 *
 * A subclass supplies only what differs - where to connect, how to authenticate,
 * what to send, and how to read one message off the wire.
 */
class StreamingTTS {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.opening = null;
    this.generation = 0;
    this.closed = false;
    this.listeners = new Set();
  }

  /** Vendor hooks. */
  url() { throw new Error('not implemented'); }
  headers() { return {}; }
  /** Sent once when the socket opens; null to send nothing. */
  openingMessages() { return []; }
  /** Sent for each utterance - the text itself plus whatever forces generation. */
  utteranceMessages(_text) { throw new Error('not implemented'); }
  /**
   * One message off the wire: a mu-law chunk to yield, `null` to end the
   * utterance, or `undefined` for anything not worth passing on.
   */
  decode(_data) { return undefined; }

  /** Opens the socket if needed. Kept warm between turns to save the handshake. */
  #ensure() {
    if (this.closed) return Promise.reject(new Error('tts closed'));
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening;

    this.opening = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(), { headers: this.headers() });

      const fail = (err) => {
        this.opening = null;
        this.ws = null;
        reject(err);
      };

      ws.on('open', () => {
        for (const message of this.openingMessages()) ws.send(JSON.stringify(message));
        this.ws = ws;
        this.opening = null;
        resolve(ws);
      });
      ws.on('error', fail);
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
      });
      ws.on('message', (data) => {
        for (const listener of this.listeners) listener(data);
      });
    });

    return this.opening;
  }

  /**
   * Barge-in. In-flight audio for abandoned text must never be played into the
   * next turn, and there is no per-utterance id on the wire to filter it by, so
   * the socket is dropped outright and a fresh one opened behind it. The
   * reconnect hides under the LLM round trip that produces the next reply.
   */
  reset() {
    this.generation++;
    const ws = this.ws;
    this.ws = null;
    this.opening = null;
    ws?.close();
    if (!this.closed) this.#ensure().catch(() => {});
  }

  /**
   * Yields mu-law 8 kHz chunks for `text`. Stops promptly when `signal` aborts.
   */
  async *stream(text, signal) {
    const generation = this.generation;
    const ws = await this.#ensure();

    const queue = [];
    let notify = null;
    let done = false;

    const push = (value) => {
      queue.push(value);
      notify?.();
      notify = null;
    };

    const onMessage = (data) => {
      const chunk = this.decode(data);
      if (chunk === undefined) return;
      if (chunk === null) done = true;
      push(chunk);
    };

    this.listeners.add(onMessage);
    for (const message of this.utteranceMessages(text)) ws.send(JSON.stringify(message));

    try {
      while (!done) {
        if (signal?.aborted || generation !== this.generation) break;

        if (queue.length === 0) {
          const idle = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve(true), IDLE_MS);
            notify = () => { clearTimeout(timer); resolve(false); };
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(true); }, { once: true });
          });
          if (idle) break;
        }

        while (queue.length) {
          const chunk = queue.shift();
          if (chunk === null) { done = true; break; }
          yield chunk;
        }
      }
    } finally {
      this.listeners.delete(onMessage);
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

export class SarvamTTS extends StreamingTTS {
  url() {
    const endpoint = this.config.tts.endpoint || SARVAM_ENDPOINT;
    return `${endpoint}?model=${encodeURIComponent(this.config.tts.model)}`;
  }

  headers() {
    return { 'API-SUBSCRIPTION-KEY': this.config.tts.apiKey };
  }

  openingMessages() {
    const { speaker, language, pace, codec } = this.config.tts;
    return [{
      type: 'config',
      data: {
        speaker,
        language_code: language,
        pace,
        output_audio_codec: codec,
        output_audio_sample_rate: 8000,
        // Small buffers get the first syllable to the caller sooner. On a
        // screening call the candidate is waiting in silence until it lands, so
        // latency beats prosody.
        min_buffer_size: 30,
        max_chunk_length: 120
      }
    }];
  }

  utteranceMessages(text) {
    return [{ type: 'text', data: { text } }, { type: 'flush' }];
  }

  decode(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return undefined;
    }
    if (message.type === 'audio' && message.data?.audio) {
      const raw = Buffer.from(message.data.audio, 'base64');
      return this.config.tts.codec === 'mulaw' ? raw : pcmToMulaw8k(raw, this.config.tts.sourceRate);
    }
    if (message.type === 'error') {
      this.logger.error({ message: message.data ?? message }, 'TTS error');
      return null;
    }
    return undefined;
  }
}

/**
 * The sample rate an ElevenLabs output_format carries, or 0 when the format is
 * already mu-law 8 kHz and needs no conversion.
 *
 * Derived from the format string rather than configured separately: the two
 * cannot then disagree, and a format we have no decoder for (the mp3 ones) is
 * caught at boot by validateConfig instead of producing silence on a live call.
 */
export function elevenLabsSourceRate(format) {
  if (format === 'ulaw_8000') return 0;
  const pcm = /^pcm_(\d+)$/.exec(format);
  return pcm ? Number(pcm[1]) : NaN;
}

export class ElevenLabsTTS extends StreamingTTS {
  url() {
    const { endpoint, voiceId, model, outputFormat } = this.config.tts.elevenlabs;
    const base = endpoint || ELEVENLABS_ENDPOINT;
    const query = new URLSearchParams({
      model_id: model,
      output_format: outputFormat,
      // The socket is held open between turns; without this it is dropped after
      // 20 seconds and every reply after a long answer pays a handshake.
      inactivity_timeout: '180'
    });
    return `${base}/${encodeURIComponent(voiceId)}/stream-input?${query}`;
  }

  headers() {
    return { 'xi-api-key': this.config.tts.elevenlabs.apiKey };
  }

  openingMessages() {
    const { stability, similarityBoost, speed } = this.config.tts.elevenlabs;
    // ElevenLabs requires a first message carrying the settings; the single
    // space is the documented way to send one without speaking anything.
    return [{
      text: ' ',
      voice_settings: { stability, similarity_boost: similarityBoost, speed },
      // Same trade as Sarvam's small buffers: generate as soon as there is
      // enough text to sound natural, so the caller waits in silence for less.
      generation_config: { chunk_length_schedule: [50, 120, 160, 290] }
    }];
  }

  utteranceMessages(text) {
    // The trailing space is what ElevenLabs uses to know a word ended. `flush`
    // rather than the empty-string terminator on purpose: the empty string ends
    // the context and closes the socket, and we want it warm for the next turn.
    return [{ text: `${text} ` }, { flush: true }];
  }

  decode(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return undefined;
    }
    if (message.audio) {
      const raw = Buffer.from(message.audio, 'base64');
      const sourceRate = elevenLabsSourceRate(this.config.tts.elevenlabs.outputFormat);
      return sourceRate ? pcmToMulaw8k(raw, sourceRate) : raw;
    }
    if (message.error) {
      this.logger.error({ message: message.error, code: message.code }, 'TTS error');
      return null;
    }
    if (message.isFinal) return null;
    return undefined;
  }
}

export const TTS_PROVIDERS = { sarvam: SarvamTTS, elevenlabs: ElevenLabsTTS };

/** Whichever vendor TTS_PROVIDER names. Validated at boot, so this cannot miss. */
export function createTTS(config, logger) {
  const Provider = TTS_PROVIDERS[config.tts.provider];
  if (!Provider) throw new Error(`Unknown TTS provider "${config.tts.provider}"`);
  return new Provider(config, logger);
}
