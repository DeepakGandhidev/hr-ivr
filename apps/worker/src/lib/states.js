// The call's state machine. Several of the parent spec's non-negotiables are
// enforced here rather than in the system prompt, because a prompt is a request
// and a transition table is a guarantee. A model that decides to start screening
// an unrecognised caller simply has no tool to do it with.

export const STATES = {
  GREET: 'GREET',                          // fixed AI disclosure, no model involvement
  IDENTIFY: 'IDENTIFY',                    // phone did not match; ask for email
  VERIFY_EMAIL: 'VERIFY_EMAIL',            // phone matched; confirm it is really them
  LANGUAGE_SELECT: 'LANGUAGE_SELECT',      // choose English / Hindi / Hinglish
  CONSENT_TIME: 'CONSENT_TIME',            // is now a good time?
  CONSENT_RECORDING: 'CONSENT_RECORDING',  // explicit recording consent
  SCREEN: 'SCREEN',                        // rubric-driven questions
  CANDIDATE_QA: 'CANDIDATE_QA',            // their questions
  CLOSE: 'CLOSE'                           // terminal wrap-up
};

// Reached once, never left.
export const TERMINAL = {
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
  DECLINED_CONSENT: 'declined_consent',
  WRONG_CODE: 'wrong_code',
  CALL_BACK_LATER: 'call_back_later',
  ESCALATED: 'escalated',
  TECHNICAL_FAILURE: 'technical_failure',
  UNKNOWN_CALLER: 'unknown_caller',
  ALREADY_INTERVIEWED: 'already_interviewed',
  OUT_OF_WINDOW: 'out_of_window'
};

// Which tools exist in which state. A tool absent from this map is not offered
// to the model, so it cannot be called out of order.
export const TOOLS_BY_STATE = {
  [STATES.GREET]: [],
  [STATES.IDENTIFY]: ['provide_email', 'end_call'],
  [STATES.VERIFY_EMAIL]: ['confirm_email', 'end_call'],
  [STATES.LANGUAGE_SELECT]: ['select_language', 'end_call'],
  [STATES.CONSENT_TIME]: ['record_time_consent', 'escalate'],
  [STATES.CONSENT_RECORDING]: ['record_recording_consent', 'escalate'],
  [STATES.SCREEN]: ['finish_screening', 'escalate'],
  [STATES.CANDIDATE_QA]: ['end_call', 'escalate'],
  [STATES.CLOSE]: []
};

// Legal transitions. Anything not listed cannot happen.
const TRANSITIONS = {
  [STATES.GREET]: [STATES.IDENTIFY, STATES.VERIFY_EMAIL, STATES.LANGUAGE_SELECT, STATES.CONSENT_TIME, STATES.CLOSE],
  [STATES.IDENTIFY]: [STATES.LANGUAGE_SELECT, STATES.CLOSE],
  [STATES.VERIFY_EMAIL]: [STATES.LANGUAGE_SELECT, STATES.CLOSE],
  [STATES.LANGUAGE_SELECT]: [STATES.CONSENT_TIME, STATES.CLOSE],
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
 * A caller may be interviewed once we know who they are.
 *
 * Applying to the role is the qualification. Identity is established by the
 * email address on their application, which they say aloud on the call — the
 * phone number only suggests who is calling, it does not prove it.
 *
 * Recruiter approval is deliberately NOT required here: gating interviews on a
 * screen-then-shortlist-then-approve chain meant a candidate who applied on
 * Monday could not be interviewed until somebody clicked through three screens,
 * and every one of those clicks was a place the call could silently fail.
 * `requireApproval` restores the stricter behaviour for anyone who wants it.
 */
export function isVerified(session, { requireApproval = false } = {}) {
  return Boolean(
    session.candidate?.id &&
    (!requireApproval || session.approved) &&
    !session.alreadyInterviewed &&
    session.language
  );
}
