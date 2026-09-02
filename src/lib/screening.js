import { Anthropic } from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { STATES, TERMINAL } from './states.js';
import { samplingFor } from './sampling.js';

// Turns kept per call. A screening runs six to ten questions, and a candidate
// may refer back to something they said early on, so the window has to hold the
// whole conversation rather than a sliding tail of it.
const MAX_HISTORY = 40;

// Tools the model may chain within one caller turn before we stop and escalate.
const MAX_TOOL_CHAIN = 4;

// 8.1 - fixed, spoken before the model has any control over the call, so 3.2
// cannot be talked out of. Never generated.
export const DISCLOSURE =
  "Hello, thanks for calling ProMonkey Technologies. My name is Pratibha, and I'm an AI hiring assistant — not a human. " +
  "I'm here to run first-round conversations with shortlisted candidates. " +
  "Could you tell me the reference code from your invitation email?";

const BASE_PROMPT = `You are Pratibha, an AI hiring assistant for ProMonkey Technologies.
You run first-round screening conversations with candidates who call you. You never call anyone.

HOW YOU SPEAK
- Everything you write is spoken aloud down a phone line. Plain spoken sentences only: no markdown, no bullet points, no headings, no emoji.
- Warm, professional, concise. One or two sentences per turn. This is a conversation, not a form.
- Ask one question at a time and let them finish answering.
- Numbers, codes and dates should be written the way you would say them aloud.

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
- The line is too poor to continue: ask them to repeat once, then tell them to call back on a better connection using the same code.
- You suspect you are not speaking to the candidate: confirm one detail from their CV, such as their current employer. If it does not match, close politely and escalate.`;

