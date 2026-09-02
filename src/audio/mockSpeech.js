import { EventEmitter } from 'events';

/**
 * Stand-ins for Sarvam, so the whole call loop - state machine, tools, model
 * turns, barge-in bookkeeping - can be exercised without telephony or speech
 * vendors. Selected by MOCK_MODE.
 *
 * These are for developing the conversation. They are not a substitute for
 * evaluating recognition quality, which section 4.1 is explicit has to be done
 * on real recorded calls: no mock will tell you whether the model copes with a
 * candidate switching into Hindi halfway through an answer.
 */
export class MockSTT extends EventEmitter {
  constructor(script = []) {
    super();
    this.script = [...script];
    this.frames = 0;
  }

  connect() { setImmediate(() => this.emit('ready')); }

  push() { this.frames++; }

  /** Deliver the next scripted answer as if the candidate had just said it. */
  say(text) {
    const utterance = text ?? this.script.shift();
    if (utterance === undefined) return false;
    this.emit('final', utterance);
    return true;
  }

  get exhausted() { return this.script.length === 0; }

  close() {}
}

export class MockTTS {
  constructor() {
    this.spoken = [];
  }

  // 8 bytes per millisecond of mu-law at 8 kHz. Roughly 60ms of audio per
  // character keeps the simulated durations in the right order of magnitude.
  async *stream(text) {
    this.spoken.push(text);
    yield Buffer.alloc(Math.max(160, text.length * 480), 0xff);
  }

  reset() {}
  close() {}
}
