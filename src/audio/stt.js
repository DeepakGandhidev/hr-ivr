import { EventEmitter } from 'events';
import { WebSocket } from 'ws';

// Sarvam's realtime model accepts mu-law at 8 kHz, which is exactly what Plivo
// sends. The caller's audio therefore crosses this service untouched - no
// decode, no resample, no re-encode - which is both the cheapest path and the
// one that loses the least on a line already narrowed to 8 kHz.
//
// Sarvam also does the endpointing. Deciding when a candidate has finished an
// answer needs the words, not the waveform: "I worked at Infosys for..." and
// "I worked at Infosys." are the same silence to an energy detector and
// obviously different to a model that heard them. The local VAD only handles
// barge-in, where speed beats accuracy.
const ENDPOINT = 'wss://api.sarvam.ai/speech-to-text-realtime/ws';

// A dropped socket must not cost us the candidate's answer. Indian mobile calls
// drop sockets routinely; buffering two seconds covers a reconnect without
// letting a long outage grow unbounded in memory.
const RECONNECT_BUFFER_MS = 2000;
const RECONNECT_BUFFER_BYTES = (RECONNECT_BUFFER_MS * 8000) / 1000;

export class SarvamSTT extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.attempts = 0;
  }

  #url() {
    const { language, mode, streamType, silenceDurationMs, minSpeechDurationMs, threshold } = this.config.stt;
    const params = new URLSearchParams({
      model: this.config.stt.model,
      language_code: language,
      mode,
      stream_type: streamType,
      encoding: 'mulaw',
      sample_rate: '8000',
      endpointing: 'vad',
      threshold: String(threshold),
      silence_duration_ms: String(silenceDurationMs),
      min_speech_duration_ms: String(minSpeechDurationMs)
    });
    return `${this.config.stt.endpoint || ENDPOINT}?${params}`;
  }

  connect() {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.#url(), {
        headers: { 'API-SUBSCRIPTION-KEY': this.config.stt.apiKey }
      });
    } catch (err) {
      // The WebSocket constructor throws synchronously on a malformed URL or
      // header. This runs from a reconnect timer as well as from setup, and an
      // uncaught throw there takes the process down mid-call for every other
      // candidate on the line - so it becomes an event like any other failure.
      this.logger.error({ err: err.message }, 'STT connect failed');
      this.emit('error', err, true);
      return;
    }

    this.ws.on('open', () => {
      this.attempts = 0;
      this.ready = true;
      this.#drain();
      this.emit('ready');
    });

    this.ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (message.event) {
        case 'session.begin':
          // Sarvam echoes the config it actually applied. Worth logging: a
          // silently-defaulted encoding is the difference between a transcript
          // and eight minutes of noise.
          this.logger.info({ config: message.config }, 'STT session begin');
          break;
        case 'transcript.partial':
          if (message.text) this.emit('partial', message.text, message.utterance_idx);
          break;
        case 'transcript.final':
          if (message.text?.trim()) this.emit('final', message.text.trim(), message.utterance_idx);
          break;
        case 'error':
          this.logger.error({ code: message.code, message: message.message, fatal: message.is_fatal }, 'STT error');
          this.emit('error', new Error(message.message || 'stt error'), message.is_fatal);
          break;
      }
    });

    this.ws.on('close', () => {
      this.ready = false;
      if (this.closed) return;
      // Backoff, capped: a call lasts minutes, so a reconnect that has not
      // succeeded in a few seconds is not going to.
      const delay = Math.min(250 * 2 ** this.attempts++, 4000);
      this.logger.warn({ attempt: this.attempts, delay }, 'STT socket closed, reconnecting');
      setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      this.logger.error({ err: err.message }, 'STT socket error');
    });
  }

  #drain() {
    for (const chunk of this.buffer) this.#write(chunk);
    this.buffer = [];
    this.bufferedBytes = 0;
  }

  #write(base64) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'audio_input', audio: base64 }));
  }

  /** Feed one mu-law frame straight from Plivo. */
  push(frame) {
    const base64 = frame.toString('base64');
    if (this.ready) {
      this.#write(base64);
      return;
    }
    this.buffer.push(base64);
    this.bufferedBytes += frame.length;
    while (this.bufferedBytes > RECONNECT_BUFFER_BYTES && this.buffer.length) {
      // Drop the oldest audio, not the newest: on reconnect the recent words
      // are the ones still worth transcribing.
      const dropped = this.buffer.shift();
      this.bufferedBytes -= Buffer.byteLength(dropped, 'base64');
    }
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
