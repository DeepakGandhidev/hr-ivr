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
    // Sentences arrive from the model faster than they can be spoken, so they
    // queue here and play in the order they were written.
    this.speechChain = Promise.resolve();
    this.speechInFlight = 0;
    // Set the moment the candidate stops talking, so the one latency that
    // matters - their last word to her first sound - can be measured.
    this.turnStartedAt = null;
    this.turnAudioReported = false;
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

    // Both of the turn-aways below used to return before any call record was
    // written, so an out-of-window or repeat caller left no trace at all - the
    // portal could not show that the call had even happened, and the
    // out_of_window status in the schema was never once produced. The candidate
    // is known here, so the record is safe to attribute.
    if (lookup?.candidate && lookup.hasCompleted) {
      this.#attachLookup(session, lookup);
      session.recognised = true;
      await this.#ensureInterviewCall(session);
      session.setState(STATES.CLOSE);
      session.finish(TERMINAL.ALREADY_INTERVIEWED);
      await this.#say("We already have a completed interview on file for this role. Thank you for calling, and the team will be in touch by email if needed.");
      return;
    }

    if (lookup && !isWithinCallWindow(lookup.callWindows)) {
      if (lookup.candidate) {
        this.#attachLookup(session, lookup);
        session.recognised = true;
        await this.#ensureInterviewCall(session);
      }
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
      // Also while she is only thinking. The model turn is cancellable now, and
      // a candidate who starts answering during the pause should not have to
      // wait out a reply to a question they have already moved past.
      if (this.speaking || this.turnRunning) this.#bargeIn();
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
    this.turnStartedAt = Date.now();
    this.turnAudioReported = false;
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

    // One scope for the whole turn - the model call and every sentence it
    // produces - so a barge-in cancels all of it with a single abort.
    const abort = new AbortController();
    this.abort = abort;

    try {
      await this.agent.runTurn(session, (text) => this.#say(text), { signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted || isAbortError(err)) {
        // The candidate talked over her. Not a failure: what they said is
        // already queued, and the next turn answers it.
        session.transcript?.record('turn.interrupted', { state: session.state });
        return;
      }
      session.transcript?.record('model.error', { source: 'anthropic', error: err.message, status: err.status });
      this.logger.error({ sessionId: session.id, err }, 'Model turn failed');
      await this.#fail('the assistant could not continue');
      return;
    }

    if (session.ended) {
      await this.#drainThenHangUp();
    }
  }

  /**
   * Speak one piece of a reply, and resolve with what actually reached the
   * caller.
   *
   * Calls queue: a sentence handed over while an earlier one is still playing
   * waits its turn, so the caller hears them in the order the model wrote
   * them. That queue is what lets the model turn stream - it hands each
   * finished sentence over and goes straight back to reading tokens instead of
   * waiting out the playback.
   */
  #say(text, { isDisclosure = false } = {}) {
    const spoken = toSpeech(text);
    if (!spoken) return Promise.resolve('');

    const sentences = splitSentences(spoken);
    if (!sentences.length) return Promise.resolve('');

    // Outside a turn - the opening disclosure, the apology after a failure -
    // there is no scope to join, so this piece gets one of its own.
    if (!this.abort || this.abort.signal.aborted) this.abort = new AbortController();
    const signal = this.abort.signal;

    // Only on the transition into speech. Resetting per sentence would wipe a
    // barge-in that was still accumulating across the boundary, and with the
    // model streaming those boundaries now land mid-reply.
    if (this.speechInFlight === 0) this.vad.reset();
    this.speechInFlight++;
    this.speaking = true;

    const run = this.speechChain.then(() => this.#play(sentences, signal, isDisclosure));

    // The chain has to survive a failed piece, or one bad sentence silently
    // drops every sentence queued behind it.
    this.speechChain = run.then(() => {}, () => {});

    return run
      .catch((err) => {
        this.logger.error({ err: err.message }, 'Synthesis failed');
        this.session.transcript?.record('model.error', { source: 'tts', error: err.message });
        return '';
      })
      .finally(() => {
        if (--this.speechInFlight === 0) this.speaking = false;
      });
  }

  /** Synthesise and play sentences in order. Returns the ones that got out. */
  async #play(sentences, signal, isDisclosure) {
    const started = Date.now();
    const said = [];

    for (const sentence of sentences) {
      if (signal.aborted) break;

      const checkpoint = await this.plivo.playStream(this.tts.stream(sentence, signal), {
        text: sentence,
        signal,
        onFirstAudio: () => this.#onFirstAudio(started)
      });
      if (signal.aborted || !checkpoint) break;

      if (isDisclosure) this.disclosureCheckpoint = checkpoint;
      said.push(sentence);
    }

    const spoken = said.join(' ');
    if (spoken) this.session.transcript?.record('pratibha', { text: spoken });
    return spoken;
  }

  #onFirstAudio(startedAt) {
    this.session.transcript?.record('tts.first_audio', { latencyMs: Date.now() - startedAt });

    // The number the candidate actually experiences: their last word to her
    // first sound, across endpointing, the model and synthesis together.
    // Nothing measured this end to end before.
    if (this.turnStartedAt && !this.turnAudioReported) {
      this.turnAudioReported = true;
      this.session.transcript?.record('turn.first_audio', { latencyMs: Date.now() - this.turnStartedAt });
    }
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

/**
 * An aborted request, however the SDK or the runtime chose to spell it. A
 * barge-in cancels the model call, and that must not be reported to the
 * candidate as a technical failure.
 */
export function isAbortError(err) {
  const name = err?.name ?? '';
  return name === 'AbortError' || name === 'APIUserAbortError' || err?.code === 'ABORT_ERR';
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
  if (session.outcome === TERMINAL.UNKNOWN_CALLER) return 'unknown_caller';
  if (session.outcome === TERMINAL.OUT_OF_WINDOW) return 'out_of_window';
  if (session.outcome === TERMINAL.DECLINED_CONSENT) return 'declined_consent';
  if (session.outcome === TERMINAL.ALREADY_INTERVIEWED) return 'completed';

  // A caller who hangs up on the goodbye has still been interviewed.
  //
  // `finish()` defaults the outcome to ABANDONED whenever it is reached without
  // one, which is what a caller-side hangup does - so a completed ten-question
  // interview and a drop at question two arrived here indistinguishable, and
  // both were recorded as `dropped`: unbilled, and shown to the recruiter as a
  // failed call. Production did this to every interview but one.
  //
  // `screeningFinished` is the discriminator, because finish_screening is the
  // only way into CANDIDATE_QA. State cannot serve here: finish() sets CLOSE on
  // every ending, so it is CLOSE for the drop at question two as well.
  if (session.outcome === TERMINAL.ABANDONED && session.screeningFinished && session.questionsAsked > 0) {
    return 'completed';
  }

  return 'dropped';
}
