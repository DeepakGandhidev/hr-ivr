import { VoiceActivityDetector } from '../audio/vad.js';
import { SarvamSTT } from '../audio/stt.js';
import { createTTS } from '../audio/tts.js';
import { STATES, TERMINAL, isVerified } from './states.js';
import { makeDisclosure } from './screening.js';
import { toSpeech, splitSentences } from '../utils/speech.js';
import { truncateToHeard } from './history.js';
import {
  lookupCandidateByPhone,
  recordInterviewCall,
  updateInterviewCall,
  incrementInterviewUsage,
} from '../db/index.js';

/**
 * How far past its budget an interview may run before it is ended for it.
 *
 * Generous on purpose: cutting someone off mid-sentence to save ninety seconds
 * is a worse outcome than a slightly long call, and the prompt has already been
 * asking it to wrap up for a while by this point.
 */
const OVERRUN_GRACE_MS = 2 * 60 * 1000;

const IDLE_HANGUP_MS = 45_000;

/**
 * One inbound call, start to finish.
 *
 * This owns the real-time loop: caller audio in, barge-in detection,
 * transcription, the model turn, synthesis, and playback back out - plus the
 * bookkeeping that says which of those words the candidate actually heard.
 */
export class CallSession {
  constructor({ plivo, session, agent, config, logger, analyst, stt, tts }) {
    this.plivo = plivo;
    this.session = session;
    this.agent = agent;
    this.config = config;
    this.logger = logger;
    this.analyst = analyst;

    this.vad = new VoiceActivityDetector(config.vad);
    this.stt = stt ?? new SarvamSTT(config, logger);
    this.tts = tts ?? createTTS(config, logger);

    this.speaking = false;
    this.abort = null;
    this.turnRunning = false;
    this.currentTurn = null;
    // Everything the caller says while a turn is in flight is collected here
    // and answered together, rather than each utterance queueing a turn of
    // its own.
    this.pending = [];
    this.disclosureCheckpoint = null;
    this.lastVoiceAt = Date.now();
    this.finalised = false;
    this.wrappingUp = false;
  }

