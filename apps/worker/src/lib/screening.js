import { Anthropic } from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { STATES, TERMINAL } from './states.js';
import { samplingFor, thinkingFor } from './sampling.js';
import { splitSentences, takeSentences } from '../utils/speech.js';
import { cvList } from './cv.js';

// Turns kept per call. A screening runs six to ten questions, and a candidate
// may refer back to something they said early on, so the window has to hold the
// whole conversation rather than a sliding tail of it.
const MAX_HISTORY = 40;

// Tools the model may chain within one caller turn before we stop and escalate.
const MAX_TOOL_CHAIN = 4;

// A spoken goodbye, in the languages Pratibha screens in.
//
// The model reliably says farewell and unreliably calls end_call - it treats
// the closing line as the end of its job and stops, which leaves the session
// open with nothing to hang up the phone. Matching the farewell is a backstop
// for the tool, not a replacement: end_call remains the intended path, and this
// only fires in CANDIDATE_QA, where the only thing left to do is stop.
const CLOSING_REMARK = /(have a (good|great|nice) (day|evening|one)|thank you for your time|thanks for your time|that(’s|'s| is) all (for now|from my side)|that(’s|'s| is) everything from my side|good ?bye|take care|dhanyavaad|dhanyawad|shukriya|alvida)/i;

/**
 * How hard the questions should be.
 *
 * Length and depth used to be fixed in this prompt — the same "six to ten
 * questions" for a fresher QA role and a staff engineer. Difficulty is a
 * per-job setting now, and this turns it into instructions a model can act on
 * rather than an adjective it has to interpret.
 */
const DIFFICULTY_GUIDANCE = {
  easy:
    'Keep questions straightforward and confidence-building. Ask what they have done, not how they would redesign it. ' +
    'Accept a good-enough answer and move on; do not push for depth they have not claimed.',
  moderate:
    'Ask about real work on their CV and follow up once for specifics — numbers, tools, their own part in it. ' +
    'Push back gently on vague answers, but do not interrogate.',
  hard:
    'Probe for depth. For each significant claim, ask how it was done and what the trade-offs were. ' +
    'Follow up twice where an answer stays abstract, and ask about failures and what they changed afterwards.',
  expert:
    'Interview at senior-hire depth. Expect precise reasoning about trade-offs, scale and failure modes. ' +
    'Challenge claims that do not hold together, and ask what they would do differently with hindsight. ' +
    'Stay courteous: rigorous is not hostile.',
};

/** Per-job interview settings, with the defaults used when none are set. */
function interviewSettings(session) {
  const p = session.interviewProtocol ?? {};
  const minQuestions = Number(p.minQuestions) || 6;
  const maxQuestions = Math.max(Number(p.maxQuestions) || 10, minQuestions);
  return {
    minQuestions,
    maxQuestions,
    durationMinutes: Number(p.durationMinutes) || 10,
    difficulty: DIFFICULTY_GUIDANCE[p.difficulty] ? p.difficulty : 'moderate',
    focusAreas: Array.isArray(p.focusAreas) ? p.focusAreas.filter(Boolean) : [],
  };
}


// 8.1 - fixed, spoken before the model has any control over the call, so 3.2
// cannot be talked out of. Never generated. Personalised when the caller is
// already recognised; this generic form is the fallback for unknown callers.
export const DISCLOSURE =
  "Hello, thanks for calling. My name is Pratibha, and I'm an AI hiring assistant — not a human. " +
  "I'm here to run first-round conversations with shortlisted candidates. " +
  "This call may be recorded for review.";

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

  if (session?.tenant?.name && session?.job?.title && named) {
    return `Hello ${session.candidate.name}, thanks for calling ${session.tenant.name}. ` +
      `My name is Pratibha, and I'm an AI hiring assistant — not a human. ` +
      `I'm here to run the first-round conversation for the ${session.job.title} role. ` +
      `This call may be recorded for review.`;
  }

  if (session?.tenant?.name) {
    return `Hello, thanks for calling ${session.tenant.name}. ` +
      `My name is Pratibha, and I'm an AI hiring assistant — not a human. ` +
      `I'm here to run first-round conversations with shortlisted candidates. ` +
      `This call may be recorded for review.`;
  }

  return DISCLOSURE;
}

/**
 * What each stage actually needs from the model. The state machine decides
 * which tools exist; this says what to do with the turn. Without it the model
 * infers the stage from tool names alone and tends to restart the conversation
 * from the top.
 */
