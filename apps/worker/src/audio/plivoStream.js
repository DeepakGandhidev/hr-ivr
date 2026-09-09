import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';

// Plivo caps a WebSocket message at 64 KB and recommends keeping the base64
// payload at or under 16 KB. base64 inflates by 4/3, so 4000 raw mu-law bytes
// (500 ms of audio) encodes to about 5.3 KB - comfortably inside both, and
// small enough that the first chunk of a reply reaches the caller quickly.
const CHUNK_BYTES = 4000;

/**
 * The Plivo side of a call: raw mu-law frames in, playAudio out, and the
 * checkpoint bookkeeping that tells us how much of what we said was actually
 * heard.
 *
 * Twilio's ConversationRelay handed us that last fact for free, as
 * `utteranceUntilInterrupt` on the interrupt event. Plivo has no equivalent, so
 * we reconstruct it: every segment of speech is followed by a checkpoint, and
 * Plivo echoes a playedStream back once playback passes it. Everything acked
 * was heard; everything queued behind the barge-in was not. Without this the
 * conversation history claims Pratibha asked a question the candidate never
 * heard, and she never asks it again.
 *
 * Events: 'start' 'audio' 'dtmf' 'stop' 'played' 'cleared' 'close' 'error'
 */
export class PlivoStream extends EventEmitter {
  constructor(ws, logger) {
    super();
    this.ws = ws;
    this.logger = logger;
    this.streamId = null;
    this.callId = null;
    this.callUUID = null;

    // Segments queued to Plivo but not yet confirmed played.
    this.pending = [];
    // Text confirmed to have reached the caller's ear, in order.
    this.played = [];

    ws.on('message', (data) => this.#onMessage(data));
    ws.on('close', () => this.emit('close'));
    ws.on('error', (err) => this.emit('error', err));
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      // A media frame that will not parse is one lost 20 ms. Dropping it is
      // correct; tearing the call down over it is not.
      this.logger.warn('Unparseable Plivo frame, dropped');
      return;
    }

    switch (message.event) {
      case 'start':
        this.streamId = message.start?.streamId ?? message.streamId;
        this.callId = message.start?.callId;
        this.callUUID = message.start?.callUUID;
        this.emit('start', {
          streamId: this.streamId,
          callId: this.callId,
          callUUID: this.callUUID,
          mediaFormat: message.start?.mediaFormat
        });
        break;

      case 'media':
        if (message.media?.payload) {
          this.emit('audio', Buffer.from(message.media.payload, 'base64'));
        }
        break;

      case 'dtmf':
        this.emit('dtmf', message.dtmf?.digit);
        break;

      case 'playedStream':
        this.#onPlayed(message.playedStream?.checkpointId);
        break;

      case 'clearedAudio':
        this.emit('cleared');
        break;

      case 'stop':
        this.emit('stop');
        break;

      default:
        this.logger.debug({ event: message.event }, 'Unhandled Plivo event');
    }
  }

  #onPlayed(checkpointId) {
    if (!checkpointId) return;
    const index = this.pending.findIndex(s => s.id === checkpointId);
    if (index === -1) return;

    // Playback is ordered, so an ack for one segment implicitly acks every
    // segment queued before it.
    const done = this.pending.splice(0, index + 1);
    for (const segment of done) this.played.push(segment.text);
    this.emit('played', done[done.length - 1]);
  }

  #send(payload) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  /** One playAudio frame. Both playback paths go through here so they cannot drift. */
  #sendAudio(audio) {
    return this.#send({
      event: 'playAudio',
      media: {
        contentType: 'audio/x-mulaw',
        sampleRate: 8000,
        payload: audio.toString('base64')
      }
    });
  }

  /** Forget a segment that never made it to the caller. */
  #drop(segment) {
    const index = this.pending.indexOf(segment);
    if (index !== -1) this.pending.splice(index, 1);
  }

  /**
   * Queue one segment of speech and mark its end with a checkpoint.
   * `text` is what this audio says, so a later ack can report what was heard.
   */
  play(audio, text = '') {
    if (!audio?.length) return null;

    for (let offset = 0; offset < audio.length; offset += CHUNK_BYTES) {
      if (!this.#sendAudio(audio.subarray(offset, offset + CHUNK_BYTES))) return null;
    }

    const id = uuidv4();
    this.pending.push({ id, text, durationMs: Math.round(audio.length / 8) });
    this.#send({ event: 'checkpoint', checkpoint: { id } });
    return id;
  }

  /**
   * The same segment, but fed from synthesis as it arrives instead of from a
   * finished buffer.
   *
   * `play` cannot be called until the whole sentence has been synthesised, so
   * the vendor's synthesis time sits in front of the first byte the caller
   * hears - dead air on every turn, growing with the length of the sentence.
   * This sends each frame the moment it is full, so playback overlaps
   * synthesis and only the first frame waits on the vendor.
   *
   * The segment joins `pending` up front rather than at the checkpoint. A
   * barge-in landing mid-synthesis has to be able to report this text as
   * dropped; queued only at the end it would be neither heard nor dropped, and
   * the history would claim Pratibha said something the caller never got.
   *
   * Returns the checkpoint id, or null when nothing reached the caller.
   */
  async playStream(chunks, { text = '', signal, onFirstAudio } = {}) {
    const segment = { id: uuidv4(), text, durationMs: 0 };
    this.pending.push(segment);

    let carry = Buffer.alloc(0);
    let queued = 0;
    let open = true;

    // `all` releases a partial frame too: true for the first chunk, so the
    // caller hears something without waiting for a full 500 ms to accumulate,
    // and true again at the end to flush the tail.
    const emit = (all) => {
      while (open && (carry.length >= CHUNK_BYTES || (all && carry.length))) {
        const take = Math.min(CHUNK_BYTES, carry.length);
        open = this.#sendAudio(carry.subarray(0, take));
        if (!open) break;
        carry = carry.subarray(take);
        queued += take;
        // Kept current rather than set at the end, so `queuedMs` is honest
        // about audio already in flight while the sentence is still arriving.
        segment.durationMs = Math.round(queued / 8);
      }
    };

    try {
      for await (const chunk of chunks) {
        if (signal?.aborted || !open) break;
        carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const first = queued === 0;
        emit(first);
        if (first && queued > 0) onFirstAudio?.();
      }
      if (!signal?.aborted) emit(true);
    } catch (err) {
      this.#drop(segment);
      throw err;
    }

    // A barge-in during synthesis has already cleared the queue, so this
    // segment is no longer ours to checkpoint.
    if (!queued || signal?.aborted || !this.pending.includes(segment)) {
      this.#drop(segment);
      return null;
    }

    this.#send({ event: 'checkpoint', checkpoint: { id: segment.id } });
    return segment.id;
  }

  /**
   * Barge-in. Drops everything Plivo has queued and returns the text that had
   * already been heard, so the caller's view of the conversation and ours agree.
   */
  clear() {
    const heard = this.played.join(' ').trim();
    const dropped = this.pending.map(s => s.text).join(' ').trim();
    this.pending = [];
    this.#send({ event: 'clearAudio', streamId: this.streamId });
    return { heard, dropped };
  }

  /** Everything spoken so far, and forget it - one call to end a turn. */
  takeSpoken() {
    const heard = this.played.join(' ').trim();
    const inFlight = this.pending.map(s => s.text).join(' ').trim();
    this.played = [];
    return [heard, inFlight].filter(Boolean).join(' ').trim();
  }

  get queuedMs() {
    return this.pending.reduce((total, s) => total + s.durationMs, 0);
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}