  async begin(start) {
    const { session } = this;
    session.callUUID = start.callUUID ?? session.callUUID;
    session.streamId = start.streamId;

    session.transcript?.record('call.start', {
      callUUID: session.callUUID, callerNumber: session.callerNumber
    });

    // Caller recognition replaces the old reference-code gate.
    const lookup = await this.#recogniseCaller(session.callerNumber);

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
      // A time budget the model is merely asked to respect is not a budget. The
      // prompt nudges it to wrap up as the deadline nears; this ends the call if
      // it talks past that anyway, so an interview cannot run indefinitely.
      const deadline = session.deadlineAt;
      if (deadline && !session.ended && Date.now() > deadline + OVERRUN_GRACE_MS) {
        this.#forceWrapUp();
        return;
      }
      if (Date.now() - this.lastVoiceAt > IDLE_HANGUP_MS) this.finalise(TERMINAL.ABANDONED);
    }, 5000);

    if (lookup?.candidate && lookup.hasCompleted) {
      session.setState(STATES.CLOSE);
      session.finish(TERMINAL.ALREADY_INTERVIEWED);
      await this.#say("We already have a completed interview on file for this role. Thank you for calling, and the team will be in touch by email if needed.");
      return;
    }

    if (lookup && !isWithinCallWindow(lookup.callWindows)) {
      session.setState(STATES.CLOSE);
      session.finish(TERMINAL.OUT_OF_WINDOW);
      await this.#say("Thanks for calling. Our interview lines are currently closed. Please call back during the scheduled call window.");
      return;
    }

    // Knowing who called is what matters, not whether a recruiter has approved
    // them: applying to the role is the qualification. Routing on `approved`
    // sent every ordinary applicant down the unrecognised path.
    if (lookup?.candidate) {
      this.#attachLookup(session, lookup);
      session.recognised = true;
      await this.#ensureInterviewCall(session);
      // Caller ID identifies the phone, not the person. VERIFY_EMAIL confirms
      // the address on their application before any interview question is
      // asked; set VERIFY_CALLER_EMAIL=false to trust the number alone.
      session.setState(
        this.config.verifyCallerEmail === false ? STATES.LANGUAGE_SELECT : STATES.VERIFY_EMAIL
      );
    } else {
      session.setState(STATES.IDENTIFY);
    }

    // The disclosure is a fixed string (or personalised when we know the caller)
    // spoken before the model has any say in the call.
    // Withhold the name while the caller is still unverified: greeting them by
    // name would give away the very thing the next question asks them to prove.
    const disclosure = makeDisclosure(session, {
      personalise: session.state !== STATES.VERIFY_EMAIL
    });
    await this.#say(disclosure, { isDisclosure: true });
    session.history.push({ role: 'assistant', content: disclosure });

    // Kick off the first model turn so it asks the right opening question
    // (language choice, or email if the caller was not recognised).
    if (!session.ended) {
      this.#pump(true);
    }
  }

  async #recogniseCaller(phoneE164) {
    try {
      return await lookupCandidateByPhone(phoneE164);
    } catch (err) {
      this.logger.error({ err: err.message, phoneE164 }, 'Caller recognition failed');
      return null;
    }
  }

  #attachLookup(session, lookup) {
    session.candidate = lookup.candidate;
    session.job = lookup.job;
    session.tenant = lookup.tenant;
    session.latestApprovedJd = lookup.latestApprovedJd;
    session.interviewProtocol = lookup.interviewProtocol;
    session.approved = lookup.approved;
    session.alreadyInterviewed = lookup.hasCompleted;
    session.criteria = deriveCriteria(lookup.job);
  }

  async #ensureInterviewCall(session) {
    if (session.interviewCallId) return;
    try {
      const call = await recordInterviewCall({
        candidateId: session.candidate.id,
        callerNumber: session.callerNumber,
        recognised: true,
        status: 'unknown_caller',
      });
      session.interviewCallId = call.id;
    } catch (err) {
      this.logger.error({ err: err.message }, 'Could not open call record');
    }
  }

  #onAudio(frame) {
    this.stt.push(frame);

    const event = this.vad.push(frame);
    if (event === 'speech-start') {
      this.lastVoiceAt = Date.now();
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

    const result = truncateToHeard(session.history, { heard, dropped });
    if (result.changed) {
      this.logger.info({ sessionId: session.id, kept: result.kept }, 'Interrupted, history truncated to what was heard');
    }
  }

  #onPlayed(segment) {
    if (this.disclosureCheckpoint && segment?.id === this.disclosureCheckpoint) {
      this.session.aiDisclosureGiven = true;
      this.session.transcript?.record('disclosure', { confirmed: true });
      this.disclosureCheckpoint = null;
    }
  }

  #onDtmf(digit) {
    const { session } = this;
    session.transcript?.record('dtmf', { digit });

    // DTMF is less useful now that reference codes are gone, but we still accept
    // '#' as a submit key if we ever use keypad input for language selection.
    if (digit === '#') {
      const code = session.dtmfBuffer;
      session.dtmfBuffer = '';
      if (code) this.#onFinal(code);
      return;
    }
    session.dtmfBuffer += digit;
  }

  #onFinal(text) {
    const utterance = String(text ?? '').trim();
    if (!utterance) return;

    this.lastVoiceAt = Date.now();
    this.session.transcript?.record('caller', { text: utterance, state: this.session.state });

    this.pending.push(utterance);
    this.#pump();
  }

  /**
   * Run one turn at a time, answering everything said since the last one.
   *
   * Chaining a turn per final transcript meant a caller who said three things
   * while the model was thinking got three separate replies, one after another
   * — the call went quiet, then talked over itself. Collecting the utterances
   * and answering once keeps the exchange a conversation.
   */
  /**
   * Resolves once no turn is running and nothing is waiting to be answered.
   *
   * Callers previously awaited the internal turn-chain promise directly, which
   * meant any change to how turns are sequenced silently broke them.
   */
  async whenIdle() {
    while (this.turnRunning || (this.pending.length && !this.session.ended)) {
      await this.currentTurn?.catch(() => {});
      // Yield so a .finally() that starts the follow-up turn can run before the
      // loop re-checks, otherwise this returns while a queued turn is pending.
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  #pump(initial = false) {
    if (this.turnRunning) return;

    // Once the call is over nothing will ever answer what is still buffered, so
    // it is discarded rather than left queued. Holding on to it kept the
    // session looking permanently busy — anything waiting for the call to go
    // quiet would wait forever.
    if (this.session.ended) {
      this.pending = [];
      return;
    }

    const utterance = this.pending.length ? this.pending.join(' ').trim() : null;
    this.pending = [];
    if (!initial && !utterance) return;

    this.turnRunning = true;
    this.currentTurn = Promise.resolve(this.#turn(utterance))
      .catch((err) => this.logger.error({ err }, 'Turn failed'))
      .finally(() => {
        this.turnRunning = false;
        // Anything said during that turn is answered now.
        if (this.pending.length) this.#pump();
      });
  }

  async #turn(utterance) {
    const { session } = this;
    if (session.ended) return;

    if (this.speaking) this.#bargeIn();

    if (utterance) {
      session.history.push({ role: 'user', content: utterance });
    }

    try {
      await this.agent.runTurn(session, (text) => this.#say(text));
    } catch (err) {
      session.transcript?.record('model.error', { source: 'anthropic', error: err.message, status: err.status });
      this.logger.error({ sessionId: session.id, err }, 'Model turn failed');
      await this.#fail('the assistant could not continue');
      return;
    }

    if (session.ended) {
      await this.#drainThenHangUp();
    }
  }

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

  /**
   * End an interview that has run past its budget.
   *
   * The candidate still gets a proper closing line — from their side the call
   * has to end like a conversation, not like a dropped connection.
   */
  async #forceWrapUp() {
    const { session } = this;
    if (session.ended || this.wrappingUp) return;
    this.wrappingUp = true;

    session.transcript?.record('interview.time_limit', {
      questionsAsked: session.questionsAsked,
      overrunMs: Date.now() - session.deadlineAt,
    });
    this.logger.info({ sessionId: session.id, questions: session.questionsAsked }, 'Interview hit its time limit');

    this.#bargeIn();
    session.setState(STATES.CLOSE);
    session.finish(TERMINAL.COMPLETED);

    await this.#say(
      "That's all the time we have for the interview. Thank you for talking me through your experience — the team will review this and get back to you by email."
    );
    await this.#drainThenHangUp();
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
    await this.#say("I'm sorry, I'm having trouble on my end. Please call back, and I'll flag this for the team.").catch(() => {});
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

    session.transcript?.end(session);

    // 2.8 defines the billable unit as a completed call with a recognised,
    // shortlisted candidate THAT PRODUCES AN ASSESSMENT REPORT. That is the
    // same condition that decides whether the analyst runs at all, so the two
    // are derived once here and cannot drift apart — billing a call the tenant
    // never got a report for is the failure mode this guards.
    const producesReport = isVerified(session, { requireApproval: this.config?.requireShortlistApproval }) && session.questionsAsked > 0;

    if (session.interviewCallId) {
      const llmCostUsd = estimateLlmCostUsd(session.llmInputTokens, session.llmOutputTokens);
      const status = deriveCallStatus(session);

      await updateInterviewCall(session.interviewCallId, {
        endedAt: new Date(),
        language: session.language ?? null,
        status,
        telephonyCost: 0,
        llmCostUsd,
        ttsCostUsd: session.ttsCostUsd ?? 0,
        sttCostUsd: session.sttCostUsd ?? 0,
      }).catch(err => this.logger.error({ err: err.message }, 'Final call patch failed'));

      // Explicitly NOT billed (2.8, 5 Stage 8): unknown callers, out-of-window
      // call-backs, consent declines, mid-call drops, and a repeat call by
      // someone already interviewed. Each of those either never reaches the
      // questions or never yields a report, so `producesReport` covers them
      // all; `status` is checked too so a completed-but-reportless call cannot
      // slip through.
      const billable = isBillableInterview({
        status,
        recognised: session.recognised,
        producesReport,
        tenantId: session.tenant?.id,
      });

      if (billable) {
        await incrementInterviewUsage(session.tenant.id).catch(err =>
          this.logger.error({ err: err.message }, 'Interview usage increment failed'));
      } else {
        this.logger.info({
          sessionId: session.id,
          status,
          recognised: session.recognised,
          questionsAsked: session.questionsAsked,
        }, 'Call not billed');
      }
    }

    if (producesReport) {
      this.analyst.analyse(session).catch(err =>
        this.logger.error({ err: err.message, sessionId: session.id }, 'Post-call analysis failed'));
    }

    this.plivo.close();
    this.logger.info({
      sessionId: session.id,
      outcome: session.outcome,
      disclosure: session.aiDisclosureGiven,
      recording: session.recordingConsent,
      questions: session.questionsAsked,
      interviewCallId: session.interviewCallId
    }, 'Call finalised');
  }
}