const STAGE_GUIDANCE = {
  [STATES.IDENTIFY]: 'Their number is not on the shortlist. Ask which email address they applied with, then pass exactly what they say to provide_email.',
  [STATES.VERIFY_EMAIL]:
    'A greeting has been spoken and you are confirming who the caller is. Ask which email address they applied with, then pass exactly what they say to confirm_email. ' +
    'You have not been told their name and must not use one, or ask them to confirm a name. Never read the address on file aloud, never spell any part of it, and never hint at it - they must produce it. Ask once, warmly, in one sentence.',
  [STATES.LANGUAGE_SELECT]: 'Ask which language they would like: English, Hindi, or Hinglish. Then call select_language.',
  [STATES.CONSENT_TIME]: 'Ask whether now is a good time and say the call takes about ten to fifteen minutes.',
  [STATES.CONSENT_RECORDING]: 'Ask for permission to record before any interview question.',
  [STATES.CANDIDATE_QA]: 'Invite any questions they have about the role or the process.'
};

const BASE_PROMPT = `You are Pratibha, an AI hiring assistant for {{tenantName}}.
You run first-round screening conversations with candidates who call you. You never call anyone.

HOW YOU SPEAK
- Everything you write is spoken aloud down a phone line. Plain spoken sentences only: no markdown, no bullet points, no headings, no emoji.
- Warm, professional, concise. One or two sentences per turn. This is a conversation, not a form.
- Ask one question at a time and let them finish answering.
- Numbers, codes and dates should be written the way you would say them aloud.
{{languageHint}}

THE CALL HAS ALREADY OPENED
- A fixed greeting has ALREADY been spoken to this caller before your first turn. It gave your name, said you are an AI and not a human, named the company and the role, and said the call may be recorded. They have heard all of it.
- Therefore: never greet them again, never introduce yourself again, and never restate the company or the role as though it were news. No "Hello", no "Hi", no "This is Pratibha from...", no "I am the AI hiring assistant" - not on your first turn, and not on any later turn.
- Your first turn continues the conversation from where the greeting left off. Go straight to what that stage of the call needs, in one or two sentences.

WHAT YOU MUST NEVER DO
- Never state or imply a salary figure, a joining date, a start date, or that an offer will follow.
- Never say whether the candidate has passed, done well, or done badly. You do not decide anything.
- Never evaluate an answer out loud, even favourably. "That's a solid improvement", "good answer", "that's impressive" are all forbidden. Acknowledge with something neutral - "got it", "thanks", "understood" - and move on.
- Never tell a candidate they misunderstood you, did not answer, or answered the wrong question. Never correct them.
- Ask any given question at most twice. If their second answer still does not address it, let it go, move to a different criterion, and record it as not covered when you finish. Three attempts at the same question is an interrogation, not a screening, and it is the fastest way to lose a good candidate.
- If an answer wanders onto another topic, take what they gave you and move forward from there rather than steering them back.
- Never discuss other candidates, how many people applied, or internal timelines.
- Never promise that anyone will call them, and never imply you are transferring them to a person. You cannot transfer a call and nobody will phone them. Every follow-up happens by email.
- If a tool result contains a "say_exactly" field, say exactly those words and add nothing to them, before or after. They are worded that way deliberately.
- If you are asked something you do not know, say the team will follow up rather than guessing.
- Never ask about, or take into account, their age, gender, marital status, religion, caste, region, or which college they attended.

IF THINGS GO WRONG
- They ask for a human: agree immediately and warmly, then escalate. Never deflect or try to talk them out of it.
- They become hostile or distressed: close politely and escalate. Do not argue.
- The line is too poor to continue: ask them to repeat once, then tell them to call back on a better connection.
- You suspect you are not speaking to the candidate: confirm one detail from their CV, such as their current employer. If it does not match, close politely and escalate.`;

export class ScreeningAgent {
  constructor(config, logger, toolExecutor) {
    this.config = config;
    this.logger = logger;
    this.tools = toolExecutor;
    this.anthropic = new Anthropic({
      apiKey: config.anthropic.apiKey,
      // Unbounded by default (10 minutes, 2 retries). On a phone call that is
      // indistinguishable from a hang: the turn lock stays held, every further
      // utterance queues behind it, and the line just goes dead.
      timeout: config.anthropic.timeoutMs ?? 12_000,
      maxRetries: config.anthropic.maxRetries ?? 1,
      ...(config.anthropic.baseUrl ? { baseURL: config.anthropic.baseUrl } : {})
    });
  }

