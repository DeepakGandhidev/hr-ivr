import { VoiceActivityDetector } from '../audio/vad.js';
import { SarvamSTT } from '../audio/stt.js';
import { createTTS } from '../audio/tts.js';
import { STATES, TERMINAL, isVerified } from './states.js';
import { DISCLOSURE } from './screening.js';
import { toSpeech, splitSentences } from '../utils/speech.js';
import { truncateToHeard } from './history.js';

// A candidate who has said nothing at all for this long has hung up on a line
// that never signalled the drop, or walked away. Ending beats holding a socket
// and a Sarvam session open forever.
const IDLE_HANGUP_MS = 45_000;

/**
 * One inbound call, start to finish.
 *
 * This is the piece Twilio's ConversationRelay used to be. It owns the real-time
 * loop: caller audio in, barge-in detection, transcription, the model turn,
 * synthesis, and playback back out - plus the bookkeeping that says which of
 * those words the candidate actually heard.
 */
export class CallSession {
  constructor({ plivo, session, agent, api, config, logger, analyst, stt, tts }) {
    this.plivo = plivo;
    this.session = session;
    this.agent = agent;
    this.api = api;
    this.config = config;
    this.logger = logger;
    this.analyst = analyst;

    this.vad = new VoiceActivityDetector(config.vad);
    // Injectable so the conversation can be driven without the speech vendors.
    this.stt = stt ?? new SarvamSTT(config, logger);
    this.tts = tts ?? createTTS(config, logger);

    this.speaking = false;
    this.abort = null;
    this.turnLock = Promise.resolve();
    this.pendingUtterance = null;
    this.disclosureCheckpoint = null;
    this.lastVoiceAt = Date.now();
    this.finalised = false;
  }

  async begin(start) {
    const { session } = this;
    session.callUUID = start.callUUID ?? session.callUUID;
    session.streamId = start.streamId;

    session.transcript?.record('call.start', {
      callUUID: session.callUUID, callerNumber: session.callerNumber
    });

    // Open the ScreeningCall row before a word is spoken, so a call that fails
    // mid-way still leaves a record rather than vanishing.
    try {
      const created = await this.api.startCall({
        caller_number: session.callerNumber,
        telephony_call_id: session.callUUID ?? session.id,
        started_at: session.startedAt.toISOString(),
        provider: 'plivo'
      });
      session.osCallId = created?.id ?? null;
    } catch (err) {
      this.logger.error({ err: err.message }, 'Could not open call record');
    }

    this.stt.on('final', (text) => this.#onFinal(text));
    this.stt.on('partial', (text) => {
      this.lastVoiceAt = Date.now();
      session.transcript?.record('caller.interim', { text });
    });
    this.stt.on('error', (err, fatal) => {
      session.transcript?.record('model.error', { source: 'stt', error: err.message, fatal });
      if (fatal) this.#fail('speech recognition failed');
    });
    this.stt.connect();

    this.plivo.on('audio', (frame) => this.#onAudio(frame));
    this.plivo.on('dtmf', (digit) => this.#onDtmf(digit));
    this.plivo.on('played', (segment) => this.#onPlayed(segment));
    this.plivo.on('stop', () => this.finalise(TERMINAL.ABANDONED));
    this.plivo.on('close', () => this.finalise(TERMINAL.ABANDONED));

    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastVoiceAt > IDLE_HANGUP_MS) this.finalise(TERMINAL.ABANDONED);
    }, 5000);

    // 3.2 / 8.1 - the disclosure is a fixed string spoken before the model has
    // any say in the call. It is the first thing out of Pratibha's mouth on
    // every call because nothing is capable of generating a different opening.
    session.setState(STATES.VERIFY_CODE);
    await this.#say(DISCLOSURE, { isDisclosure: true });
    session.history.push({ role: 'assistant', content: DISCLOSURE });
  }

  #onAudio(frame) {
    this.stt.push(frame);

    const event = this.vad.push(frame);
    if (event === 'speech-start') {
      this.lastVoiceAt = Date.now();
      // 8.3 - the candidate talked over Pratibha. Stop immediately; a system
      // that keeps talking over a person reads as broken within one exchange.
      if (this.speaking) this.#bargeIn();
    } else if (event === 'speech-end') {
      this.lastVoiceAt = Date.now();
    }
  }

  #bargeIn() {
    const { session } = this;
    this.abort?.abort();
    this.tts.reset();
    const { heard, dropped } = this.plivo.clear();
    this.speaking = false;

    session.transcript?.record('interrupt', { heard, dropped });