export function deriveCriteria(job) {
  const mustHaves = Array.isArray(job?.mustHaves) ? job.mustHaves : [];
  const goodToHaves = Array.isArray(job?.goodToHaves) ? job.goodToHaves : [];
  return [
    ...mustHaves.map((text, i) => ({
      id: i + 1,
      criterion: text,
      weight: 5,
      evaluation_guidance: 'Must-have for this role.'
    })),
    ...goodToHaves.map((text, i) => ({
      id: mustHaves.length + i + 1,
      criterion: text,
      weight: 3,
      evaluation_guidance: 'Nice-to-have for this role.'
    }))
  ];
}

export function isWithinCallWindow(callWindows, now = new Date()) {
  if (!callWindows || callWindows.length === 0) return true;
  return callWindows.some((window) => {
    const tz = window.timezone ?? 'Asia/Kolkata';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hour = Number(parts.find(p => p.type === 'hour')?.value);
    const minute = Number(parts.find(p => p.type === 'minute')?.value);
    const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);

    const days = Array.isArray(window.days) ? window.days : [];
    if (!days.includes(dayIndex)) return false;

    const [startH, startM] = window.startTime.split(':').map(Number);
    const [endH, endM] = window.endTime.split(':').map(Number);
    const current = hour * 60 + minute;
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;

    // Equal start and end means the whole day is open. Without this there is no
    // way to express 24/7: the closest a user could get was 00:00-23:59, which
    // silently refused every call in the final minute of the day.
    if (start === end) return true;

    // An end before the start crosses midnight (a night shift, 18:00-09:00).
    // Comparing them as a single range made these windows match nothing at all,
    // so the line appeared dead for the whole shift it was meant to cover.
    if (end < start) return current >= start || current < end;

    return current >= start && current < end;
  });
}