export class ScreeningAgent {
  constructor(config, logger, toolExecutor) {
    this.config = config;
    this.logger = logger;
    this.tools = toolExecutor;
    this.anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  buildSystemPrompt(session) {
    const parts = [BASE_PROMPT];

    // 6.7 - admin-defined protocols, loaded on every call. Global first, then
    // job-specific, which extend or override.
    const protocols = session.protocols ?? [];
    if (protocols.length) {
      parts.push('PROTOCOLS SET BY THE HIRING TEAM. These override your other instincts.\n' +
        protocols.map(p => `[${p.scope}] ${p.title}\n${p.content}`).join('\n\n'));
    }

    if (session.candidate && session.job) {
      parts.push(`WHO YOU ARE SPEAKING TO
Name: ${session.candidate.first_name}
Applying for: ${session.job.title}
Their CV says: ${session.candidate.cv_summary}
Current role: ${session.candidate.current_designation} at ${session.candidate.current_employer}, ${session.candidate.total_experience_years} years total experience.
Notice period: ${session.candidate.notice_period}

THE ROLE
${session.job.jd_summary}`);
    }

    if (session.criteria?.length) {
      parts.push(`WHAT YOU ARE SCREENING FOR
${session.criteria.map(c => `- [id ${c.id}] ${c.criterion} (weight ${c.weight}/5). ${c.evaluation_guidance ?? ''}`).join('\n')}

Cover every one of these at least once. Where you cannot, record why when you finish.
Probe what is actually on their CV rather than asking generic questions - if it claims they led a team of four, ask about that team. Start straightforward and go deeper as their answers earn it. Six to ten questions is normal.
You are gathering evidence, not marking it. The scoring happens after the call, by a separate process, against the criteria above.`);
    }

    // The model cannot see how long it has been going in circles unless it is
    // told. Without this it will re-ask a question it has already asked twice,
    // which is what 8.3's "ease off rather than grinding them down" is about.
    const progress = session.state === STATES.SCREEN
      ? `\nYou have asked ${session.questionsAsked} question${session.questionsAsked === 1 ? '' : 's'} so far. Six to ten is a complete screening. If you are past ten, wrap up and call finish_screening.`
      : '';

    parts.push(`CURRENT STAGE OF THE CALL: ${session.state}${progress}
TOOLS AVAILABLE TO YOU RIGHT NOW: ${this.tools.definitionsFor(session.state).map(t => t.name).join(', ') || 'none - just speak'}`);

    return parts.join('\n\n');
  }

  /**
   * One turn with the model: say what it wants said, run what it calls, then
   * come back so it can react to the result.
   *
   * Ported from Scout, where handling only the first tool call and stopping left
   * the caller in silence at exactly the step where a tool result determined
   * what to say next - verify_code succeeding and the next thing to do being to
   * greet them by name.
   */
  async runTurn(session, speak, depth = 0, spokenSoFar = false) {
    const state = session.state;
    const tools = this.tools.definitionsFor(state);

    session.transcript?.record('model.request', {
      state, depth, tools: tools.map(t => t.name).join(',') || 'none', historyTurns: session.history.length
    });

    const started = Date.now();
    const response = await this.anthropic.messages.create({
      model: this.config.anthropic.model,
      // A spoken reply is one or two sentences. Capping it low is deliberate:
      // it bounds the worst-case turn latency against the 800 ms budget in 4.2.
      max_tokens: 600,
      ...samplingFor(this.config.anthropic.model, 0.3),
      system: this.buildSystemPrompt(session),
      messages: this.buildMessages(session),
      // An empty tools array is not a valid request; in CLOSE the model just talks.
      ...(tools.length ? { tools } : {}),
      // A phone call is sequential and each tool moves the state machine, so a
      // parallel pair would be resolved against stale state.
      tool_choice: { type: 'auto', disable_parallel_tool_use: true }
    });

    session.transcript?.record('model.response', {
      latencyMs: Date.now() - started,
      blocks: response.content.map(c => c.type).join(',') || 'empty',
      stopReason: response.stop_reason
    });

    let spoke = false;
    let toolUse = null;

    for (const content of response.content) {
      if (content.type === 'text') {
        const said = await speak(content.text);
        if (said) {
          session.history.push({ role: 'assistant', content: said });
          spoke = true;
          if (session.state === STATES.SCREEN) session.questionsAsked++;
        }
      } else if (content.type === 'tool_use' && !toolUse) {
        toolUse = content;
      }
    }

    if (toolUse) {
      const ran = await this.executeTool(session, toolUse);
      if (!ran) return;

      if (session.ended) {
        // The tool closed the call. The model still owes the caller a closing
        // line, and the instruction it just received says what to say, so run
        // one more turn - but with no tools, so it cannot act further.
        if (!spoke && depth + 1 < MAX_TOOL_CHAIN) {
          await this.runTurn(session, speak, depth + 1, spoke || spokenSoFar);
        }
        return;
      }

      if (depth + 1 < MAX_TOOL_CHAIN) {
        await this.runTurn(session, speak, depth + 1, spoke || spokenSoFar);
        return;
      }

      session.transcript?.record('model.error', { source: 'tool_chain', depth, limit: MAX_TOOL_CHAIN });
      this.logger.warn({ sessionId: session.id, depth }, 'Tool chain limit reached');
      await speak("I'm sorry, something has gone wrong on my end. I'll flag this for the team and they'll be in touch by email.");
      await this.forceEscalate(session, 'other', 'tool chain limit reached');
      return;
    }

    // No text and no tool is dead air on a live call - but only if nothing was
    // said anywhere in this turn. Checking just this recursion level made
    // Pratibha deliver her closing line, call end_call, and then follow it with
    // "Sorry, I didn't quite catch that" - apologising for silence that was her
    // own, to a candidate who had said goodbye and was waiting to hang up.
    if (!spoke && !spokenSoFar && !session.ended) {
      session.transcript?.record('model.silent', { state, stopReason: response.stop_reason });
      this.logger.warn({ sessionId: session.id, state }, 'Model returned nothing to say');
      await speak("Sorry, I didn't quite catch that. Could you say it again?");
    }
  }

  /** Returns true when the tool ran and its result is in history. */
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

      // An escalate that itself fails must not re-enter escalation - that recurses.
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

    // Record the call and its result as a pair. Dropping them loses every fact
    // the tool returned - the candidate's name, the role, what to say next.
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

  /**
   * The Messages API requires the first message to be a `user` turn and every
   * tool_result to sit behind its tool_use. Trimming an arbitrary tail breaks
   * both, so pick a window that starts on a clean caller turn.
   */
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
