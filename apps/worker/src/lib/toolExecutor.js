import { STATES, TERMINAL, TOOLS_BY_STATE, isVerified } from './states.js';
import { lookupCandidateByEmail, recordInterviewCall, updateInterviewCall } from '../db/index.js';
import { emailsMatch } from './emailMatch.js';

function deriveCriteria(job) {
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

function attachCandidate(session, lookup) {
  session.candidate = lookup.candidate;
  session.job = lookup.job;
  session.tenant = lookup.tenant;
  session.latestApprovedJd = lookup.latestApprovedJd;
  session.interviewProtocol = lookup.interviewProtocol;
  session.approved = lookup.approved;
  session.alreadyInterviewed = lookup.hasCompleted;
  session.criteria = deriveCriteria(lookup.job);
}

const ESCALATION_LINES = {
  asked_for_human:
    "Of course, that's no problem at all. I'll pass that on to the team and someone will be in touch with you by email. Thanks very much for your time today.",
  hostile_or_distressed:
    "I think it's best we leave it there for today. I'll pass this on to the team and someone will be in touch by email. Thank you for your time.",
  line_quality:
    "I'm sorry, the line isn't clear enough for me to do this properly. Please call back on a better connection. Thanks for your patience.",
  identity_mismatch:
    "I'm sorry, I'm not able to continue with this call. I'll pass it on to the team and they'll follow up by email. Thank you.",
  other:
    "I'm sorry, I'm not able to continue with this call. I'll pass it on to the team and someone will be in touch by email. Thank you for your time."
};

export const TOOL_DEFINITIONS = {
  provide_email: {
    name: 'provide_email',
    description: 'The caller has given their email address to identify themselves. Look it up against the applications on file and continue if it matches.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address exactly as the caller said it' }
      },
      required: ['email']
    }
  },
  confirm_email: {
    name: 'confirm_email',
    description: 'The caller was recognised by phone number. Check the email address they just said against the one on their application before the interview begins.',
    input_schema: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email address exactly as the caller said it, including any "at the rate" or "dot"' }
      },
      required: ['email']
    }
  },
  select_language: {
    name: 'select_language',
    description: 'Record the language the caller wants for the interview: English, Hindi, or Hinglish.',
    input_schema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['en', 'hi', 'hinglish'] }
      },
      required: ['language']
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
    description: 'End the call once you have closed it off. Use outcome "completed" after a normal screening.',
    input_schema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['completed', 'call_back_later'] }
      },
      required: ['outcome']
    }
  }
};

