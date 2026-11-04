import { v4 as uuidv4 } from 'uuid';
import { setting, settingText } from '@pratibha/shared/settings-runtime';
import { STATES, TERMINAL } from './states.js';
import { samplingFor, thinkingFor } from './sampling.js';
import { splitSentences, takeSentences } from '../utils/speech.js';
import { cvList } from './cv.js';
import { assembleInterviewPrompt, interviewOptionsFrom } from '@pratibha/shared';
import { liveAnthropicClient } from './anthropicClient.js';
import { aiStep, interviewMinutes, languagesSpoken } from './toolExecutor.js';

// Turns kept per call (calls.max_history_turns, 40 by default). A screening
// runs six to ten questions, and a candidate may refer back to something they
// said early on, so the window has to hold the whole conversation rather than a
// sliding tail of it.
//
// How many tools the model may chain within one caller turn before we stop and
// escalate is calls.max_tool_chain (4 by default). Both are read per turn, not
// held in constants, so a change in the admin panel needs no restart.

// A spoken goodbye, in the languages Pratibha screens in.
//
// The model reliably says farewell and unreliably calls end_call - it treats
// the closing line as the end of its job and stops, which leaves the session
// open with nothing to hang up the phone. Matching the farewell is a backstop
// for the tool, not a replacement: end_call remains the intended path, and this
// only fires in CANDIDATE_QA, where the only thing left to do is stop.
//
// The phrases are calls.closing_phrases, editable in the admin panel.

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * A matcher for a list of goodbye phrases, as an admin types them: any case,
 * any run of spaces, and "that's" also matching "that’s" or "that is", since
 * the model writes all three.
 */
