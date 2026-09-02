import { STATES, TERMINAL, TOOLS_BY_STATE, isVerified } from './states.js';

// 8.6 - two failed codes and the call ends. More attempts would turn the line
// into something worth guessing at.
const MAX_CODE_ATTEMPTS = 2;

// 8.6 - said word for word. See the note in #escalate.
const ESCALATION_LINES = {
  asked_for_human:
    "Of course, that's no problem at all. I'll pass that on to the team and someone will be in touch with you by email. Thanks very much for your time today.",
  hostile_or_distressed:
    "I think it's best we leave it there for today. I'll pass this on to the team and someone will be in touch by email. Thank you for your time.",
  line_quality:
    "I'm sorry, the line isn't clear enough for me to do this properly. Please call back on a better connection using the same reference code. Thanks for your patience.",
  identity_mismatch:
    "I'm sorry, I'm not able to continue with this call. I'll pass it on to the team and they'll follow up by email. Thank you.",
  other:
    "I'm sorry, I'm not able to continue with this call. I'll pass it on to the team and someone will be in touch by email. Thank you for your time."
};

/** Spoken aloud, so "the sixth of September" rather than an ISO timestamp. */
function formatExpiry(value) {
  if (!value) return 'the date in your invitation email';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'the date in your invitation email';
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata'
  }).format(date);
}

export const TOOL_DEFINITIONS = {
  verify_code: {
    name: 'verify_code',
    description: 'Check the reference code the caller read out from their invitation email. Pass it exactly as they said it; the lookup normalises spacing and case. Call this as soon as you have a code, before anything else.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Six characters, letters and digits, e.g. "H7K294"' }
      },
      required: ['code']
    }
  },
  record_time_consent: {
    name: 'record_time_consent',
    description: 'Record whether the candidate can talk right now. Call with proceed=false if they are busy or want to call back, or with withdrawn=true if they are no longer interested in the role.',
    input_schema: {
      type: 'object',
      properties: {
        proceed: { type: 'boolean', description: 'True if now is a good time' },
        withdrawn: { type: 'boolean', description: 'True only if they say they are no longer interested' },
        reason: { type: 'string' }
      },
      required: ['proceed']
    }
  },
  record_recording_consent: {
    name: 'record_recording_consent',
    description: 'Record the candidate\'s answer on recording the call. Declining is completely fine and the conversation continues either way - never end the call over it.',
    input_schema: {
      type: 'object',
      properties: {
        granted: { type: 'boolean' }
      },
      required: ['granted']
    }
  },
  finish_screening: {
    name: 'finish_screening',
    description: 'Call when you have covered the screening criteria and are ready to invite the candidate\'s own questions. List which criteria you actually reached and which you did not, with the reason.',
    input_schema: {
      type: 'object',
      properties: {
        criteria_covered: {
          type: 'array',
          description: 'Ids of criteria you asked about',
          items: { type: 'integer' }
        },
        criteria_not_covered: {
          type: 'array',
          description: 'Criteria you could not reach, each with why',
          items: {
            type: 'object',
            properties: {
              criterion_id: { type: 'integer' },
              reason: { type: 'string' }
            },
            required: ['criterion_id', 'reason']
          }
        }
      },
      required: ['criteria_covered']
    }
  },
  escalate: {
    name: 'escalate',
    description: 'Flag this call for a human on the team and end it politely. Use when the candidate asks to speak to a person, becomes hostile or distressed, or the line is too poor to continue. A human will follow up by email - you must never promise a call back.',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['asked_for_human', 'hostile_or_distressed', 'line_quality', 'identity_mismatch', 'other']
        },
        reason: { type: 'string' }
      },
      required: ['category', 'reason']
    }
  },
  end_call: {
    name: 'end_call',
    description: 'End the call once you have closed it off. Use outcome "completed" after a normal screening, or "wrong_code" when the caller could not give a valid code.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'wrong_code', 'call_back_later'] }
      },
      required: ['outcome']
    }
  }
};

export class ToolExecutor {
  constructor(config, logger, api) {
    this.config = config;
    this.logger = logger;
    this.api = api;
  }

  definitionsFor(state) {
    return (TOOLS_BY_STATE[state] ?? []).map(name => TOOL_DEFINITIONS[name]).filter(Boolean);
  }

  async execute(name, input, session) {
    // The model is only ever offered tools valid for the current state, but a
    // second check here means a prompt-injected or hallucinated call cannot slip
    // through either.
    if (!(TOOLS_BY_STATE[session.state] ?? []).includes(name)) {
      return { error: `${name} is not available right now.` };
    }

    switch (name) {
      case 'verify_code': return this.#verifyCode(input, session);
      case 'record_time_consent': return this.#timeConsent(input, session);
      case 'record_recording_consent': return this.#recordingConsent(input, session);
      case 'finish_screening': return this.#finishScreening(input, session);
      case 'escalate': return this.#escalate(input, session);
      case 'end_call': return this.#endCall(input, session);
      default: return { error: 'unknown tool' };
    }
  }

  async #verifyCode({ code }, session) {
    session.codeAttempts++;
    const result = await this.api.lookupInvite(code);

