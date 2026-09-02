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

      // Set only by a successful verify_code. Section 3.7 hangs off this.
      invite: null,
      candidate: null,
      job: null,
      criteria: [],

      // Section 10 asserts on both of these at the end of every completed call.
      aiDisclosureGiven: false,
      recordingConsent: null,      // null | 'granted' | 'declined'
      recordingStarted: false,

      timeConsent: null,           // null | 'now' | 'later' | 'withdrew'
      criteriaCovered: [],
      criteriaNotCovered: [],
      escalation: null,
      outcome: null,
      codeAttempts: 0,
      dtmfBuffer: '',
      questionsAsked: 0,
      transcript: null,
      ended: false
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

  /** Terminal. The first outcome recorded wins - a later error must not
   *  overwrite a call that already completed properly. */
  finish(id, outcome) {
    const session = this.sessions.get(id);
    if (!session || session.ended) return;
    session.ended = true;
    session.outcome = outcome ?? TERMINAL.ABANDONED;
    session.endedAt = new Date();
    session.state = STATES.CLOSE;
  }
}