export class ToolExecutor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  definitionsFor(state) {
    return (TOOLS_BY_STATE[state] ?? []).map(name => TOOL_DEFINITIONS[name]).filter(Boolean);
  }

  async execute(name, input, session) {
    if (!(TOOLS_BY_STATE[session.state] ?? []).includes(name)) {
      return { error: `${name} is not available right now.` };
    }

    switch (name) {
      case 'provide_email': return this.#provideEmail(input, session);
      case 'confirm_email': return this.#confirmEmail(input, session);
      case 'select_language': return this.#selectLanguage(input, session);
      case 'record_time_consent': return this.#timeConsent(input, session);
      case 'record_recording_consent': return this.#recordingConsent(input, session);
      case 'finish_screening': return this.#finishScreening(input, session);
      case 'escalate': return this.#escalate(input, session);
      case 'end_call': return this.#endCall(input, session);
      default: return { error: 'unknown tool' };
    }
  }

  /**
   * Identity check for a caller already recognised by phone number.
   *
   * Caller ID alone is weak: numbers get reassigned, phones get shared, and
   * spoofing an inbound CLI is not hard. Confirming the address on their
   * application before any interview question is asked closes that gap.
   *
   * Two attempts, because the recogniser mangles spoken addresses far more
   * often than a real candidate forgets their own email. After that the call
   * ends rather than interviewing someone unverified — and it is logged, since
   * a repeated failure is exactly what an impostor looks like.
   */
  async #confirmEmail({ email }, session) {
    const onFile = session.candidate?.email;

    // Nothing to check against. Refusing here would punish the candidate for a
    // gap in our own data, so the interview proceeds and the gap is recorded.
    if (!onFile) {
      session.emailVerified = false;
      session.setState(STATES.LANGUAGE_SELECT);
      return {
        verified: null,
        instruction: 'Thank them and ask whether they would like to continue in English, Hindi, or Hinglish.'
      };
    }

    if (emailsMatch(email, onFile)) {
      session.emailVerified = true;
      session.transcript?.record('identity.verified', { heard: email });
      session.setState(STATES.LANGUAGE_SELECT);
      // The name is released here and not before: this is the first moment the
      // caller has proved they are the person it belongs to.
      return {
        verified: true,
        candidate_name: session.candidate?.name ?? null,
        instruction: 'Thank them by first name now that they are confirmed, then ask whether they would like to continue in English, Hindi, or Hinglish. Do not greet them again or re-introduce yourself.'
      };
    }

    // The address does not belong to the candidate this phone is registered to.
    // Before treating that as a failure, check whether it belongs to a
    // different approved candidate: a number identifies a handset, not a
    // person. Borrowed phones, shared family numbers and reassigned SIMs are
    // ordinary, and someone who can produce an approved candidate's own email
    // is exactly as identified as one calling in from an unknown number — the
    // IDENTIFY path already admits them on that basis alone.
    const other = await lookupCandidateByEmail(email);

    if (other?.candidate && other.candidate.id !== session.candidate?.id && other.approved) {
      if (other.hasCompleted) {
        session.finish(TERMINAL.ALREADY_INTERVIEWED);
        return {
          verified: true,
          already_interviewed: true,
          instruction: 'Say you already have a completed interview on file for this role, thank them, and end the call warmly.'
        };
      }

      session.transcript?.record('identity.reassigned', {
        heard: email,
        from_candidate: session.candidate?.id ?? null,
        to_candidate: other.candidate.id
      });

      attachCandidate(session, other);
      session.recognised = true;
      session.emailVerified = true;
      await this.#ensureInterviewCall(session);
      session.setState(STATES.LANGUAGE_SELECT);

      return {
        verified: true,
        candidate_name: other.candidate.name ?? null,
        job_title: other.job?.title ?? null,
        instruction: 'This is a different candidate to the one the number is registered to, which is fine. Greet them by first name, confirm the role you have them down for, then ask whether they would like to continue in English, Hindi, or Hinglish. Do not re-introduce yourself.'
      };
    }

    session.emailAttempts = (session.emailAttempts ?? 0) + 1;
    session.transcript?.record('identity.mismatch', { heard: email, attempt: session.emailAttempts });

    if (session.emailAttempts >= 2) {
      session.emailVerified = false;
      session.finish(TERMINAL.UNKNOWN_CALLER);
      return {
        verified: false,
        attempts_exhausted: true,
        instruction: 'Say you were not able to confirm their details, that the team will follow up by email, thank them warmly, and end the call. Do not say what the correct address is.'
      };
    }

    return {
      verified: false,
      attempts_remaining: 1,
      instruction: 'Say the line may have broken up, and ask them to say just the part of their email address before the "at" sign, slowly. Never suggest they gave the wrong address, never reveal the address on file, and never read any part of it back to them.'
    };
  }

  async #provideEmail({ email }, session) {
    const lookup = await lookupCandidateByEmail(email);

    if (!lookup?.candidate) {
      session.finish(TERMINAL.UNKNOWN_CALLER);
      return {
        recognised: false,
        instruction: 'Politely say you cannot find an application under that email address, ask them to check it and apply again if needed, thank them, and end the call.'
      };
    }

    attachCandidate(session, lookup);
    session.emailVerified = true;
    session.transcript?.record('identity.verified', { heard: email, via: 'email' });

    if (this.config?.requireShortlistApproval && !lookup.approved) {
      session.finish(TERMINAL.UNKNOWN_CALLER);
      return {
        recognised: true,
        approved: false,
        instruction: 'Say you found the email but the candidate is not currently on the approved shortlist. Thank them and end the call.'
      };
    }

    if (lookup.hasCompleted) {
      session.finish(TERMINAL.ALREADY_INTERVIEWED);
      return {
        recognised: true,
        approved: true,
        already_interviewed: true,
        instruction: 'Say you already have a completed interview on file for this role, thank them, and end the call warmly.'
      };
    }

    await this.#ensureInterviewCall(session);
    session.setState(STATES.LANGUAGE_SELECT);
    return {
      recognised: true,
      candidate_name: lookup.candidate.name,
      job_title: lookup.job.title,
      instruction: 'Confirm their name and the role, then ask whether they would like to continue in English, Hindi, or Hinglish.'
    };
  }

  async #selectLanguage({ language }, session) {
    session.language = language;
    session.setState(STATES.CONSENT_TIME);
    await this.#patch(session, { language });
    return {
      language,
      instruction: 'Confirm the language choice, say the call takes ten to fifteen minutes, and ask whether now is a good time.'
    };
  }

  async #timeConsent({ proceed, withdrawn, reason }, session) {
    if (withdrawn) {
      session.timeConsent = 'withdrew';
      session.finish(TERMINAL.DECLINED_CONSENT);
      await this.#patch(session, { status: 'declined_consent' });
      return { instruction: 'Thank them for letting us know and end the call warmly.' };
    }

    if (!proceed) {
      session.timeConsent = 'later';
      session.finish(TERMINAL.CALL_BACK_LATER);
      return {
        say_exactly:
          `No problem at all. You can call this same number back any time ${this.config.operatingHours.label}, India time. ` +
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
    // The clock starts when questioning does, not when the phone was answered:
    // greeting, identity and consent should not eat into the interview.
    const minutes = Number(session.interviewProtocol?.durationMinutes) || 10;
    session.deadlineAt = Date.now() + minutes * 60_000;
    session.transcript?.record('interview.started', { durationMinutes: minutes });

    session.setState(STATES.SCREEN);

    await this.#patch(session, { recordingConsent: session.recordingConsent });

    return granted
      ? { recording: true, instruction: 'Thank them and begin the screening questions.' }
      : { recording: false, instruction: 'Tell them that is absolutely fine, you will not record and will take notes instead, then begin the screening questions.' };
  }

  async #finishScreening({ criteria_covered = [], criteria_not_covered = [] }, session) {
    session.criteriaCovered = criteria_covered;
    session.criteriaNotCovered = criteria_not_covered;
    session.screeningFinished = true;
    session.setState(STATES.CANDIDATE_QA);
    return { instruction: 'Tell them that is everything from your side and ask whether they have any questions about the role or the company.' };
  }

  async #escalate({ category, reason }, session) {
    this.logger.warn({ sessionId: session.id, category, reason }, 'Call escalated');
    session.escalation = { category, reason };
    session.finish(TERMINAL.ESCALATED);
    return {
      say_exactly: ESCALATION_LINES[category] ?? ESCALATION_LINES.other,
      ended: true
    };
  }

  async #endCall({ outcome }, session) {
    if (outcome === 'completed' && !isVerified(session, { requireApproval: this.config?.requireShortlistApproval })) {
      session.finish(TERMINAL.UNKNOWN_CALLER);
      return { ended: true };
    }
    session.finish(outcome ?? TERMINAL.COMPLETED);
    return { ended: true };
  }

  async #ensureInterviewCall(session) {
    if (session.interviewCallId) return;
    const call = await recordInterviewCall({
      candidateId: session.candidate.id,
      callerNumber: session.callerNumber,
      recognised: true,
      status: 'unknown_caller',
    });
    session.interviewCallId = call.id;
  }

  async #patch(session, body) {
    if (!session.interviewCallId) return;
    await updateInterviewCall(session.interviewCallId, body)
      .catch(err => this.logger.warn({ err: err.message }, 'call patch failed'));
  }
}