    // Rewrite what we claim to have said down to what was actually played.
    const result = truncateToHeard(session.history, { heard, dropped });
    if (result.changed) {
      this.logger.info({ sessionId: session.id, kept: result.kept }, 'Interrupted, history truncated to what was heard');
    }
  }

  #onPlayed(segment) {
    if (this.disclosureCheckpoint && segment?.id === this.disclosureCheckpoint) {
      // 10 - the flag means the candidate actually heard it, not that we meant
      // to say it. Plivo confirming playback is the only evidence of that.
      this.session.aiDisclosureGiven = true;
      this.session.transcript?.record('disclosure', { confirmed: true });
      this.disclosureCheckpoint = null;
    }
  }

  #onDtmf(digit) {
    const { session } = this;
    session.transcript?.record('dtmf', { digit });

    // Reading a six-character code down a noisy mobile line is the single most
    // error-prone moment of the call, so the keypad is offered as a way round
    // it. Letters cannot be keyed, so this only helps once codes are numeric -
    // flagged to the product owner as an open item.
    if (digit === '#' || session.dtmfBuffer.length >= 6) {
      const code = session.dtmfBuffer;
      session.dtmfBuffer = '';
      if (code) this.#onFinal(`My reference code is ${code.split('').join(' ')}.`);
      return;
    }
    session.dtmfBuffer += digit;
  }

  #onFinal(text) {
    const utterance = String(text ?? '').trim();
    if (!utterance) return;

    this.lastVoiceAt = Date.now();
    this.session.transcript?.record('caller', { text: utterance, state: this.session.state });

    // Serialise turns. A candidate who says two things in quick succession must
    // not start two model turns against the same state - the second would be
    // resolved against a state the first is still moving.
    this.turnLock = this.turnLock.then(() => this.#turn(utterance)).catch((err) => {
      this.logger.error({ err }, 'Turn failed');
    });
  }

  async #turn(utterance) {
    const { session } = this;
    if (session.ended) return;

    // Anything still queued belongs to a question they have now answered past.
    if (this.speaking) this.#bargeIn();

    session.history.push({ role: 'user', content: utterance });

    try {
      await this.agent.runTurn(session, (text) => this.#say(text));
    } catch (err) {
      session.transcript?.record('model.error', { source: 'anthropic', error: err.message, status: err.status });
      this.logger.error({ sessionId: session.id, err }, 'Model turn failed');
      await this.#fail('the assistant could not continue');
      return;
    }

    if (session.ended) {
      // Let the closing line finish playing before the socket goes away, or the
      // candidate hears Pratibha cut off mid-goodbye.
      await this.#drainThenHangUp();
    }
  }

  /**
   * Speak one reply. Synthesis and playback are per sentence: the first sentence
   * reaches the caller while the rest is still being generated, and each one
   * carries its own checkpoint so a barge-in resolves to a sentence rather than
   * to the whole paragraph.
   *
   * Returns the text that went to the caller, so history records what was said
   * rather than the markdown the model wrote.
   */
  async #say(text, { isDisclosure = false } = {}) {
    const spoken = toSpeech(text);
    if (!spoken) return '';

    const sentences = splitSentences(spoken);
    if (!sentences.length) return '';

    this.abort = new AbortController();
    this.speaking = true;
    this.vad.reset();

    const started = Date.now();
    let first = true;

    try {
      for (const sentence of sentences) {
        // Only a barge-in stops a reply mid-flight. It must NOT stop on
        // session.ended: every terminal path - wrong code, call back later,
        // escalation, the normal close - ends the session inside the tool and
        // then still owes the candidate the closing line. Gating on `ended`
        // here hung up on them mid-goodbye.
        if (this.abort.signal.aborted) break;

        const chunks = [];
        for await (const chunk of this.tts.stream(sentence, this.abort.signal)) chunks.push(chunk);
        if (this.abort.signal.aborted || !chunks.length) break;

        const checkpoint = this.plivo.play(Buffer.concat(chunks), sentence);
        if (isDisclosure) this.disclosureCheckpoint = checkpoint;

        if (first) {
          this.session.transcript?.record('tts.first_audio', { latencyMs: Date.now() - started });
          first = false;
        }
      }
    } catch (err) {
      this.logger.error({ err: err.message }, 'Synthesis failed');
      this.session.transcript?.record('model.error', { source: 'tts', error: err.message });
      this.speaking = false;
      return '';
    }

    this.speaking = false;
    this.session.transcript?.record('pratibha', { text: spoken });
    return spoken;
  }

  async #drainThenHangUp() {
    const deadline = Date.now() + 20_000;
    while (this.plivo.queuedMs > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
    }
    await this.finalise(this.session.outcome);
  }

  async #fail(reason) {
    const { session } = this;
    session.transcript?.record('technical_failure', { reason });
    await this.#say("I'm sorry, I'm having trouble on my end. Please call back using the same code, and I'll flag this for the team.").catch(() => {});
    await this.api.escalate({
      category: 'technical_failure',
      reason,
      screening_call_id: session.osCallId,
      caller_number: session.callerNumber,
      raised_at: new Date().toISOString()
    }).catch(() => {});
    session.finish(TERMINAL.TECHNICAL_FAILURE);
    await this.#drainThenHangUp();
  }

  /** Runs exactly once, however the call ended. */
  async finalise(outcome) {
    if (this.finalised) return;
    this.finalised = true;

    const { session } = this;
    clearInterval(this.idleTimer);
    this.abort?.abort();
    session.finish(outcome ?? TERMINAL.ABANDONED);

    this.stt.close();
    this.tts.close();

    const entries = session.transcript?.end(session) ?? [];

    if (session.osCallId) {
      await this.api.updateCall(session.osCallId, {
        ended_at: new Date().toISOString(),
        duration_seconds: Math.round((Date.now() - session.startedAt.getTime()) / 1000),
        outcome: session.outcome,
        ai_disclosure_given: session.aiDisclosureGiven,
        recording_consent: session.recordingConsent,
        application_id: session.invite?.application_id ?? null,
        invite_id: session.invite?.id ?? null
      }).catch(err => this.logger.error({ err: err.message }, 'Final call patch failed'));

      await this.api.saveTranscript(session.osCallId, entries)
        .catch(err => this.logger.error({ err: err.message }, 'Transcript save failed'));
    }

    // 8.7 - scoring happens after the call, not during it. Off the critical
    // path there is no latency budget to respect, so it gets a stronger model
    // and the whole transcript at once instead of a turn at a time.
    if (isVerified(session) && session.questionsAsked > 0) {
      this.analyst.analyse(session).catch(err =>
        this.logger.error({ err: err.message, sessionId: session.id }, 'Post-call analysis failed'));
    }

    this.plivo.close();
    this.logger.info({
      sessionId: session.id,
      outcome: session.outcome,
      disclosure: session.aiDisclosureGiven,
      recording: session.recordingConsent,
      questions: session.questionsAsked
    }, 'Call finalised');
  }
}