function estimateLlmCostUsd(inputTokens, outputTokens) {
  return Number(((inputTokens || 0) * 0.00000025 + (outputTokens || 0) * 0.00000125).toFixed(6));
}

/**
 * 2.8: a billable "AI interview" is a completed inbound call with a recognised,
 * shortlisted candidate that produces an assessment report. Everything else —
 * unknown caller, out of window, consent declined, mid-call drop, and a repeat
 * call by someone already interviewed — is explicitly not billed.
 *
 * `producesReport` must be the same value used to decide whether the post-call
 * analyst runs, so a tenant is never charged for a call that yielded no report.
 */
export function isBillableInterview({ status, recognised, producesReport, tenantId }) {
  return Boolean(producesReport) && status === 'completed' && Boolean(recognised) && Boolean(tenantId);
}

export function deriveCallStatus(session) {
  if (session.outcome === TERMINAL.COMPLETED) return 'completed';
  if (session.outcome === TERMINAL.ABANDONED) return 'dropped';
  if (session.outcome === TERMINAL.UNKNOWN_CALLER) return 'unknown_caller';
  if (session.outcome === TERMINAL.OUT_OF_WINDOW) return 'out_of_window';
  if (session.outcome === TERMINAL.DECLINED_CONSENT) return 'declined_consent';
  if (session.outcome === TERMINAL.ALREADY_INTERVIEWED) return 'completed';
  return 'dropped';
}