  buildSystemPrompt(session) {
    const settings = interviewSettings(session);
    // A per-job company name overrides the tenant's, so one workspace can hire
    // under more than one brand.
    const tenantName =
      session.interviewProtocol?.companyName ?? session.tenant?.name ?? 'the hiring team';
    const languageHint = session.language && session.language !== 'en'
      ? `- Conduct this conversation in ${session.language === 'hi' ? 'Hindi' : 'Hinglish (Hindi words in Roman script, mixed with English)'}.`
      : '- Conduct this conversation in English (Indian). Use simple words because the line is noisy.';

    const parts = [BASE_PROMPT.replace(/\{\{tenantName\}\}/g, tenantName).replace(/\{\{languageHint\}\}/g, languageHint)];

    // Admin-defined protocols override instincts.
    if (session.interviewProtocol?.instructionText) {
      parts.push('PROTOCOLS SET BY THE HIRING TEAM. These override your other instincts.\n' +
        session.interviewProtocol.instructionText);
    }

    // Until the caller proves who they are, the model is not told who we think
    // they are. It cannot leak a name, an employer or a CV detail it was never
    // given, and a model instructed to keep a secret it can see will eventually
    // say it out loud.
    if (session.candidate && session.job && !identityConfirmed(session)) {
      parts.push(`WHO YOU ARE SPEAKING TO
Not yet established. Their number matches someone on the shortlist, but that only identifies the phone, not the person holding it.
You do NOT know their name, employer, or anything on their CV, and you must not guess or imply any of it. Do not use a name at all this turn.
Applying for: ${session.job.title}`);
    }

    if (session.candidate && session.job && identityConfirmed(session)) {
      const cv = session.candidate.cvParsed ?? {};
      parts.push(`WHO YOU ARE SPEAKING TO
Name: ${session.candidate.name ?? 'unknown'}
Applying for: ${session.job.title}
Their CV says: ${cv.rawPreview ?? JSON.stringify(cv)}
Experience: ${cv.experience ?? 'not stated'}
Skills: ${cvList(cv.skills).join(', ') || 'not extracted'}
Education: ${cvList(cv.education).join('; ') || 'not extracted'}`);
    }

    if (session.criteria?.length) {
      parts.push(`WHAT YOU ARE SCREENING FOR
${session.criteria.map(c => `- [id ${c.id}] ${c.criterion} (weight ${c.weight}/5). ${c.evaluation_guidance ?? ''}`).join('\n')}

Cover every one of these at least once. Where you cannot, record why when you finish.
Probe what is actually on their CV rather than asking generic questions.
${settings.focusAreas.length ? `Give extra weight to these areas: ${settings.focusAreas.join(', ')}.\n` : ''}DEPTH FOR THIS ROLE (${settings.difficulty}): ${DIFFICULTY_GUIDANCE[settings.difficulty]}
Aim for ${settings.minQuestions} to ${settings.maxQuestions} questions inside about ${settings.durationMinutes} minutes.
You are gathering evidence, not marking it. The scoring happens after the call, by a separate process, against the criteria above.`);
    }

    const remaining = session.deadlineAt
      ? Math.max(0, Math.round((session.deadlineAt - Date.now()) / 60000))
      : null;

    const progress = session.state === STATES.SCREEN
      ? `\nYou have asked ${session.questionsAsked} question${session.questionsAsked === 1 ? '' : 's'} of a planned ${settings.minQuestions}-${settings.maxQuestions}.` +
        (remaining !== null ? ` About ${remaining} minute${remaining === 1 ? '' : 's'} of the interview remain.` : '') +
        (session.questionsAsked >= settings.maxQuestions || remaining === 0
          ? ' Wrap up now and call finish_screening.'
          : '')
      : '';

    const stage = STAGE_GUIDANCE[session.state];
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
      max_tokens: 600,
      ...samplingFor(this.config.anthropic.model, 0.3),
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
      if (session.state === STATES.SCREEN) session.questionsAsked++;
    }

    const toolUse = response.content.find(c => c.type === 'tool_use') ?? null;

    if (toolUse) {
      const ran = await this.executeTool(session, toolUse);
      if (!ran) return;

      if (session.ended) {
        if (!spoke && depth + 1 < MAX_TOOL_CHAIN) {
          await this.runTurn(session, speak, { depth: depth + 1, spokenSoFar: spoke || spokenSoFar, signal });
        }
        return;
      }

      if (depth + 1 < MAX_TOOL_CHAIN) {
        await this.runTurn(session, speak, { depth: depth + 1, spokenSoFar: spoke || spokenSoFar, signal });
        return;
      }

      session.transcript?.record('model.error', { source: 'tool_chain', depth, limit: MAX_TOOL_CHAIN });
      this.logger.warn({ sessionId: session.id, depth }, 'Tool chain limit reached');
      await speak("I'm sorry, something has gone wrong on my end. I'll flag this for the team and they'll be in touch by email.");
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
        response.stop_reason === 'end_turn' && CLOSING_REMARK.test(reply)) {
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
      await speak("Sorry, I didn't quite catch that. Could you say it again?");
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
    const window = session.history.slice(-MAX_HISTORY);

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
