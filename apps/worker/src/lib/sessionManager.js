import { STATES, TERMINAL, canTransition } from './states.js';

export class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  create(id, meta = {}) {
    const session = {
      id,
      state: STATES.GREET,
      history: [],

      callerNumber: meta.callerNumber ?? null,
      callUUID: meta.callUUID ?? null,
      startedAt: new Date(),

      // Set by caller recognition.
      candidate: null,
      job: null,
      tenant: null,
      latestApprovedJd: null,
      interviewProtocol: null,
      approved: false,
      alreadyInterviewed: false,
      recognised: false,

      // Interview flow.
      interviewCallId: null,
      language: null,              // 'en' | 'hi' | 'hinglish'

      // Section 10 asserts on both of these at the end of every completed call.
      aiDisclosureGiven: false,
      recordingConsent: null,      // null | 'granted' | 'declined'
      recordingStarted: false,

      timeConsent: null,           // null | 'now' | 'later' | 'withdrew'
      criteriaCovered: [],
      criteriaNotCovered: [],
      // Set only by finish_screening, which is the sole way into CANDIDATE_QA.
      // This is the evidence that the questions were actually covered, and it
      // is deliberately not inferred from `state`: finish() sets CLOSE on every
      // ending, including a drop at question two.
      screeningFinished: false,
      escalation: null,
      outcome: null,
      codeAttempts: 0,
      dtmfBuffer: '',
      questionsAsked: 0,
      transcript: null,
      ended: false,

      // Cost tracking (populated at finalisation).
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostUsd: 0,
      ttsCostUsd: 0,
      sttCostUsd: 0,
      telephonyCost: 0,
    };

    for (const method of ['setState', 'setInvite', 'finish']) {
      session[method] = (...args) => this[method](id, ...args);
    }

    this.sessions.set(id, session);
    return session;
  }

  get(id) { return this.sessions.get(id); }
  delete(id) { this.sessions.delete(id); }

  /** Refuses transitions the table in states.js does not allow. */
  setState(id, next) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.state === next) return true;
    if (!canTransition(session.state, next)) return false;
    session.state = next;
    session.stateChangedAt = new Date();
    return true;
  }

  setInvite(id, { invite, candidate, job, criteria }) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.invite = invite;
    session.candidate = candidate;
    session.job = job;
    session.criteria = criteria ?? [];
  }

  /** Terminal. The first outcome recorded wins. */
  finish(id, outcome) {
    const session = this.sessions.get(id);
    if (!session || session.ended) return;
    session.ended = true;
    session.outcome = outcome ?? TERMINAL.ABANDONED;
    session.endedAt = new Date();
    session.state = STATES.CLOSE;
  }
}
