// The call's state machine. Several of the parent spec's non-negotiables are
// enforced here rather than in the system prompt, because a prompt is a request
// and a transition table is a guarantee. A model that decides to start screening
// an unverified caller simply has no tool to do it with.
//
// Spec references are to the Pratibha document.

export const STATES = {
  GREET: 'GREET',                          // fixed disclosure, no model involvement
  VERIFY_CODE: 'VERIFY_CODE',              // 3.7  reference codes gate the line
  CONSENT_TIME: 'CONSENT_TIME',            // 8.2  is now a good time
  CONSENT_RECORDING: 'CONSENT_RECORDING',  // 3.3  explicit consent before recording
  SCREEN: 'SCREEN',                        // 8.3  rubric-driven questions
  CANDIDATE_QA: 'CANDIDATE_QA',            // 8.4  their questions
  CLOSE: 'CLOSE'                           // 8.5
};

// Reached once, never left. Each maps to a ScreeningCall.outcome in section 5.
export const TERMINAL = {
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
  DECLINED_CONSENT: 'declined_consent',
  WRONG_CODE: 'wrong_code',
  CALL_BACK_LATER: 'call_back_later',
  ESCALATED: 'escalated',
  TECHNICAL_FAILURE: 'technical_failure'
};

// Which tools exist in which state. A tool absent from this map is not offered
// to the model, so it cannot be called out of order.
export const TOOLS_BY_STATE = {
  [STATES.GREET]: ['verify_code'],
  [STATES.VERIFY_CODE]: ['verify_code', 'end_call'],
  [STATES.CONSENT_TIME]: ['record_time_consent', 'escalate'],
  [STATES.CONSENT_RECORDING]: ['record_recording_consent', 'escalate'],
  [STATES.SCREEN]: ['finish_screening', 'escalate'],
  [STATES.CANDIDATE_QA]: ['end_call', 'escalate'],
  [STATES.CLOSE]: []
};

// Legal transitions. Anything not listed cannot happen, which is what keeps
// an unverified caller out of SCREEN (3.7) and stops recording starting before
// consent has been asked for (3.3).
const TRANSITIONS = {
  [STATES.GREET]: [STATES.VERIFY_CODE],
  [STATES.VERIFY_CODE]: [STATES.CONSENT_TIME, STATES.CLOSE],
  [STATES.CONSENT_TIME]: [STATES.CONSENT_RECORDING, STATES.CLOSE],
  [STATES.CONSENT_RECORDING]: [STATES.SCREEN, STATES.CLOSE],
  [STATES.SCREEN]: [STATES.CANDIDATE_QA, STATES.CLOSE],
  [STATES.CANDIDATE_QA]: [STATES.CLOSE],
  [STATES.CLOSE]: []
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

/**
 * 3.7 - screening requires a verified, unexpired invite. Checked as a property
 * of the session rather than trusted from the conversation, so no amount of
 * persuasion on the call can substitute for a code.
 */
export function isVerified(session) {
  return Boolean(session.invite?.reference_code && session.invite?.status === 'active');
}