    if (!result?.valid) {
      const attemptsLeft = MAX_CODE_ATTEMPTS - session.codeAttempts;

      // 5 - CallLogUnmatched. Someone will always call without a code, and the
      // log is what tells you whether the invite email is unclear.
      await this.api.logUnmatched({
        caller_number: session.callerNumber,
        received_at: new Date().toISOString(),
        reason: result?.reason ?? 'invalid_code',
        transcript_snippet: `caller offered code: ${code}`
      }).catch(err => this.logger.warn({ err: err.message }, 'unmatched log failed'));

      if (result?.reason === 'expired_code') {
        // 8.1 - an expired invite is a real candidate who was too slow, not a
        // wrong number. Gaurav decides whether to reopen it.
        await this.api.escalate({
          category: 'expired_code',
          reason: `Candidate called with expired code ${code}`,
          caller_number: session.callerNumber
        }).catch(() => {});
        session.finish(TERMINAL.WRONG_CODE);
        return { valid: false, reason: 'expired', instruction: 'Tell them the invitation has expired but you will flag it for the team to look at, then end the call politely.' };
      }

      if (attemptsLeft <= 0) {
        session.finish(TERMINAL.WRONG_CODE);
        return { valid: false, reason: 'invalid', attempts_exhausted: true, instruction: 'Tell them you cannot verify that code and to check their invitation email and call back, then end the call.' };
      }

      return {
        valid: false,
        reason: result?.reason ?? 'invalid_code',
        attempts_left: attemptsLeft,
        instruction: 'Ask them once to read the code again, slowly. Mention they can also key it in on their keypad.'
      };
    }

    session.setInvite(result);
    session.setState(STATES.CONSENT_TIME);

    return {
      valid: true,
      candidate_name: result.candidate.first_name,
      job_title: result.job.title,
      instruction: 'Confirm their name and the role, say the call takes ten to fifteen minutes, and ask whether now is a good time.'
    };
  }

  async #timeConsent({ proceed, withdrawn, reason }, session) {
    if (withdrawn) {
      session.timeConsent = 'withdrew';
      session.finish(TERMINAL.DECLINED_CONSENT);
      await this.#patch(session, { status_note: 'candidate withdrew on call' });
      return { instruction: 'Thank them for letting you know and end the call warmly.' };
    }

    if (!proceed) {
      session.timeConsent = 'later';
      session.finish(TERMINAL.CALL_BACK_LATER);
      // 3.1 - nothing is scheduled and nobody dials them. They call back. The
      // hours and the expiry date have to be right, so the line is built here
      // from the invite rather than recalled by the model.
      return {
        say_exactly:
          `No problem at all. You can call this same number back any time ${this.config.operatingHours.label}, ` +
          `using the same reference code. It's valid until ${formatExpiry(session.invite?.expires_at)}. ` +
          `Thanks for your time, and we'll speak soon.`,
        ended: true,
        reason
      };
    }

    session.timeConsent = 'now';
    session.setState(STATES.CONSENT_RECORDING);
    return { instruction: 'Now ask for permission to record the call so the team can review their answers properly.' };
  }

  async #recordingConsent({ granted }, session) {
    session.recordingConsent = granted ? 'granted' : 'declined';
    session.recordingStarted = Boolean(granted);
    session.setState(STATES.SCREEN);

    await this.#patch(session, { recording_consent: session.recordingConsent });

    // 10 - declining does not end the call. It costs the recording, nothing else.
    return granted
      ? { recording: true, instruction: 'Thank them and begin the screening questions.' }
      : { recording: false, instruction: 'Tell them that is absolutely fine, you will not record and will take notes instead, then begin the screening questions.' };
  }

  async #finishScreening({ criteria_covered = [], criteria_not_covered = [] }, session) {
    session.criteriaCovered = criteria_covered;
    session.criteriaNotCovered = criteria_not_covered;
    session.setState(STATES.CANDIDATE_QA);
    // 8.4 - their turn. Bounded by the protocols, which are already in context.
    return { instruction: 'Tell them that is everything from your side and ask whether they have any questions about the role or the company.' };
  }

  async #escalate({ category, reason }, session) {
    await this.api.escalate({
      category,
      reason,
      screening_call_id: session.osCallId,
      candidate_id: session.candidate?.id,
      caller_number: session.callerNumber,
      raised_at: new Date().toISOString()
    }).catch(err => this.logger.error({ err: err.message }, 'escalation notify failed'));

    session.escalation = { category, reason };
    session.finish(TERMINAL.ESCALATED);

    // Said verbatim rather than paraphrased. Asked to put this in its own words,
    // the model produced "let me get someone from the team to help you" - which
    // sounds like a transfer or a call back, and neither can happen: 3.1 means
    // nothing in this system dials anyone. A candidate who believes a person is
    // coming holds the line, then feels misled. The follow-up is email, always,
    // so the sentence that says so is not left to chance.
    return {
      say_exactly: ESCALATION_LINES[category] ?? ESCALATION_LINES.other,
      ended: true
    };
  }

  async #endCall({ outcome }, session) {
    if (outcome === 'completed' && !isVerified(session)) {
      // Belt and braces on 3.7: a call that never verified cannot be filed as a
      // completed screening.
      session.finish(TERMINAL.WRONG_CODE);
      return { ended: true };
    }
    session.finish(outcome ?? TERMINAL.COMPLETED);
    return { ended: true };
  }

  async #patch(session, body) {
    if (!session.osCallId) return;
    await this.api.updateCall(session.osCallId, body)
      .catch(err => this.logger.warn({ err: err.message }, 'call patch failed'));
  }
}