export function closingMatcher(phrases) {
  const parts = (phrases ?? [])
    .map(p => String(p).trim())
    .filter(Boolean)
    .map(p => p
      .split(/\s+/)
      .map(word => word
        .replace(REGEX_SPECIAL, '\\$&')
        .replace(/['’](s\b)?/g, (_, contraction) => (contraction ? "(?:['’]s|\\s+is)" : "['’]")))
      .join('\\s+'));
  return parts.length ? new RegExp(`(${parts.join('|')})`, 'i') : null;
}

/** Whether `reply` is a spoken goodbye, by the phrases in force right now. */
export function isClosingRemark(reply) {
  return closingMatcher(setting('calls.closing_phrases'))?.test(reply) ?? false;
}

/** Per-job interview settings, with the defaults used when none are set. */
function interviewSettings(session) {
  return interviewOptionsFrom(session.interviewProtocol);
}

/** The name she gives on calls: the job's Identity setting, else the platform's. */
export function agentNameFor(session) {
  const name = session?.interviewProtocol?.agentName;
  return typeof name === 'string' && name.trim() ? name.trim() : settingText('scripts.agent_name', 'Pratibha').trim();
}


// 8.1 - fixed, spoken before the model has any control over the call, so 3.2
// cannot be talked out of. Never generated. Personalised when the caller is
// already recognised; this generic form is the fallback for unknown callers.
// The wording is scripts.disclosure; this constant is the built-in text, used
// whenever that is empty, so the disclosure can never be blanked out.
export const DISCLOSURE =
  "Hello, thanks for calling. My name is Pratibha, and I'm an AI hiring assistant — not a human. " +
  "I'm here to run first-round conversations with shortlisted candidates. " +
  "This call may be recorded for review.";

/** The generic disclosure as configured now (scripts.disclosure). */
export function disclosureText() {
  return settingText('scripts.disclosure', DISCLOSURE);
}

/**
 * Identity is confirmed when the caller has passed the email check, or when
 * that check is switched off and the phone number is trusted on its own.
 */
export function identityConfirmed(session) {
  return session?.emailVerified === true || session?.state !== STATES.VERIFY_EMAIL;
}

/**
 * The opening line. Mandatory content (AI disclosure, recording notice) is
 * always spoken; the candidate's NAME is not.
 *
 * Greeting an unverified caller by name hands their identity to whoever is
 * holding the phone — and it makes the email check that follows nearly
 * pointless, since the hard part has already been given away. So the name is
 * withheld until the caller has produced their own email address.
 */
export function makeDisclosure(session, { personalise = true } = {}) {
  const named = personalise && session?.candidate?.name;
  const agent = agentNameFor(session);

  if (session?.tenant?.name && session?.job?.title && named) {
    return `Hello ${session.candidate.name}, thanks for calling ${session.tenant.name}. ` +
      `My name is ${agent}, and I'm an AI hiring assistant — not a human. ` +
      `I'm here to run the first-round conversation for the ${session.job.title} role. ` +
      `This call may be recorded for review.`;
  }

  if (session?.tenant?.name) {
    return `Hello, thanks for calling ${session.tenant.name}. ` +
      `My name is ${agent}, and I'm an AI hiring assistant — not a human. ` +
      `I'm here to run first-round conversations with shortlisted candidates. ` +
      `This call may be recorded for review.`;
  }

  return disclosureText();
}

/**
 * What each stage actually needs from the model. The state machine decides
 * which tools exist; this says what to do with the turn. Without it the model
 * infers the stage from tool names alone and tends to restart the conversation
 * from the top.
 *
 * The wording is the ai_steps.stage.* settings, read per turn. CONSENT_TIME
 * states this call's real interview length ({minutes}) rather than a fixed
 * "ten to fifteen minutes", which was wrong for any job not that long.
 */
const STAGE_GUIDANCE = {
  [STATES.IDENTIFY]: 'ai_steps.stage.identify',
  [STATES.VERIFY_EMAIL]: 'ai_steps.stage.verify_email',
  [STATES.LANGUAGE_SELECT]: 'ai_steps.stage.language_select',
  [STATES.CONSENT_TIME]: 'ai_steps.stage.consent_time',
  [STATES.CONSENT_RECORDING]: 'ai_steps.stage.consent_recording',
  [STATES.CANDIDATE_QA]: 'ai_steps.stage.candidate_qa'
};

/** The WHAT THIS TURN IS FOR guidance for the call's current stage, or null. */
export function stageGuidance(session) {
  // With candidate questions switched off, the last stage only closes.
  if (session.state === STATES.CANDIDATE_QA && !interviewSettings(session).candidateQuestions) {
    return aiStep('ai_steps.stage.close_only');
  }
  const key = STAGE_GUIDANCE[session.state];
  return key
    ? aiStep(key, { languages: languagesSpoken(), minutes: interviewMinutes(session) })
    : null;
}

const LANGUAGE_HINTS = {
  en: 'ai_steps.stage.language_hint_en',
  hi: 'ai_steps.stage.language_hint_hi',
  hinglish: 'ai_steps.stage.language_hint_hinglish'
};

/** The interviewer prompt's language line for the chosen language (English until one is). */
export function languageHintFor(language) {
  // Anything other than Hindi was conducted in Hinglish before; kept.
  const key = !language || language === 'en' ? LANGUAGE_HINTS.en : (LANGUAGE_HINTS[language] ?? LANGUAGE_HINTS.hinglish);
  return `- ${aiStep(key)}`;
}

export class ScreeningAgent {
  constructor(config, logger, toolExecutor) {
    this.config = config;
    this.logger = logger;
    this.tools = toolExecutor;
    // Bounded: unbounded by default (10 minutes, 2 retries). On a phone call
    // that is indistinguishable from a hang: the turn lock stays held, every
    // further utterance queues behind it, and the line just goes dead.
    this.liveClient = liveAnthropicClient(config, { bounded: true });
    this.clientOverride = null;
  }

  /** Rebuilt when the key, endpoint or timeout changes; tests may replace it. */
  get anthropic() {
    return this.clientOverride ?? this.liveClient();
  }

  set anthropic(client) {
    this.clientOverride = client;
  }

  /**
   * The system prompt, assembled from the active block library (I10): the
   * fixed core, who the caller is, then one block per enabled option, then the
   * hiring team's own words, and finally where the call has got to. The names
   * of the blocks used are logged once per call, which is the preview of what
   * a settings change actually did.
   */
  buildSystemPrompt(session) {
    const settings = interviewSettings(session);
    // Tests without a database get the shipped library via their setup file.
    const library = session.promptBlocks ?? globalThis.__PRATIBHA_TEST_PROMPT_BLOCKS__;
    if (!library?.blocks) throw new Error('No active interviewer prompt block library');

    // A per-job company name overrides the tenant's, so one workspace can hire
    // under more than one brand.
    const tenantName =
      session.interviewProtocol?.companyName ?? session.tenant?.name ?? 'the hiring team';
    const languageHint = languageHintFor(session.language);

    const afterCore = [];
    const verified = session.candidate && session.job && identityConfirmed(session);

    // Until the caller proves who they are, the model is not told who we think
    // they are. It cannot leak a name, an employer or a CV detail it was never
    // given, and a model instructed to keep a secret it can see will eventually
    // say it out loud.
    if (session.candidate && session.job && !identityConfirmed(session)) {
      afterCore.push(`WHO YOU ARE SPEAKING TO
${aiStep('ai_steps.stage.unverified_caller')}
Applying for: ${session.job.title}`);
    }

    if (verified) {
      const cv = session.candidate.cvParsed ?? {};
      afterCore.push(`WHO YOU ARE SPEAKING TO
Name: ${session.candidate.name ?? 'unknown'}
Applying for: ${session.job.title}
Their CV says: ${cv.rawPreview ?? JSON.stringify(cv)}
Experience: ${cv.experience ?? 'not stated'}
Skills: ${cvList(cv.skills).join(', ') || 'not extracted'}
Education: ${cvList(cv.education).join('; ') || 'not extracted'}`);
    }

    // Interview content (role, questions, screeners, salary) only once the
    // caller is verified; before that the core alone governs the call.
    const options = verified
      ? settings
      : { ...settings, introduceRole: false, customQuestions: [], screeners: {}, candidateQuestions: false, hearBackDays: null };

    const { text, used } = assembleInterviewPrompt(library, options, {
      agentName: agentNameFor(session),
      tenantName,
      languageHint,
      jdSummary: verified ? (session.latestApprovedJd?.bodyMd ?? null) : null,
      criteriaList: verified && session.criteria?.length
        ? session.criteria.map(c => `- [id ${c.id}] ${c.criterion} (weight ${c.weight}/${setting('screening.must_have_weight')}). ${c.evaluation_guidance ?? ''}`).join('\n')
        : '',
      gaps: verified ? (session.screeningGaps ?? []) : [],
      jobLocation: session.job?.location ?? null,
      bandMin: session.job?.salaryMin ?? null,
      bandMax: session.job?.salaryMax ?? null,
      afterCore,
    });

    const signature = `${library.version}:${used.join(',')}`;
    if (session.promptSignature !== signature) {
      session.promptSignature = signature;
      session.transcript?.record('prompt.assembled', { libraryVersion: library.version, blocks: used.join(',') });
    }

    const parts = [text];

    const remaining = session.deadlineAt
      ? Math.max(0, Math.round((session.deadlineAt - Date.now()) / 60000))
      : null;

    const progress = session.state === STATES.SCREEN
      ? `\nYou have asked ${session.questionsAsked} question${session.questionsAsked === 1 ? '' : 's'} of a planned ${settings.minQuestions}-${settings.maxQuestions}.` +
        (remaining !== null ? ` About ${remaining} minute${remaining === 1 ? '' : 's'} of the interview remain.` : '') +
        (session.questionsAsked >= settings.maxQuestions || remaining === 0
          ? ` ${aiStep('ai_steps.stage.screen_wrap_up')}`
          : '')
      : '';

    const stage = stageGuidance(session);
    if (stage) parts.push(`WHAT THIS TURN IS FOR\n${stage}`);

    parts.push(`CURRENT STAGE OF THE CALL: ${session.state}${progress}
TOOLS AVAILABLE TO YOU RIGHT NOW: ${this.tools.definitionsFor(session.state).map(t => t.name).join(', ') || 'none - just speak'}`);

    return parts.join('\n\n');
  }

  /**
   * One model turn, streamed.
   *
   * The reply is not waited for as a whole. Each sentence goes to `speak` the
   * instant the model finishes writing it, so synthesis and playback overlap
   * the rest of the generation - the candidate hears the opening line while the
   * model is still deciding how the answer ends. Waiting for the complete
   * response first put the entire generation time into dead air on every turn.
   *
   * `speak` queues internally, so handing a sentence over never blocks reading
   * the next token off the wire.
   */
  async runTurn(session, speak, { depth = 0, spokenSoFar = false, signal } = {}) {
    const state = session.state;
    const tools = this.tools.definitionsFor(state);

    session.transcript?.record('model.request', {
      state, depth, tools: tools.map(t => t.name).join(',') || 'none', historyTurns: session.history.length
    });

    const started = Date.now();
    let firstTokenAt = null;
    let buffer = '';
    const speaking = [];

    // `final` also releases the tail, which by definition has no terminator
    // after it - the model stopped writing rather than ended a sentence.
    const release = (final) => {
      const { sentences, rest } = takeSentences(buffer);
      buffer = rest;
      const out = [...sentences];
      if (final && buffer.trim()) {
        out.push(...splitSentences(buffer));
        buffer = '';
      }
      for (const sentence of out) speaking.push(speak(sentence));
    };

    const stream = this.anthropic.messages.stream({
      model: this.config.anthropic.model,
      max_tokens: setting('ai.call_max_tokens'),
      ...samplingFor(this.config.anthropic.model, setting('ai.call_temperature')),
      ...thinkingFor(this.config.anthropic.model),
      system: this.buildSystemPrompt(session),
      messages: this.buildMessages(session),
      ...(tools.length ? { tools } : {}),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true }
    }, signal ? { signal } : undefined);

    for await (const event of stream) {
      if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') continue;
      if (firstTokenAt === null) {
        firstTokenAt = Date.now();
        // The only figure that says whether the model is the thing keeping the
        // candidate waiting, as opposed to synthesis or the network.
        session.transcript?.record('model.first_token', { latencyMs: firstTokenAt - started });
      }
      buffer += event.delta.text;
      release(false);
    }

    // Tool calls, usage and stop_reason come off the assembled message; only
    // the text needed to be read early.
    const response = await stream.finalMessage();
    release(true);

    // Whatever is still playing has to finish before the turn moves on, or a
    // tool result lands while she is mid-sentence.
    const said = (await Promise.all(speaking)).filter(Boolean);
    const reply = said.join(' ').trim();

    const usage = response.usage ?? {};
    if (usage.input_tokens) session.llmInputTokens += usage.input_tokens;
    if (usage.output_tokens) session.llmOutputTokens += usage.output_tokens;

    session.transcript?.record('model.response', {
      latencyMs: Date.now() - started,
      firstTokenMs: firstTokenAt ? firstTokenAt - started : null,
      blocks: response.content.map(c => c.type).join(',') || 'empty',
      stopReason: response.stop_reason,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });

    // One history entry and one question for the whole reply, however many
    // sentences it was streamed as. Counting per sentence would have a single
    // five-sentence question read as five questions asked, and end the
    // interview a third of the way in.
    let spoke = false;
    if (reply) {
      session.history.push({ role: 'assistant', content: reply });
      spoke = true;
      if (session.state === STATES.SCREEN) {
        session.questionsAsked++;
        // The billing clock starts here, on the first question actually asked.
        if (!session.firstQuestionAt) {
          session.firstQuestionAt = new Date();
          session.transcript?.record('interview.billing_start', {
            questionsAsked: session.questionsAsked,
          });
        }
      }
    }

    const toolUse = response.content.find(c => c.type === 'tool_use') ?? null;
    const maxToolChain = setting('calls.max_tool_chain');

    if (toolUse) {
      const ran = await this.executeTool(session, toolUse);
      if (!ran) return;

      if (session.ended) {
        if (!spoke && depth + 1 < maxToolChain) {
          await this.runTurn(session, speak, { depth: depth + 1, spokenSoFar: spoke || spokenSoFar, signal });
        }
        return;
      }

      if (depth + 1 < maxToolChain) {
        await this.runTurn(session, speak, { depth: depth + 1, spokenSoFar: spoke || spokenSoFar, signal });
        return;
      }

      session.transcript?.record('model.error', { source: 'tool_chain', depth, limit: maxToolChain });
      this.logger.warn({ sessionId: session.id, depth }, 'Tool chain limit reached');
      await speak(settingText('scripts.something_wrong', "I'm sorry, something has gone wrong on my end. I'll flag this for the team and they'll be in touch by email."));
      await this.forceEscalate(session, 'other', 'tool chain limit reached');
      return;
    }

    // She said goodbye without calling end_call. Nothing else will hang up the
    // phone, so the candidate sits listening to silence until they give up, and
    // the interview is then recorded as abandoned - unbilled, reported as a
    // failed call. Ending here is safe because CANDIDATE_QA is only reached
    // after finish_screening: the questions are already done, so the worst case
    // is ending a beat early rather than cutting the screening short.
    if (!toolUse && spoke && session.state === STATES.CANDIDATE_QA &&
        response.stop_reason === 'end_turn' && isClosingRemark(reply)) {
      session.transcript?.record('interview.auto_close', {
        reason: 'farewell_without_end_call',
        questionsAsked: session.questionsAsked,
      });
      this.logger.info(
        { sessionId: session.id, questions: session.questionsAsked },
        'Closing the call on a spoken farewell'
      );
      session.finish(TERMINAL.COMPLETED);
      return;
    }

    // Never after a barge-in: the candidate cut her off deliberately, and
    // answering that with "sorry, I did not catch that" is worse than silence.
    if (!spoke && !spokenSoFar && !session.ended && !signal?.aborted) {
      session.transcript?.record('model.silent', { state, stopReason: response.stop_reason });
      this.logger.warn({ sessionId: session.id, state }, 'Model returned nothing to say');
      await speak(settingText('scripts.did_not_catch', "Sorry, I didn't quite catch that. Could you say it again?"));
    }
  }

  async executeTool(session, toolUse) {
    const startTime = Date.now();
    const stateBefore = session.state;
    session.transcript?.record('tool.call', {
      tool: toolUse.name, input: JSON.stringify(toolUse.input), state: stateBefore
    });

    let result;
    try {
      result = await this.tools.execute(toolUse.name, toolUse.input, session);
    } catch (err) {
      session.transcript?.record('tool.error', {
        tool: toolUse.name, error: err.message, latencyMs: Date.now() - startTime
      });
      this.logger.error({ sessionId: session.id, tool: toolUse.name, err }, 'Tool execution failed');

      if (toolUse.name === 'escalate') {
        session.finish(TERMINAL.TECHNICAL_FAILURE);
        return false;
      }
      await this.forceEscalate(session, 'other', `${toolUse.name} failed: ${err.message}`);
      return false;
    }

    session.transcript?.record('tool.result', {
      tool: toolUse.name, latencyMs: Date.now() - startTime, result: JSON.stringify(result).slice(0, 600)
    });
    if (session.state !== stateBefore) {
      session.transcript?.record('state', { from: stateBefore, to: session.state });
    }

    session.history.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input }]
    });
    session.history.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }]
    });

    return true;
  }

  async forceEscalate(session, category, reason) {
    if (session.ended) return;
    session.transcript?.record('escalate', { category, reason });
    await this.tools.execute('escalate', { category, reason }, session)
      .catch(() => session.finish(TERMINAL.TECHNICAL_FAILURE));
    session.finish(TERMINAL.ESCALATED);
  }

  buildMessages(session) {
    const window = session.history.slice(-setting('calls.max_history_turns'));

    const toolUseIds = new Set(
      window.flatMap(m => (Array.isArray(m.content) ? m.content : []))
        .filter(block => block.type === 'tool_use')
        .map(block => block.id)
    );
    const pruned = window.filter(m => !(Array.isArray(m.content) && m.content.some(
      block => block.type === 'tool_result' && !toolUseIds.has(block.tool_use_id)
    )));

    const start = pruned.findIndex(m => m.role === 'user' && !Array.isArray(m.content));
    const messages = start === -1 ? [] : pruned.slice(start);

    if (messages.length === 0) {
      return [{ role: 'user', content: '(The candidate is on the line.)' }];
    }
    return messages.map(m => ({ role: m.role, content: m.content }));
  }
}

export { uuidv4 };
